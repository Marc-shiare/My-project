import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { createSimulatedAdapters } from "../src/adapters/ports.mjs";
import { ClaimsPlatform } from "../src/application/platform.mjs";
import { FileEventStore } from "../src/infrastructure/file-event-store.mjs";
import { ProjectionStore } from "../src/infrastructure/projection-store.mjs";

const actors = {
  claimsMaker: { actorId: "claims-maker", displayName: "Claims Maker", roles: ["CLAIMS_MAKER"] },
  claimsChecker: { actorId: "claims-checker", displayName: "Claims Checker", roles: ["CLAIMS_CHECKER"] },
  financeMaker: { actorId: "finance-maker", displayName: "Finance Maker", roles: ["FINANCE_MAKER"] },
  financeChecker: { actorId: "finance-checker", displayName: "Finance Checker", roles: ["FINANCE_CHECKER"] },
  reconAnalyst: { actorId: "recon-analyst", displayName: "Recon Analyst", roles: ["RECON_ANALYST"] },
  system: { actorId: "system-bot", displayName: "System Bot", roles: ["SYSTEM"] },
};

async function createPlatform(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claims-platform-recon-"));
  const filePath = path.join(dir, "events.jsonl");
  const platform = new ClaimsPlatform({
    eventStore: new FileEventStore(filePath),
    projections: new ProjectionStore(),
    adapters: options.adapters,
  });
  await platform.init();
  return {
    platform,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function createApprovedClaim(platform, suffix) {
  const submitted = await platform.submitClaim({
    actor: actors.claimsMaker,
    commandId: `submit-${suffix}`,
    body: {
      tenantId: "demo-insurer-ke",
      policyRef: `POL-${suffix}`,
      memberRef: `MEM-${suffix}`,
      providerRef: `PROV-${suffix}`,
      incidentDate: "2026-04-01",
      amountMinor: 120000,
      currency: "KES",
      narrative: "Claim narrative",
      source: "TEST",
    },
  });
  const claimId = submitted.claim.claimId;
  await platform.validateClaim(claimId, {
    actor: actors.claimsChecker,
    commandId: `validate-${suffix}`,
    body: { outcome: "VALID", findings: ["OK"] },
  });
  await platform.adjudicateClaim(claimId, {
    actor: actors.claimsChecker,
    commandId: `adjudicate-${suffix}`,
    body: { decision: "APPROVED", approvedAmountMinor: 100000, reserveAmountMinor: 100000, reasonCodes: ["VALID"] },
  });
  return claimId;
}

async function createApprovedSettlement(platform, suffix, paymentReference, channelType = "BANK_TRANSFER") {
  const claimId = await createApprovedClaim(platform, suffix);
  await platform.proposeSettlement(claimId, {
    actor: actors.financeMaker,
    commandId: `propose-${suffix}`,
    body: {
      beneficiaryRef: `BEN-${suffix}`,
      paymentReference,
      amountMinor: 100000,
      channelType,
    },
  });
  await platform.approveSettlement(claimId, {
    actor: actors.financeChecker,
    commandId: `approve-${suffix}`,
    body: {},
  });
  return claimId;
}

test("delayed confirmations stay pending until refresh confirms and posts payout", async () => {
  const adapters = createSimulatedAdapters({
    settlementScenarios: {
      "PAY-DELAY": { mode: "delayed_confirmation", pollsUntilConfirm: 1 },
    },
  });
  const { platform, cleanup } = await createPlatform({ adapters });
  try {
    const claimId = await createApprovedSettlement(platform, "delay", "PAY-DELAY");
    await platform.initiateSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "initiate-delay",
      body: {},
    });

    let snapshot = platform.getSnapshot();
    let claim = snapshot.claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "pending_provider");
    assert.equal(snapshot.ledgerEntries.length, 1);

    await platform.refreshSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "refresh-delay-1",
      body: {},
    });
    snapshot = platform.getSnapshot();
    claim = snapshot.claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "pending_provider");
    assert.equal(snapshot.ledgerEntries.length, 1);

    await platform.refreshSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "refresh-delay-2",
      body: {},
    });
    snapshot = platform.getSnapshot();
    claim = snapshot.claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "confirmed");
    assert.equal(snapshot.ledgerEntries.length, 2);
    assert.equal(snapshot.ledgerEntries[0].entryType, "CLAIM_PAYOUT");
  } finally {
    await cleanup();
  }
});

test("duplicate statement lines open a duplicate transaction exception", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const claimId = await createApprovedSettlement(platform, "duplicate", "PAY-DUPLICATE");
    await platform.initiateSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "initiate-duplicate",
      body: {},
    });

    await platform.importReconciliationBatch({
      actor: actors.reconAnalyst,
      commandId: "import-duplicate",
      body: {
        sourceSystem: "TEST_IMPORT",
        accountRef: "ACC-1",
        statementDate: "2026-04-03",
        lines: [
          {
            externalReference: "PAY-DUPLICATE",
            narrative: "Original line",
            amountMinor: 100000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "BANK_TRANSFER",
          },
          {
            externalReference: "PAY-DUPLICATE",
            narrative: "Duplicate line",
            amountMinor: 100000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "BANK_TRANSFER",
          },
        ],
      },
    });

    const result = await platform.runSelfHealing({
      actor: actors.system,
      commandId: "heal-duplicate",
      body: { maxAgeDays: 2, asAt: "2026-04-03T12:00:00.000Z" },
    });

    assert.equal(result.summary.autoMatches, 1);
    assert.equal(result.summary.exceptionsOpened, 1);
    const duplicateException = platform
      .getSnapshot()
      .reconciliation.openExceptions.find((item) => item.exception.code === "DUPLICATE_TRANSACTION");
    assert.ok(duplicateException);
  } finally {
    await cleanup();
  }
});

test("partial payments accumulate to a full reconciliation outcome", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const claimId = await createApprovedSettlement(platform, "partial", "PAY-PARTIAL");
    await platform.initiateSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "initiate-partial",
      body: {},
    });

    await platform.importReconciliationBatch({
      actor: actors.reconAnalyst,
      commandId: "import-partial",
      body: {
        sourceSystem: "TEST_IMPORT",
        accountRef: "ACC-1",
        statementDate: "2026-04-03",
        lines: [
          {
            externalReference: "PAY-PARTIAL",
            narrative: "Partial payment 1",
            amountMinor: 40000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "BANK_TRANSFER",
          },
          {
            externalReference: "PAY-PARTIAL",
            narrative: "Partial payment 2",
            amountMinor: 60000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-04",
            channelType: "BANK_TRANSFER",
          },
        ],
      },
    });

    const result = await platform.runSelfHealing({
      actor: actors.system,
      commandId: "heal-partial",
      body: { maxAgeDays: 2, asAt: "2026-04-04T12:00:00.000Z" },
    });

    assert.equal(result.summary.partialMatches, 1);
    assert.equal(result.summary.autoMatches, 1);

    const claim = platform.getSnapshot().claims.find((item) => item.claimId === claimId);
    assert.equal(claim.status, "RECONCILED");
    assert.equal(claim.settlement.matchedAmountMinor, 100000);
    assert.equal(claim.settlement.outstandingMatchMinor, 0);
  } finally {
    await cleanup();
  }
});

test("insufficient float blocks settlement initiation without posting payout", async () => {
  const adapters = createSimulatedAdapters({
    floatBalances: {
      "BANK_TRANSFER:KES": 50000,
    },
  });
  const { platform, cleanup } = await createPlatform({ adapters });
  try {
    const claimId = await createApprovedSettlement(platform, "float", "PAY-FLOAT");
    await platform.initiateSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "initiate-float",
      body: {},
    });

    const snapshot = platform.getSnapshot();
    const claim = snapshot.claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "failed");
    assert.equal(claim.settlement.failure.failureCode, "INSUFFICIENT_FLOAT");
    assert.equal(snapshot.ledgerEntries.length, 1);
    assert.equal(snapshot.ledgerEntries[0].entryType, "CLAIM_RESERVE");
  } finally {
    await cleanup();
  }
});

test("api failure can be retried safely and later confirmed", async () => {
  const adapters = createSimulatedAdapters({
    settlementScenarios: {
      "PAY-API": { mode: "api_failure", failuresRemaining: 1 },
    },
  });
  const { platform, cleanup } = await createPlatform({ adapters });
  try {
    const claimId = await createApprovedSettlement(platform, "api", "PAY-API");
    await platform.initiateSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "initiate-api",
      body: {},
    });

    let claim = platform.getSnapshot().claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "failed");
    assert.equal(claim.settlement.failure.failureCode, "API_FAILURE");
    assert.equal(platform.getSnapshot().ledgerEntries.length, 1);

    await platform.retrySettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "retry-api",
      body: { reason: "Provider endpoint restored." },
    });

    const snapshot = platform.getSnapshot();
    claim = snapshot.claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "confirmed");
    assert.equal(claim.settlement.attemptCount, 2);
    assert.equal(snapshot.ledgerEntries.length, 2);
    assert.equal(snapshot.ledgerEntries[0].entryType, "CLAIM_PAYOUT");
  } finally {
    await cleanup();
  }
});

test("settlement reversal appends a compensating payout reversal entry", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const claimId = await createApprovedSettlement(platform, "reverse", "PAY-REVERSE");
    await platform.initiateSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "initiate-reverse",
      body: {},
    });

    await platform.reverseSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "reverse-settlement",
      body: { reason: "Provider returned funds after beneficiary account issue." },
    });

    const snapshot = platform.getSnapshot();
    const claim = snapshot.claims.find((item) => item.claimId === claimId);
    assert.equal(claim.settlement.state, "reversed");
    assert.equal(claim.reconciliation.status, "REVERSED");
    assert.equal(snapshot.ledgerEntries[0].entryType, "CLAIM_PAYOUT_REVERSAL");
    assert.equal(snapshot.ledgerEntries[1].entryType, "CLAIM_PAYOUT");
  } finally {
    await cleanup();
  }
});
