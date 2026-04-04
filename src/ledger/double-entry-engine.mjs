import { createId } from "../lib/ids.mjs";
import { ValidationError } from "../lib/errors.mjs";
import { LEDGER_ACCOUNTS } from "./schema.mjs";

function balancedJournal({ journalType, currency, narrative, lines }) {
  const totalDebit = lines.reduce((sum, line) => sum + line.debitMinor, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.creditMinor, 0);
  if (lines.length < 2) {
    throw new ValidationError("Balanced journals require at least two lines.");
  }
  if (totalDebit !== totalCredit) {
    throw new ValidationError("Double-entry journals must balance.");
  }

  return {
    journalId: createId("jrn"),
    journalType,
    currency,
    narrative,
    lines,
  };
}

export class DoubleEntryEngine {
  createReserveApprovalJournal({ claimId, reserveDeltaMinor, currency }) {
    if (!Number.isInteger(reserveDeltaMinor) || reserveDeltaMinor === 0) {
      throw new ValidationError("reserveDeltaMinor must be a non-zero integer.");
    }

    if (reserveDeltaMinor > 0) {
      return balancedJournal({
        journalType: "RESERVE_ESTABLISHMENT",
        currency,
        narrative: "Reserve established or increased after approval.",
        lines: [
          {
            accountCode: LEDGER_ACCOUNTS.CLAIMS_EXPENSE,
            debitMinor: reserveDeltaMinor,
            creditMinor: 0,
            reference: claimId,
          },
          {
            accountCode: LEDGER_ACCOUNTS.CLAIMS_RESERVE_LIABILITY,
            debitMinor: 0,
            creditMinor: reserveDeltaMinor,
            reference: claimId,
          },
        ],
      });
    }

    const absoluteDeltaMinor = Math.abs(reserveDeltaMinor);
    return balancedJournal({
      journalType: "RESERVE_RELEASE",
      currency,
      narrative: "Reserve reduced after approval adjustment.",
      lines: [
        {
          accountCode: LEDGER_ACCOUNTS.CLAIMS_RESERVE_LIABILITY,
          debitMinor: absoluteDeltaMinor,
          creditMinor: 0,
          reference: claimId,
        },
        {
          accountCode: LEDGER_ACCOUNTS.CLAIMS_EXPENSE,
          debitMinor: 0,
          creditMinor: absoluteDeltaMinor,
          reference: claimId,
        },
      ],
    });
  }

  createTaxConfirmationJournal({ claimId, taxAmountMinor, currency }) {
    if (!Number.isInteger(taxAmountMinor) || taxAmountMinor <= 0) {
      throw new ValidationError("taxAmountMinor must be a positive integer.");
    }

    return balancedJournal({
      journalType: "TAX_RECLASSIFICATION",
      currency,
      narrative: "Tax confirmed and reclassified from reserve liability.",
      lines: [
        {
          accountCode: LEDGER_ACCOUNTS.CLAIMS_RESERVE_LIABILITY,
          debitMinor: taxAmountMinor,
          creditMinor: 0,
          reference: claimId,
        },
        {
          accountCode: LEDGER_ACCOUNTS.WITHHOLDING_TAX_PAYABLE,
          debitMinor: 0,
          creditMinor: taxAmountMinor,
          reference: claimId,
        },
      ],
    });
  }

  createPaymentReleaseJournal({ claimId, netAmountMinor, currency }) {
    if (!Number.isInteger(netAmountMinor) || netAmountMinor <= 0) {
      throw new ValidationError("netAmountMinor must be a positive integer.");
    }

    return balancedJournal({
      journalType: "PAYMENT_RELEASE",
      currency,
      narrative: "Payment released against approved reserve.",
      lines: [
        {
          accountCode: LEDGER_ACCOUNTS.CLAIMS_RESERVE_LIABILITY,
          debitMinor: netAmountMinor,
          creditMinor: 0,
          reference: claimId,
        },
        {
          accountCode: LEDGER_ACCOUNTS.CASH_AT_BANK,
          debitMinor: 0,
          creditMinor: netAmountMinor,
          reference: claimId,
        },
      ],
    });
  }

  createReversalJournal({ claimId, sourceJournal, sourceEventType }) {
    if (!sourceJournal || !Array.isArray(sourceJournal.lines) || sourceJournal.lines.length === 0) {
      throw new ValidationError("Only journalized events can be reversed.");
    }

    return balancedJournal({
      journalType: "REVERSAL",
      currency: sourceJournal.currency,
      narrative: `Reversal of ${sourceEventType}.`,
      lines: sourceJournal.lines.map((line) => ({
        accountCode: line.accountCode,
        debitMinor: line.creditMinor,
        creditMinor: line.debitMinor,
        reference: claimId,
      })),
    });
  }
}
