import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { FileEventStore } from "../src/infrastructure/file-event-store.mjs";
import { validateLedgerEventContract } from "../src/ledger/event-contracts.mjs";
import { LedgerProjectionStore } from "../src/ledger/ledger-projection-store.mjs";
import { LedgerService } from "../src/ledger/ledger-service.mjs";

const actors = {
  claimsMaker: { actorId: "claims-maker", displayName: "Claims Maker", roles: ["CLAIMS_MAKER"] },
  claimsChecker: { actorId: "claims-checker", displayName: "Claims Checker", roles: ["CLAIMS_CHECKER"] },
  financeChecker: { actorId: "finance-checker", displayName: "Finance Checker", roles: ["FINANCE_CHECKER"] },
  taxOfficer: { actorId: "tax-officer", displayName: "Tax Officer", roles: ["TAX_OFFICER"] },
};

async function createLedgerFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-foundation-"));
  const filePath = path.join(dir, "ledger-events.jsonl");
  const service = new LedgerService({
    eventStore: new FileEventStore(filePath, { validateEvent: validateLedgerEventContract }),
    projections: new LedgerProjectionStore(),
  });
  await service.init();
  return {
    dir,
    filePath,
    service,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function createReservedClaim(service, suffix = "1") {
  const submitted = await service.submitClaim({
    actor: actors.claimsMaker,
    commandId: `submit-${suffix}`,
    body: {
      claimId: `ledclm-${suffix}`,
      tenantId: "demo-insurer-ke",
      claimNumber: `CLM-${suffix}`,
      policyRef: `POL-${suffix}`,
      claimantRef: `CLMT-${suffix}`,
      claimDate: "2026-04-04",
      claimedAmountMinor: 100000,
      currency: "KES",
      reserveBasis: "CLAIM_APPROVAL",
      narrative: "Claim registered for reserve accounting.",
    },
  });

  await service.approveAmount(submitted.claim.claimId, {
    actor: actors.claimsChecker,
    commandId: `approve-${suffix}`,
    body: {
      approvalDate: "2026-04-04",
      targetApprovedAmountMinor: 100000,
      currency: "KES",
    },
  });

  return submitted.claim.claimId;
}

function getBalance(snapshot, accountCode) {
  return snapshot.accountBalances.find((item) => item.accountCode === accountCode);
}

test("reserve accounting is created only through append-only approval events", async () => {
  const { service, cleanup } = await createLedgerFixture();
  try {
    const claimId = await createReservedClaim(service, "reserve");
    const snapshot = service.getSnapshot();
    const claim = snapshot.claims.find((item) => item.claimId === claimId);

    assert.equal(claim.approvedAmountMinor, 100000);
    assert.equal(claim.reserveOutstandingMinor, 100000);
    assert.equal(snapshot.recentEvents.length, 2);
    assert.deepEqual(
      snapshot.recentEvents.map((event) => event.eventType),
      ["AMOUNT_APPROVED", "CLAIM_SUBMITTED"],
    );

    const expense = getBalance(snapshot, "CLAIMS_EXPENSE");
    const reserve = getBalance(snapshot, "CLAIMS_RESERVE_LIABILITY");
    assert.equal(expense.debitTotalMinor, 100000);
    assert.equal(expense.creditTotalMinor, 0);
    assert.equal(reserve.debitTotalMinor, 0);
    assert.equal(reserve.creditTotalMinor, 100000);
  } finally {
    await cleanup();
  }
});

test("tax confirmation and payment release settle reserve through balanced journals", async () => {
  const { service, cleanup } = await createLedgerFixture();
  try {
    const claimId = await createReservedClaim(service, "settlement");
    await service.confirmTax(claimId, {
      actor: actors.taxOfficer,
      commandId: "tax-settlement",
      body: {
        taxConfirmationId: "tax-settlement",
        taxCode: "WHT",
        jurisdiction: "KE",
        taxAmountMinor: 5000,
        currency: "KES",
      },
    });
    await service.releasePayment(claimId, {
      actor: actors.financeChecker,
      commandId: "payment-settlement",
      body: {
        paymentId: "pay-settlement",
        paymentReference: "PAY-SETTLEMENT",
        releaseDate: "2026-04-04",
        netAmountMinor: 95000,
        taxAppliedMinor: 5000,
        currency: "KES",
      },
    });

    const snapshot = service.getSnapshot();
    const claim = snapshot.claims.find((item) => item.claimId === claimId);
    const reserve = getBalance(snapshot, "CLAIMS_RESERVE_LIABILITY");
    const taxPayable = getBalance(snapshot, "WITHHOLDING_TAX_PAYABLE");
    const cash = getBalance(snapshot, "CASH_AT_BANK");

    assert.equal(claim.reserveOutstandingMinor, 0);
    assert.equal(claim.taxConfirmedMinor, 5000);
    assert.equal(claim.paymentReleasedMinor, 95000);
    assert.equal(reserve.debitTotalMinor, 100000);
    assert.equal(reserve.creditTotalMinor, 100000);
    assert.equal(taxPayable.creditTotalMinor, 5000);
    assert.equal(cash.creditTotalMinor, 95000);
  } finally {
    await cleanup();
  }
});

test("reversal appends inverse journals instead of mutating prior payment entries", async () => {
  const { service, cleanup } = await createLedgerFixture();
  try {
    const claimId = await createReservedClaim(service, "reversal");
    await service.confirmTax(claimId, {
      actor: actors.taxOfficer,
      commandId: "tax-reversal",
      body: {
        taxCode: "WHT",
        jurisdiction: "KE",
        taxAmountMinor: 5000,
        currency: "KES",
      },
    });
    await service.releasePayment(claimId, {
      actor: actors.financeChecker,
      commandId: "payment-reversal",
      body: {
        paymentReference: "PAY-REVERSAL",
        releaseDate: "2026-04-04",
        netAmountMinor: 95000,
        taxAppliedMinor: 5000,
        currency: "KES",
      },
    });

    const paymentEvent = service
      .getSnapshot()
      .recentEvents.find((event) => event.eventType === "PAYMENT_RELEASED");
    await service.postReversal(claimId, {
      actor: actors.financeChecker,
      commandId: "reverse-payment",
      body: {
        reversalDate: "2026-04-04",
        reversalOfEventId: paymentEvent.eventId,
        reason: "Bank posting reversed before beneficiary receipt.",
        currency: "KES",
      },
    });

    const snapshot = service.getSnapshot();
    const claim = snapshot.claims.find((item) => item.claimId === claimId);
    const cash = getBalance(snapshot, "CASH_AT_BANK");

    assert.equal(claim.reserveOutstandingMinor, 95000);
    assert.equal(claim.paymentReleasedMinor, 0);
    assert.deepEqual(claim.reversedEventIds, [paymentEvent.eventId]);
    assert.equal(cash.debitTotalMinor, 95000);
    assert.equal(cash.creditTotalMinor, 95000);
  } finally {
    await cleanup();
  }
});

test("hash chain integrity detects tampering during reload", async () => {
  const { filePath, service, cleanup } = await createLedgerFixture();
  try {
    await createReservedClaim(service, "tamper");
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split(/\r?\n/);
    const altered = JSON.parse(lines[1]);
    altered.payload.resultingApprovedAmountMinor = 999999;
    lines[1] = JSON.stringify(altered);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const reloaded = new FileEventStore(filePath, { validateEvent: validateLedgerEventContract });
    await assert.rejects(() => reloaded.init(), /hash verification failed/i);
  } finally {
    await cleanup();
  }
});

test("replay rebuild reproduces claim state and account balances from the log", async () => {
  const { filePath, service, cleanup } = await createLedgerFixture();
  try {
    const claimId = await createReservedClaim(service, "replay");
    await service.confirmTax(claimId, {
      actor: actors.taxOfficer,
      commandId: "tax-replay",
      body: {
        taxCode: "WHT",
        jurisdiction: "KE",
        taxAmountMinor: 5000,
        currency: "KES",
      },
    });

    const original = service.getSnapshot();
    const reloadedStore = new FileEventStore(filePath, { validateEvent: validateLedgerEventContract });
    const rebuilt = new LedgerService({
      eventStore: reloadedStore,
      projections: new LedgerProjectionStore(),
    });
    await rebuilt.init();

    assert.deepEqual(rebuilt.getSnapshot().claims, original.claims);
    assert.deepEqual(rebuilt.getSnapshot().accountBalances, original.accountBalances);
  } finally {
    await cleanup();
  }
});

test("mixed-currency postings are blocked on a single claim ledger", async () => {
  const { service, cleanup } = await createLedgerFixture();
  try {
    const claimId = await createReservedClaim(service, "currency");
    await assert.rejects(
      () =>
        service.confirmTax(claimId, {
          actor: actors.taxOfficer,
          commandId: "tax-currency-mismatch",
          body: {
            taxCode: "WHT",
            jurisdiction: "KE",
            taxAmountMinor: 1000,
            currency: "USD",
          },
        }),
      /mixed-currency postings are not allowed/i,
    );
  } finally {
    await cleanup();
  }
});
