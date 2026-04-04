import { ValidationError } from "../lib/errors.mjs";
import {
  ensureArray,
  ensureCurrency,
  ensureEnum,
  ensureInteger,
  ensureIsoDate,
  ensureObject,
  ensureString,
} from "../lib/validation.mjs";
import { LEDGER_EVENT_TYPES } from "./schema.mjs";

function validateJournalLines(lines) {
  const normalized = ensureArray(lines, "journal.lines", (line, field) => {
    const value = ensureObject(line, field);
    const debitMinor = ensureInteger(value.debitMinor, `${field}.debitMinor`, { min: 0 });
    const creditMinor = ensureInteger(value.creditMinor, `${field}.creditMinor`, { min: 0 });
    if ((debitMinor === 0 && creditMinor === 0) || (debitMinor > 0 && creditMinor > 0)) {
      throw new ValidationError(`${field}: each line must have exactly one non-zero side`);
    }

    return {
      accountCode: ensureString(value.accountCode, `${field}.accountCode`, { max: 120 }),
      debitMinor,
      creditMinor,
      reference: ensureString(value.reference, `${field}.reference`, { max: 120 }),
    };
  });

  const totalDebit = normalized.reduce((sum, line) => sum + line.debitMinor, 0);
  const totalCredit = normalized.reduce((sum, line) => sum + line.creditMinor, 0);
  if (normalized.length < 2) {
    throw new ValidationError("journal.lines: balanced journals require at least two lines");
  }
  if (totalDebit !== totalCredit) {
    throw new ValidationError("journal.lines: debits and credits must balance");
  }

  return normalized;
}

function validateJournal(journal) {
  const value = ensureObject(journal, "journal");
  return {
    journalId: ensureString(value.journalId, "journal.journalId", { max: 80 }),
    journalType: ensureString(value.journalType, "journal.journalType", { max: 80 }),
    currency: ensureCurrency(value.currency),
    narrative: ensureString(value.narrative, "journal.narrative", { max: 240 }),
    lines: validateJournalLines(value.lines),
  };
}

export const ledgerEventContracts = {
  [LEDGER_EVENT_TYPES.CLAIM_SUBMITTED](payload) {
    const value = ensureObject(payload, "payload");
    return {
      tenantId: ensureString(value.tenantId, "tenantId", { max: 80 }),
      claimNumber: ensureString(value.claimNumber, "claimNumber", { max: 80 }),
      policyRef: ensureString(value.policyRef, "policyRef", { max: 80 }),
      claimantRef: ensureString(value.claimantRef, "claimantRef", { max: 80 }),
      claimDate: ensureIsoDate(value.claimDate, "claimDate"),
      claimedAmountMinor: ensureInteger(value.claimedAmountMinor, "claimedAmountMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      reserveBasis: ensureEnum(value.reserveBasis, "reserveBasis", ["CLAIM_APPROVAL"]),
      narrative: ensureString(value.narrative, "narrative", { max: 240 }),
    };
  },
  [LEDGER_EVENT_TYPES.AMOUNT_APPROVED](payload) {
    const value = ensureObject(payload, "payload");
    return {
      approvalId: ensureString(value.approvalId, "approvalId", { max: 80 }),
      approvalDate: ensureIsoDate(value.approvalDate, "approvalDate"),
      approvedDeltaMinor: ensureInteger(value.approvedDeltaMinor, "approvedDeltaMinor"),
      reserveDeltaMinor: ensureInteger(value.reserveDeltaMinor, "reserveDeltaMinor"),
      resultingApprovedAmountMinor: ensureInteger(value.resultingApprovedAmountMinor, "resultingApprovedAmountMinor", { min: 0 }),
      resultingReserveAmountMinor: ensureInteger(value.resultingReserveAmountMinor, "resultingReserveAmountMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      journal: validateJournal(value.journal),
    };
  },
  [LEDGER_EVENT_TYPES.TAX_CONFIRMED](payload) {
    const value = ensureObject(payload, "payload");
    return {
      taxConfirmationId: ensureString(value.taxConfirmationId, "taxConfirmationId", { max: 80 }),
      taxCode: ensureString(value.taxCode, "taxCode", { max: 80 }),
      jurisdiction: ensureString(value.jurisdiction, "jurisdiction", { max: 80 }),
      taxAmountMinor: ensureInteger(value.taxAmountMinor, "taxAmountMinor", { min: 0 }),
      resultingTaxConfirmedMinor: ensureInteger(value.resultingTaxConfirmedMinor, "resultingTaxConfirmedMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      journal: validateJournal(value.journal),
    };
  },
  [LEDGER_EVENT_TYPES.PAYMENT_RELEASED](payload) {
    const value = ensureObject(payload, "payload");
    return {
      paymentId: ensureString(value.paymentId, "paymentId", { max: 80 }),
      paymentReference: ensureString(value.paymentReference, "paymentReference", { max: 120 }),
      releaseDate: ensureIsoDate(value.releaseDate, "releaseDate"),
      netAmountMinor: ensureInteger(value.netAmountMinor, "netAmountMinor", { min: 0 }),
      taxAppliedMinor: ensureInteger(value.taxAppliedMinor, "taxAppliedMinor", { min: 0 }),
      resultingPaymentReleasedMinor: ensureInteger(value.resultingPaymentReleasedMinor, "resultingPaymentReleasedMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      journal: validateJournal(value.journal),
    };
  },
  [LEDGER_EVENT_TYPES.REVERSAL_POSTED](payload) {
    const value = ensureObject(payload, "payload");
    return {
      reversalId: ensureString(value.reversalId, "reversalId", { max: 80 }),
      reversalDate: ensureIsoDate(value.reversalDate, "reversalDate"),
      reversalOfEventId: ensureString(value.reversalOfEventId, "reversalOfEventId", { max: 80 }),
      reversalOfEventType: ensureEnum(value.reversalOfEventType, "reversalOfEventType", [
        LEDGER_EVENT_TYPES.AMOUNT_APPROVED,
        LEDGER_EVENT_TYPES.TAX_CONFIRMED,
        LEDGER_EVENT_TYPES.PAYMENT_RELEASED,
      ]),
      reason: ensureString(value.reason, "reason", { max: 240 }),
      currency: ensureCurrency(value.currency),
      reversalImpact: {
        approvedDeltaMinor: ensureInteger(value.reversalImpact?.approvedDeltaMinor ?? 0, "reversalImpact.approvedDeltaMinor"),
        reserveDeltaMinor: ensureInteger(value.reversalImpact?.reserveDeltaMinor ?? 0, "reversalImpact.reserveDeltaMinor"),
        taxDeltaMinor: ensureInteger(value.reversalImpact?.taxDeltaMinor ?? 0, "reversalImpact.taxDeltaMinor"),
        paymentDeltaMinor: ensureInteger(value.reversalImpact?.paymentDeltaMinor ?? 0, "reversalImpact.paymentDeltaMinor"),
      },
      journal: validateJournal(value.journal),
    };
  },
};

export function validateLedgerEventContract(eventType, payload) {
  const validator = ledgerEventContracts[eventType];
  if (!validator) {
    throw new ValidationError(`Unknown Phase 1 ledger event type: ${eventType}`);
  }

  return validator(payload);
}
