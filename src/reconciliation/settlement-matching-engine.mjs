const DEFAULT_EXCEPTION = {
  outcome: "exception",
  code: "UNLINKED_CASHFLOW",
  severity: "MEDIUM",
  reason: "No confirmed settlement matched this statement line.",
};

function settlementTargetAmount(settlement) {
  return settlement.confirmedAmountMinor > 0 ? settlement.confirmedAmountMinor : settlement.amountMinor;
}

function settlementRemainingAmount(settlement) {
  return Math.max(settlementTargetAmount(settlement) - (settlement.matchedAmountMinor ?? 0), 0);
}

function buildDuplicateKey(caseItem) {
  return [
    caseItem.externalReference ?? "NA",
    caseItem.amountMinor ?? 0,
    caseItem.currency ?? "NA",
    caseItem.direction ?? "NA",
    caseItem.valueDate ?? "NA",
  ].join("|");
}

export class SettlementMatchingEngine {
  findDuplicateCaseIds(cases) {
    const groups = new Map();
    for (const item of cases) {
      if (!item.lineId) {
        continue;
      }
      const key = buildDuplicateKey(item);
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }

    const duplicates = new Set();
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }

      const sorted = [...group].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const duplicate of sorted.slice(1)) {
        duplicates.add(duplicate.caseId);
      }
    }

    return duplicates;
  }

  evaluateCase(caseItem, claims, duplicateCaseIds = new Set()) {
    if (caseItem.direction !== "DEBIT") {
      return { outcome: "ignore" };
    }

    if (duplicateCaseIds.has(caseItem.caseId)) {
      return {
        outcome: "exception",
        code: "DUPLICATE_TRANSACTION",
        severity: "HIGH",
        reason: "A duplicate statement line with the same reference, amount, currency, direction, and value date was detected.",
      };
    }

    const candidates = claims.filter((claim) => {
      const settlement = claim.settlement;
      return (
        settlement &&
        settlement.state === "confirmed" &&
        settlement.state !== "reversed" &&
        claim.currency === caseItem.currency &&
        settlementRemainingAmount(settlement) > 0
      );
    });

    const exactReference = candidates.filter((claim) => claim.settlement.paymentReference === caseItem.externalReference);
    if (exactReference.length === 1) {
      const winner = exactReference[0];
      const remainingAmountMinor = settlementRemainingAmount(winner.settlement);
      if (caseItem.amountMinor === remainingAmountMinor) {
        return {
          outcome: "full_match",
          claimId: winner.claimId,
          settlementId: winner.settlement.settlementId,
          matchedAmountMinor: caseItem.amountMinor,
          matchType: "EXACT_REFERENCE_AMOUNT",
          confidence: 1,
          reason: "Exact payment reference, currency, and amount matched.",
        };
      }

      if (caseItem.amountMinor < remainingAmountMinor) {
        return {
          outcome: "partial_match",
          claimId: winner.claimId,
          settlementId: winner.settlement.settlementId,
          matchedAmountMinor: caseItem.amountMinor,
          cumulativeMatchedAmountMinor: (winner.settlement.matchedAmountMinor ?? 0) + caseItem.amountMinor,
          remainingAmountMinor: remainingAmountMinor - caseItem.amountMinor,
          matchType: "EXACT_REFERENCE_PARTIAL",
          confidence: 0.98,
          reason: "Exact payment reference matched a partial payment against the confirmed settlement.",
        };
      }

      return {
        outcome: "exception",
        code: "AMOUNT_VARIANCE",
        severity: "HIGH",
        claimId: winner.claimId,
        settlementId: winner.settlement.settlementId,
        reason: "Payment reference matched, but the statement amount exceeded the remaining confirmed settlement amount.",
      };
    }

    const amountOnly = candidates.filter((claim) => settlementRemainingAmount(claim.settlement) === caseItem.amountMinor);
    if (amountOnly.length === 1) {
      return {
        outcome: "exception",
        code: "REFERENCE_MISMATCH",
        severity: "MEDIUM",
        claimId: amountOnly[0].claimId,
        settlementId: amountOnly[0].settlement.settlementId,
        reason: "Amount matched a single confirmed settlement, but the external reference did not.",
      };
    }

    if (amountOnly.length > 1 || exactReference.length > 1) {
      return {
        outcome: "exception",
        code: "AMBIGUOUS_MATCH",
        severity: "HIGH",
        reason: "Multiple confirmed settlements are plausible candidates for this statement line.",
      };
    }

    return DEFAULT_EXCEPTION;
  }

  findMissingCashMovementClaims(claims, cases, now, maxAgeDays) {
    const matchedSettlementIds = new Set(
      cases
        .filter((item) => ["MATCHED", "PARTIAL_MATCHED"].includes(item.status) && item.settlementId)
        .map((item) => item.settlementId),
    );

    return claims.filter((claim) => {
      const settlement = claim.settlement;
      if (!settlement || settlement.state !== "confirmed" || settlement.state === "reversed") {
        return false;
      }

      const remainingAmountMinor = settlementRemainingAmount(settlement);
      if (remainingAmountMinor <= 0) {
        return false;
      }

      if (matchedSettlementIds.has(settlement.settlementId) && (settlement.matchedAmountMinor ?? 0) > 0) {
        return false;
      }

      const anchor = settlement.confirmedAt ?? settlement.recordedAt ?? claim.updatedAt;
      const ageDays = Math.floor((now.getTime() - new Date(anchor).getTime()) / (24 * 60 * 60 * 1000));
      return ageDays >= maxAgeDays;
    });
  }
}
