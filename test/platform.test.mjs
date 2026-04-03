import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

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

async function createPlatform() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claims-platform-"));
  const filePath = path.join(dir, "events.jsonl");
  const platform = new ClaimsPlatform({
    eventStore: new FileEventStore(filePath),
    projections: new ProjectionStore(),
  });
  await platform.init();
  return {
    platform,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function createApprovedClaim(platform, suffix = "1") {
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

test("maker-checker governance blocks finance maker from approving", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const claimId = await createApprovedClaim(platform, "maker-checker");
    await platform.proposeSettlement(claimId, {
      actor: actors.financeMaker,
      commandId: "propose-maker-checker",
      body: {
        beneficiaryRef: "BEN-1",
        paymentReference: "PAY-1",
        amountMinor: 100000,
        channelType: "BANK_TRANSFER",
      },
    });

    await assert.rejects(
      () =>
        platform.approveSettlement(claimId, {
          actor: actors.financeMaker,
          commandId: "approve-maker-checker",
          body: { approvalNote: "Not allowed" },
        }),
      /requires one of roles/i,
    );
  } finally {
    await cleanup();
  }
});

test("approved adjudication and settlement produce immutable ledger entries", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const claimId = await createApprovedClaim(platform, "ledger");
    await platform.proposeSettlement(claimId, {
      actor: actors.financeMaker,
      commandId: "propose-ledger",
      body: {
        beneficiaryRef: "BEN-LEDGER",
        paymentReference: "PAY-LEDGER",
        amountMinor: 100000,
        channelType: "BANK_TRANSFER",
      },
    });
    await platform.approveSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "approve-ledger",
      body: {},
    });
    await platform.recordSettlement(claimId, {
      actor: actors.financeChecker,
      commandId: "record-ledger",
      body: { postingRef: "POST-LEDGER" },
    });

    const snapshot = platform.getSnapshot();
    assert.equal(snapshot.ledgerEntries.length, 2);
    assert.equal(snapshot.ledgerEntries[0].entryType, "CLAIM_PAYOUT");
    assert.equal(snapshot.ledgerEntries[1].entryType, "CLAIM_RESERVE");
  } finally {
    await cleanup();
  }
});

test("self-healing auto-matches exact references and opens conservative exceptions", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const exactClaimId = await createApprovedClaim(platform, "exact");
    await platform.proposeSettlement(exactClaimId, {
      actor: actors.financeMaker,
      commandId: "propose-exact",
      body: {
        beneficiaryRef: "BEN-EXACT",
        paymentReference: "PAY-EXACT",
        amountMinor: 100000,
        channelType: "BANK_TRANSFER",
      },
    });
    await platform.approveSettlement(exactClaimId, {
      actor: actors.financeChecker,
      commandId: "approve-exact",
      body: {},
    });
    await platform.recordSettlement(exactClaimId, {
      actor: actors.financeChecker,
      commandId: "record-exact",
      body: { postingRef: "POST-EXACT" },
    });

    const mismatchClaimId = await createApprovedClaim(platform, "mismatch");
    await platform.proposeSettlement(mismatchClaimId, {
      actor: actors.financeMaker,
      commandId: "propose-mismatch",
      body: {
        beneficiaryRef: "BEN-MISMATCH",
        paymentReference: "PAY-MISMATCH",
        amountMinor: 100000,
        channelType: "BANK_TRANSFER",
      },
    });
    await platform.approveSettlement(mismatchClaimId, {
      actor: actors.financeChecker,
      commandId: "approve-mismatch",
      body: {},
    });
    await platform.recordSettlement(mismatchClaimId, {
      actor: actors.financeChecker,
      commandId: "record-mismatch",
      body: { postingRef: "POST-MISMATCH" },
    });

    await platform.importReconciliationBatch({
      actor: actors.reconAnalyst,
      commandId: "import-batch",
      body: {
        sourceSystem: "TEST_IMPORT",
        accountRef: "ACC-1",
        statementDate: "2026-04-03",
        lines: [
          {
            externalReference: "PAY-EXACT",
            narrative: "Exact line",
            amountMinor: 100000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "BANK_TRANSFER",
          },
          {
            externalReference: "PAY-MISMATCH-X",
            narrative: "Mismatch line",
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
      commandId: "heal-batch",
      body: { maxAgeDays: 2, asAt: "2026-04-03T12:00:00.000Z" },
    });

    assert.equal(result.summary.autoMatches, 1);
    assert.equal(result.summary.exceptionsOpened, 1);

    const snapshot = platform.getSnapshot();
    const matched = snapshot.claims.find((claim) => claim.claimId === exactClaimId);
    assert.equal(matched.status, "RECONCILED");
    assert.equal(snapshot.reconciliation.openExceptions.length, 1);
  } finally {
    await cleanup();
  }
});

test("command idempotency suppresses duplicate submissions", async () => {
  const { platform, cleanup } = await createPlatform();
  try {
    const body = {
      actor: actors.claimsMaker,
      commandId: "dup-submit",
      body: {
        tenantId: "demo-insurer-ke",
        policyRef: "POL-DUP",
        memberRef: "MEM-DUP",
        providerRef: "PROV-DUP",
        incidentDate: "2026-04-01",
        amountMinor: 50000,
        currency: "KES",
        narrative: "Duplicate-safe claim",
        source: "TEST",
      },
    };

    await platform.submitClaim(body);
    await platform.submitClaim(body);

    const snapshot = platform.getSnapshot();
    assert.equal(snapshot.claims.length, 1);
  } finally {
    await cleanup();
  }
});
