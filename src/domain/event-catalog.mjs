import { ValidationError } from "../lib/errors.mjs";
import {
  ensureArray,
  ensureCurrency,
  ensureEnum,
  ensureInteger,
  ensureIsoDate,
  ensureNumber,
  ensureObject,
  ensureOptionalString,
  ensureString,
  ensureStringArray,
} from "../lib/validation.mjs";

function validateLedgerLines(lines) {
  const normalized = ensureArray(lines, "lines", (line, field) => {
    const payload = ensureObject(line, field);
    return {
      account: ensureString(payload.account, `${field}.account`, { max: 120 }),
      debitMinor: ensureInteger(payload.debitMinor, `${field}.debitMinor`, { min: 0 }),
      creditMinor: ensureInteger(payload.creditMinor, `${field}.creditMinor`, { min: 0 }),
      reference: ensureString(payload.reference, `${field}.reference`, { max: 120 }),
    };
  });

  const totalDebit = normalized.reduce((sum, line) => sum + line.debitMinor, 0);
  const totalCredit = normalized.reduce((sum, line) => sum + line.creditMinor, 0);
  if (totalDebit !== totalCredit) {
    throw new ValidationError("Ledger lines must balance.");
  }

  return normalized;
}

export const eventContracts = {
  ClaimSubmitted(payload) {
    const claim = ensureObject(payload, "payload");
    return {
      tenantId: ensureString(claim.tenantId, "tenantId", { max: 80 }),
      policyRef: ensureString(claim.policyRef, "policyRef", { max: 80 }),
      memberRef: ensureString(claim.memberRef, "memberRef", { max: 80 }),
      providerRef: ensureString(claim.providerRef, "providerRef", { max: 80 }),
      incidentDate: ensureIsoDate(claim.incidentDate, "incidentDate"),
      amountMinor: ensureInteger(claim.amountMinor, "amountMinor", { min: 0 }),
      currency: ensureCurrency(claim.currency),
      narrative: ensureString(claim.narrative, "narrative", { max: 400 }),
      source: ensureString(claim.source, "source", { max: 80 }),
    };
  },
  ClaimValidated(payload) {
    const value = ensureObject(payload, "payload");
    return {
      outcome: ensureEnum(value.outcome, "outcome", ["VALID", "NEEDS_INFO", "REJECTED"]),
      findings: ensureStringArray(value.findings ?? [], "findings"),
      duplicateCheckKey: ensureString(value.duplicateCheckKey, "duplicateCheckKey", { max: 120 }),
    };
  },
  ClaimAdjudicated(payload) {
    const value = ensureObject(payload, "payload");
    return {
      decision: ensureEnum(value.decision, "decision", ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"]),
      approvedAmountMinor: ensureInteger(value.approvedAmountMinor, "approvedAmountMinor", { min: 0 }),
      reserveAmountMinor: ensureInteger(value.reserveAmountMinor, "reserveAmountMinor", { min: 0 }),
      reasonCodes: ensureStringArray(value.reasonCodes ?? [], "reasonCodes"),
    };
  },
  LedgerEntryPosted(payload) {
    const value = ensureObject(payload, "payload");
    return {
      entryType: ensureEnum(value.entryType, "entryType", ["CLAIM_RESERVE", "CLAIM_PAYOUT"]),
      currency: ensureCurrency(value.currency),
      lines: validateLedgerLines(value.lines),
    };
  },
  SettlementProposed(payload) {
    const value = ensureObject(payload, "payload");
    return {
      settlementId: ensureString(value.settlementId, "settlementId", { max: 80 }),
      channelType: ensureEnum(value.channelType, "channelType", ["BANK_TRANSFER", "MOBILE_MONEY", "CARD_REVERSAL", "CHEQUE"]),
      beneficiaryRef: ensureString(value.beneficiaryRef, "beneficiaryRef", { max: 120 }),
      paymentReference: ensureString(value.paymentReference, "paymentReference", { max: 120 }),
      amountMinor: ensureInteger(value.amountMinor, "amountMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      makerNote: ensureString(value.makerNote, "makerNote", { max: 240 }),
      makerActorId: ensureString(value.makerActorId, "makerActorId", { max: 80 }),
    };
  },
  ApprovalRequested(payload) {
    const value = ensureObject(payload, "payload");
    return {
      requestId: ensureString(value.requestId, "requestId", { max: 80 }),
      action: ensureEnum(value.action, "action", ["SETTLEMENT_RELEASE"]),
      makerActorId: ensureString(value.makerActorId, "makerActorId", { max: 80 }),
      checkerRole: ensureString(value.checkerRole, "checkerRole", { max: 80 }),
    };
  },
  ApprovalGranted(payload) {
    const value = ensureObject(payload, "payload");
    return {
      requestId: ensureString(value.requestId, "requestId", { max: 80 }),
      checkerActorId: ensureString(value.checkerActorId, "checkerActorId", { max: 80 }),
      approvalNote: ensureString(value.approvalNote, "approvalNote", { max: 240 }),
    };
  },
  SettlementRecorded(payload) {
    const value = ensureObject(payload, "payload");
    return {
      settlementId: ensureString(value.settlementId, "settlementId", { max: 80 }),
      postingRef: ensureString(value.postingRef, "postingRef", { max: 120 }),
      amountMinor: ensureInteger(value.amountMinor, "amountMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      channelType: ensureEnum(value.channelType, "channelType", ["BANK_TRANSFER", "MOBILE_MONEY", "CARD_REVERSAL", "CHEQUE"]),
      externalStatus: ensureEnum(value.externalStatus, "externalStatus", ["MANUALLY_CONFIRMED", "POSTED_FROM_ADAPTER"]),
    };
  },
  ReconciliationBatchImported(payload) {
    const value = ensureObject(payload, "payload");
    return {
      batchId: ensureString(value.batchId, "batchId", { max: 80 }),
      sourceSystem: ensureString(value.sourceSystem, "sourceSystem", { max: 120 }),
      accountRef: ensureString(value.accountRef, "accountRef", { max: 120 }),
      statementDate: ensureIsoDate(value.statementDate, "statementDate"),
      lineCount: ensureInteger(value.lineCount, "lineCount", { min: 0 }),
      digest: ensureString(value.digest, "digest", { max: 128 }),
    };
  },
  StatementLineRecorded(payload) {
    const value = ensureObject(payload, "payload");
    return {
      caseId: ensureString(value.caseId, "caseId", { max: 80 }),
      batchId: ensureString(value.batchId, "batchId", { max: 80 }),
      lineId: ensureString(value.lineId, "lineId", { max: 80 }),
      externalReference: ensureString(value.externalReference, "externalReference", { max: 120 }),
      narrative: ensureString(value.narrative, "narrative", { max: 240 }),
      amountMinor: ensureInteger(value.amountMinor, "amountMinor", { min: 0 }),
      currency: ensureCurrency(value.currency),
      direction: ensureEnum(value.direction, "direction", ["DEBIT", "CREDIT"]),
      valueDate: ensureIsoDate(value.valueDate, "valueDate"),
      channelType: ensureEnum(value.channelType, "channelType", ["BANK_TRANSFER", "MOBILE_MONEY", "CARD_REVERSAL", "CHEQUE", "UNKNOWN"]),
    };
  },
  MatchCandidateGenerated(payload) {
    const value = ensureObject(payload, "payload");
    return {
      caseId: ensureString(value.caseId, "caseId", { max: 80 }),
      claimId: ensureString(value.claimId, "claimId", { max: 80 }),
      settlementId: ensureString(value.settlementId, "settlementId", { max: 80 }),
      matchType: ensureEnum(value.matchType, "matchType", ["EXACT_REFERENCE_AMOUNT"]),
      confidence: ensureNumber(value.confidence, "confidence", { min: 0, max: 1 }),
    };
  },
  AutoMatchApplied(payload) {
    const value = ensureObject(payload, "payload");
    return {
      caseId: ensureString(value.caseId, "caseId", { max: 80 }),
      claimId: ensureString(value.claimId, "claimId", { max: 80 }),
      settlementId: ensureString(value.settlementId, "settlementId", { max: 80 }),
      reason: ensureString(value.reason, "reason", { max: 240 }),
    };
  },
  ReconciliationExceptionOpened(payload) {
    const value = ensureObject(payload, "payload");
    return {
      caseId: ensureString(value.caseId, "caseId", { max: 80 }),
      batchId: ensureOptionalString(value.batchId, "batchId", { max: 80 }),
      lineId: ensureOptionalString(value.lineId, "lineId", { max: 80 }),
      claimId: ensureOptionalString(value.claimId, "claimId", { max: 80 }),
      settlementId: ensureOptionalString(value.settlementId, "settlementId", { max: 80 }),
      code: ensureEnum(value.code, "code", ["REFERENCE_MISMATCH", "UNLINKED_CASHFLOW", "MISSING_CASH_MOVEMENT", "AMBIGUOUS_MATCH"]),
      severity: ensureEnum(value.severity, "severity", ["LOW", "MEDIUM", "HIGH"]),
      reason: ensureString(value.reason, "reason", { max: 240 }),
    };
  },
  ReconciliationExceptionResolved(payload) {
    const value = ensureObject(payload, "payload");
    return {
      caseId: ensureString(value.caseId, "caseId", { max: 80 }),
      resolutionCode: ensureEnum(value.resolutionCode, "resolutionCode", ["MANUAL_CONFIRMED", "WRITE_OFF", "FALSE_POSITIVE", "ESCALATED_EXTERNALLY"]),
      resolutionNote: ensureString(value.resolutionNote, "resolutionNote", { max: 240 }),
    };
  },
};

export function validateEventContract(eventType, payload) {
  const validator = eventContracts[eventType];
  if (!validator) {
    throw new ValidationError(`Unknown event type: ${eventType}`);
  }
  return validator(payload);
}
