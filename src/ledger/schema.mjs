export const LEDGER_SCHEMA_VERSION = "phase-1";

export const LEDGER_AGGREGATE_TYPES = {
  CLAIM: "ledger_claim",
};

export const LEDGER_EVENT_TYPES = {
  CLAIM_SUBMITTED: "CLAIM_SUBMITTED",
  AMOUNT_APPROVED: "AMOUNT_APPROVED",
  PAYMENT_RELEASED: "PAYMENT_RELEASED",
  REVERSAL_POSTED: "REVERSAL_POSTED",
  TAX_CONFIRMED: "TAX_CONFIRMED",
};

export const LEDGER_ACCOUNTS = {
  CLAIMS_EXPENSE: "CLAIMS_EXPENSE",
  CLAIMS_RESERVE_LIABILITY: "CLAIMS_RESERVE_LIABILITY",
  WITHHOLDING_TAX_PAYABLE: "WITHHOLDING_TAX_PAYABLE",
  CASH_AT_BANK: "CASH_AT_BANK",
};

export const ledgerEnvelopeSchema = {
  aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
  schemaVersion: LEDGER_SCHEMA_VERSION,
  requiredEnvelopeFields: [
    "eventId",
    "aggregateType",
    "aggregateId",
    "aggregateVersion",
    "eventType",
    "occurredAt",
    "recordedAt",
    "actor",
    "metadata.commandId",
    "metadata.correlationId",
    "metadata.causationId",
    "metadata.previousHash",
    "metadata.hash",
    "payload",
  ],
};

export const ledgerJournalSchema = {
  requiredFields: ["journalId", "journalType", "currency", "narrative", "lines"],
  lineFields: ["accountCode", "debitMinor", "creditMinor", "reference"],
};

export const ledgerProjectionSchema = {
  claimFields: [
    "claimId",
    "tenantId",
    "claimNumber",
    "policyRef",
    "claimantRef",
    "currency",
    "claimedAmountMinor",
    "approvedAmountMinor",
    "reserveOutstandingMinor",
    "taxConfirmedMinor",
    "paymentReleasedMinor",
    "reversedEventIds",
    "status",
    "version",
  ],
  accountBalanceFields: ["accountCode", "debitTotalMinor", "creditTotalMinor", "netMinor"],
};

export function createEmptyAccountBalance(accountCode) {
  return {
    accountCode,
    debitTotalMinor: 0,
    creditTotalMinor: 0,
    netMinor: 0,
  };
}

export function createEmptyClaimLedgerState(claimId) {
  return {
    claimId,
    tenantId: null,
    claimNumber: null,
    policyRef: null,
    claimantRef: null,
    currency: null,
    claimedAmountMinor: 0,
    approvedAmountMinor: 0,
    reserveOutstandingMinor: 0,
    taxConfirmedMinor: 0,
    paymentReleasedMinor: 0,
    reversedEventIds: [],
    status: "EMPTY",
    version: 0,
    lastEventType: null,
    updatedAt: new Date(0).toISOString(),
  };
}
