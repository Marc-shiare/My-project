import { clone } from "../lib/json.mjs";

function byNewest(a, b) {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function settlementTargetAmount(settlement) {
  return settlement.confirmedAmountMinor > 0 ? settlement.confirmedAmountMinor : settlement.amountMinor;
}

function settlementRemainingAmount(settlement) {
  return Math.max(settlementTargetAmount(settlement) - (settlement.matchedAmountMinor ?? 0), 0);
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) {
    list.push(value);
  }
}

export class ProjectionStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.claims = new Map();
    this.batches = new Map();
    this.cases = new Map();
    this.ledgerEntries = [];
    this.commandIds = new Set();
    this.events = [];
    this.integrity = { ok: true, eventCount: 0, lastHash: "GENESIS" };
  }

  rebuild(events, integrity = { ok: true, eventCount: 0, lastHash: "GENESIS" }) {
    this.reset();
    this.integrity = integrity;
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  applyEvents(events) {
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  restoreState(state, integrity = { ok: true, eventCount: 0, lastHash: "GENESIS" }) {
    this.reset();
    this.claims = new Map((state.claims ?? []).map(([key, value]) => [key, clone(value)]));
    this.batches = new Map((state.batches ?? []).map(([key, value]) => [key, clone(value)]));
    this.cases = new Map((state.cases ?? []).map(([key, value]) => [key, clone(value)]));
    this.ledgerEntries = (state.ledgerEntries ?? []).map(clone);
    this.commandIds = new Set(state.commandIds ?? []);
    this.events = (state.recentEvents ?? []).map(clone);
    this.integrity = integrity;
  }

  exportState() {
    return {
      claims: [...this.claims.entries()].map(([key, value]) => [key, clone(value)]),
      batches: [...this.batches.entries()].map(([key, value]) => [key, clone(value)]),
      cases: [...this.cases.entries()].map(([key, value]) => [key, clone(value)]),
      ledgerEntries: this.ledgerEntries.map(clone),
      commandIds: [...this.commandIds],
      recentEvents: this.events.slice(-100).map(clone),
    };
  }

  applyEvent(event) {
    this.events.push(event);
    if (event.metadata?.commandId) {
      this.commandIds.add(event.metadata.commandId);
    }

    switch (event.eventType) {
      case "ClaimSubmitted":
        this.#applyClaimSubmitted(event);
        break;
      case "ClaimValidated":
        this.#applyClaimValidated(event);
        break;
      case "ClaimAdjudicated":
        this.#applyClaimAdjudicated(event);
        break;
      case "SettlementProposed":
        this.#applySettlementProposed(event);
        break;
      case "ApprovalRequested":
        this.#applyApprovalRequested(event);
        break;
      case "ApprovalGranted":
        this.#applyApprovalGranted(event);
        break;
      case "SettlementInitiated":
        this.#applySettlementInitiated(event);
        break;
      case "SettlementPendingProvider":
        this.#applySettlementPendingProvider(event);
        break;
      case "SettlementConfirmed":
        this.#applySettlementConfirmed(event);
        break;
      case "SettlementFailed":
        this.#applySettlementFailed(event);
        break;
      case "SettlementRetried":
        this.#applySettlementRetried(event);
        break;
      case "SettlementReversed":
        this.#applySettlementReversed(event);
        break;
      case "SettlementRecorded":
        this.#applySettlementRecorded(event);
        break;
      case "LedgerEntryPosted":
        this.#applyLedgerEntry(event);
        break;
      case "ReconciliationBatchImported":
        this.#applyReconciliationBatch(event);
        break;
      case "StatementLineRecorded":
        this.#applyStatementLine(event);
        break;
      case "MatchCandidateGenerated":
        this.#applyMatchCandidate(event);
        break;
      case "AutoMatchApplied":
        this.#applyAutoMatch(event);
        break;
      case "PartialMatchApplied":
        this.#applyPartialMatch(event);
        break;
      case "ReconciliationExceptionOpened":
        this.#applyExceptionOpened(event);
        break;
      case "ReconciliationExceptionResolved":
        this.#applyExceptionResolved(event);
        break;
      default:
        break;
    }
  }

  #ensureClaim(claimId) {
    const claim = this.claims.get(claimId);
    if (!claim) {
      throw new Error(`Projection missing claim ${claimId}`);
    }
    return claim;
  }

  #ensureCase(caseId) {
    const current = this.cases.get(caseId);
    if (current) {
      return current;
    }

    const fallback = {
      caseId,
      batchId: null,
      lineId: null,
      externalReference: null,
      narrative: null,
      amountMinor: null,
      currency: null,
      direction: null,
      valueDate: null,
      channelType: null,
      claimId: null,
      settlementId: null,
      status: "OPEN",
      candidate: null,
      exception: null,
      resolution: null,
      matchedAmountMinor: 0,
      remainingAmountMinor: null,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    };
    this.cases.set(caseId, fallback);
    return fallback;
  }

  #syncConfirmedSettlementState(claim, occurredAt) {
    if (!claim.settlement || claim.settlement.state !== "confirmed") {
      return;
    }

    claim.settlement.outstandingMatchMinor = settlementRemainingAmount(claim.settlement);
    if (claim.settlement.outstandingMatchMinor === 0 && settlementTargetAmount(claim.settlement) > 0) {
      claim.reconciliation.status = "MATCHED";
      claim.status = "RECONCILED";
    } else if ((claim.settlement.matchedAmountMinor ?? 0) > 0) {
      claim.reconciliation.status = "PARTIAL";
      claim.status = "RECON_PARTIAL";
    } else {
      claim.reconciliation.status = "PENDING";
      claim.status = "SETTLED_PENDING_RECON";
    }
    claim.updatedAt = occurredAt;
  }

  #applyClaimSubmitted(event) {
    this.claims.set(event.aggregateId, {
      claimId: event.aggregateId,
      tenantId: event.payload.tenantId,
      policyRef: event.payload.policyRef,
      memberRef: event.payload.memberRef,
      providerRef: event.payload.providerRef,
      incidentDate: event.payload.incidentDate,
      amountMinor: event.payload.amountMinor,
      currency: event.payload.currency,
      narrative: event.payload.narrative,
      source: event.payload.source,
      status: "SUBMITTED",
      validation: null,
      adjudication: null,
      settlement: null,
      approvalRequest: null,
      reconciliation: {
        status: "PENDING",
        caseIds: [],
      },
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      version: event.aggregateVersion,
    });
  }

  #applyClaimValidated(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.validation = event.payload;
    claim.status = event.payload.outcome === "VALID" ? "VALIDATED" : event.payload.outcome;
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applyClaimAdjudicated(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.adjudication = event.payload;
    claim.status = event.payload.decision === "REJECTED" ? "REJECTED" : "APPROVED_FOR_SETTLEMENT";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementProposed(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.settlement = {
      ...event.payload,
      workflowStatus: "PROPOSED",
      state: null,
      attemptCount: 0,
      lastAttemptId: null,
      providerReference: null,
      pendingReason: null,
      nextReviewAt: null,
      confirmedAmountMinor: 0,
      matchedAmountMinor: 0,
      outstandingMatchMinor: event.payload.amountMinor,
      matchedCaseIds: [],
      postingRef: null,
      externalStatus: null,
      failure: null,
      floatAccountRef: null,
      availableFloatMinor: null,
      proposedAt: event.occurredAt,
      approvedAt: null,
      initiatedAt: null,
      confirmedAt: null,
      reversedAt: null,
      retriedAt: null,
    };
    claim.status = "AWAITING_SETTLEMENT_CHECKER";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applyApprovalRequested(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.approvalRequest = {
      ...event.payload,
      status: "PENDING",
      requestedAt: event.occurredAt,
      approvedAt: null,
    };
    claim.status = "AWAITING_SETTLEMENT_CHECKER";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applyApprovalGranted(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (claim.approvalRequest) {
      claim.approvalRequest = {
        ...claim.approvalRequest,
        ...event.payload,
        status: "GRANTED",
        approvedAt: event.occurredAt,
      };
    }
    if (claim.settlement) {
      claim.settlement.workflowStatus = "APPROVED";
      claim.settlement.approvedAt = event.occurredAt;
      claim.settlement.checkerActorId = event.payload.checkerActorId;
    }
    claim.status = "SETTLEMENT_APPROVED";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementInitiated(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.state = "initiated";
    claim.settlement.attemptCount = Math.max(claim.settlement.attemptCount ?? 0, event.payload.attemptNumber);
    claim.settlement.lastAttemptId = event.payload.attemptId;
    claim.settlement.floatAccountRef = event.payload.floatAccountRef;
    claim.settlement.availableFloatMinor = event.payload.availableFloatMinor;
    claim.settlement.initiatedAt = event.occurredAt;
    claim.settlement.pendingReason = null;
    claim.settlement.nextReviewAt = null;
    claim.settlement.failure = null;
    claim.status = "SETTLEMENT_INITIATED";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementPendingProvider(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.state = "pending_provider";
    claim.settlement.lastAttemptId = event.payload.attemptId;
    claim.settlement.providerReference = event.payload.providerReference;
    claim.settlement.pendingReason = event.payload.reason;
    claim.settlement.nextReviewAt = event.payload.nextReviewAt ?? null;
    claim.settlement.failure = null;
    claim.status = "AWAITING_PROVIDER_CONFIRMATION";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementConfirmed(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.state = "confirmed";
    claim.settlement.lastAttemptId = event.payload.attemptId;
    claim.settlement.providerReference = event.payload.providerReference;
    claim.settlement.confirmedAmountMinor = event.payload.confirmedAmountMinor;
    claim.settlement.confirmedAt = event.occurredAt;
    claim.settlement.providerConfirmedAt = event.payload.providerConfirmedAt;
    claim.settlement.externalStatus = event.payload.externalStatus;
    claim.settlement.pendingReason = null;
    claim.settlement.nextReviewAt = null;
    claim.settlement.failure = null;
    this.#syncConfirmedSettlementState(claim, event.occurredAt);
    claim.version = event.aggregateVersion;
  }

  #applySettlementFailed(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.state = "failed";
    claim.settlement.lastAttemptId = event.payload.attemptId;
    claim.settlement.attemptCount = Math.max(claim.settlement.attemptCount ?? 0, event.payload.attemptNumber);
    claim.settlement.availableFloatMinor = event.payload.availableFloatMinor ?? claim.settlement.availableFloatMinor;
    claim.settlement.pendingReason = null;
    claim.settlement.nextReviewAt = null;
    claim.settlement.failure = {
      ...event.payload,
      failedAt: event.occurredAt,
    };
    claim.status = "SETTLEMENT_FAILED";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementRetried(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.state = "retried";
    claim.settlement.attemptCount = Math.max(claim.settlement.attemptCount ?? 0, event.payload.nextAttemptNumber);
    claim.settlement.retriedAt = event.occurredAt;
    claim.settlement.pendingReason = null;
    claim.settlement.nextReviewAt = null;
    claim.settlement.failure = null;
    claim.status = "SETTLEMENT_RETRIED";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementReversed(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.state = "reversed";
    claim.settlement.reversedAt = event.occurredAt;
    claim.settlement.reversal = event.payload;
    claim.settlement.outstandingMatchMinor = 0;
    claim.settlement.pendingReason = null;
    claim.settlement.nextReviewAt = null;
    claim.settlement.failure = null;
    claim.reconciliation.status = "REVERSED";
    claim.status = "SETTLEMENT_REVERSED";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementRecorded(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (!claim.settlement) {
      return;
    }
    claim.settlement.workflowStatus = "APPROVED";
    claim.settlement.state = "confirmed";
    claim.settlement.postingRef = event.payload.postingRef;
    claim.settlement.confirmedAmountMinor = event.payload.amountMinor;
    claim.settlement.confirmedAt = event.occurredAt;
    claim.settlement.providerConfirmedAt = event.occurredAt;
    claim.settlement.externalStatus = event.payload.externalStatus;
    this.#syncConfirmedSettlementState(claim, event.occurredAt);
    claim.version = event.aggregateVersion;
  }

  #applyLedgerEntry(event) {
    this.ledgerEntries.unshift({
      claimId: event.aggregateId,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      entryType: event.payload.entryType,
      currency: event.payload.currency,
      lines: event.payload.lines,
    });

    const claim = this.claims.get(event.aggregateId);
    if (claim) {
      claim.updatedAt = event.occurredAt;
      claim.version = event.aggregateVersion;
    }
  }

  #applyReconciliationBatch(event) {
    this.batches.set(event.aggregateId, {
      batchId: event.aggregateId,
      sourceSystem: event.payload.sourceSystem,
      accountRef: event.payload.accountRef,
      statementDate: event.payload.statementDate,
      lineCount: event.payload.lineCount,
      digest: event.payload.digest,
      caseIds: [],
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      version: event.aggregateVersion,
    });
  }

  #applyStatementLine(event) {
    const nextCase = {
      caseId: event.aggregateId,
      batchId: event.payload.batchId,
      lineId: event.payload.lineId,
      externalReference: event.payload.externalReference,
      narrative: event.payload.narrative,
      amountMinor: event.payload.amountMinor,
      currency: event.payload.currency,
      direction: event.payload.direction,
      valueDate: event.payload.valueDate,
      channelType: event.payload.channelType,
      claimId: null,
      settlementId: null,
      status: "OPEN",
      candidate: null,
      exception: null,
      resolution: null,
      matchedAmountMinor: 0,
      remainingAmountMinor: event.payload.amountMinor,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt,
    };
    this.cases.set(event.aggregateId, nextCase);
    const batch = this.batches.get(event.payload.batchId);
    if (batch && !batch.caseIds.includes(event.aggregateId)) {
      batch.caseIds.push(event.aggregateId);
      batch.updatedAt = event.occurredAt;
    }
  }

  #applyMatchCandidate(event) {
    const item = this.#ensureCase(event.aggregateId);
    item.claimId = event.payload.claimId;
    item.settlementId = event.payload.settlementId;
    item.candidate = {
      matchType: event.payload.matchType,
      confidence: event.payload.confidence,
      createdAt: event.occurredAt,
    };
    item.updatedAt = event.occurredAt;
    item.version = event.aggregateVersion;
  }

  #applyAutoMatch(event) {
    const item = this.#ensureCase(event.aggregateId);
    const matchedAmountMinor = event.payload.matchedAmountMinor ?? item.amountMinor ?? 0;
    const delta = matchedAmountMinor - (item.matchedAmountMinor ?? 0);
    item.claimId = event.payload.claimId;
    item.settlementId = event.payload.settlementId;
    item.status = "MATCHED";
    item.matchedAmountMinor = matchedAmountMinor;
    item.remainingAmountMinor = 0;
    item.exception = null;
    item.resolution = null;
    item.updatedAt = event.occurredAt;
    item.version = event.aggregateVersion;

    const claim = this.claims.get(event.payload.claimId);
    if (claim) {
      pushUnique(claim.reconciliation.caseIds, item.caseId);
      if (claim.settlement) {
        claim.settlement.matchedAmountMinor += Math.max(delta, 0);
        pushUnique(claim.settlement.matchedCaseIds, item.caseId);
        this.#syncConfirmedSettlementState(claim, event.occurredAt);
      }
      claim.updatedAt = event.occurredAt;
    }
  }

  #applyPartialMatch(event) {
    const item = this.#ensureCase(event.aggregateId);
    const delta = event.payload.matchedAmountMinor - (item.matchedAmountMinor ?? 0);
    item.claimId = event.payload.claimId;
    item.settlementId = event.payload.settlementId;
    item.status = "PARTIAL_MATCHED";
    item.matchedAmountMinor = event.payload.matchedAmountMinor;
    item.remainingAmountMinor = event.payload.remainingAmountMinor;
    item.exception = null;
    item.resolution = null;
    item.updatedAt = event.occurredAt;
    item.version = event.aggregateVersion;

    const claim = this.claims.get(event.payload.claimId);
    if (claim) {
      pushUnique(claim.reconciliation.caseIds, item.caseId);
      if (claim.settlement) {
        claim.settlement.matchedAmountMinor += Math.max(delta, 0);
        pushUnique(claim.settlement.matchedCaseIds, item.caseId);
        this.#syncConfirmedSettlementState(claim, event.occurredAt);
      }
      claim.updatedAt = event.occurredAt;
    }
  }

  #applyExceptionOpened(event) {
    const item = this.#ensureCase(event.aggregateId);
    item.batchId = event.payload.batchId ?? item.batchId;
    item.lineId = event.payload.lineId ?? item.lineId;
    item.claimId = event.payload.claimId ?? item.claimId;
    item.settlementId = event.payload.settlementId ?? item.settlementId;
    item.status = "EXCEPTION";
    item.exception = {
      code: event.payload.code,
      severity: event.payload.severity,
      reason: event.payload.reason,
      openedAt: event.occurredAt,
    };
    item.resolution = null;
    item.updatedAt = event.occurredAt;
    item.version = event.aggregateVersion;

    if (item.claimId) {
      const claim = this.claims.get(item.claimId);
      if (claim) {
        claim.reconciliation.status = "EXCEPTION";
        pushUnique(claim.reconciliation.caseIds, item.caseId);
        claim.status = "RECON_EXCEPTION";
        claim.updatedAt = event.occurredAt;
      }
    }
  }

  #applyExceptionResolved(event) {
    const item = this.#ensureCase(event.aggregateId);
    item.status = "RESOLVED";
    item.resolution = {
      code: event.payload.resolutionCode,
      note: event.payload.resolutionNote,
      resolvedAt: event.occurredAt,
    };
    item.updatedAt = event.occurredAt;
    item.version = event.aggregateVersion;

    if (item.claimId) {
      const claim = this.claims.get(item.claimId);
      if (claim) {
        const stillOpen = [...this.cases.values()].some(
          (entry) => entry.claimId === item.claimId && entry.status === "EXCEPTION",
        );
        if (!stillOpen) {
          if (claim.settlement?.state === "reversed") {
            claim.reconciliation.status = "REVERSED";
            claim.status = "SETTLEMENT_REVERSED";
          } else if (claim.settlement?.state === "confirmed") {
            this.#syncConfirmedSettlementState(claim, event.occurredAt);
          } else {
            claim.reconciliation.status = "PENDING";
          }
        }
        claim.updatedAt = event.occurredAt;
      }
    }
  }

  hasCommand(commandId) {
    return this.commandIds.has(commandId);
  }

  getClaim(claimId) {
    const claim = this.claims.get(claimId);
    return claim ? clone(claim) : null;
  }

  getCase(caseId) {
    const item = this.cases.get(caseId);
    return item ? clone(item) : null;
  }

  getBatch(batchId) {
    const batch = this.batches.get(batchId);
    return batch ? clone(batch) : null;
  }

  listClaims() {
    return [...this.claims.values()].map(clone).sort(byNewest);
  }

  listCases() {
    return [...this.cases.values()].map(clone).sort(byNewest);
  }

  listBatches() {
    return [...this.batches.values()].map(clone).sort(byNewest);
  }

  listLedgerEntries(limit = 25) {
    return this.ledgerEntries.slice(0, limit).map(clone);
  }

  listEvents(limit = 50) {
    return this.events.slice(-limit).reverse().map(clone);
  }

  getDashboard() {
    const claims = [...this.claims.values()];
    const cases = [...this.cases.values()];
    const reserveTotalMinor = this.ledgerEntries
      .filter((entry) => entry.entryType === "CLAIM_RESERVE")
      .reduce((sum, entry) => sum + entry.lines.reduce((lineSum, line) => lineSum + line.debitMinor, 0), 0);
    const payoutTotalMinor = this.ledgerEntries
      .filter((entry) => entry.entryType === "CLAIM_PAYOUT")
      .reduce((sum, entry) => sum + entry.lines.reduce((lineSum, line) => lineSum + line.debitMinor, 0), 0);
    const payoutReversalTotalMinor = this.ledgerEntries
      .filter((entry) => entry.entryType === "CLAIM_PAYOUT_REVERSAL")
      .reduce((sum, entry) => sum + entry.lines.reduce((lineSum, line) => lineSum + line.debitMinor, 0), 0);

    return {
      totalClaims: claims.length,
      awaitingChecker: claims.filter((claim) => claim.status === "AWAITING_SETTLEMENT_CHECKER").length,
      settledPendingReconciliation: claims.filter((claim) => claim.status === "SETTLED_PENDING_RECON").length,
      reconciledClaims: claims.filter((claim) => claim.status === "RECONCILED").length,
      openExceptions: cases.filter((item) => item.status === "EXCEPTION").length,
      pendingProviderSettlements: claims.filter((claim) => claim.settlement?.state === "pending_provider").length,
      failedSettlements: claims.filter((claim) => claim.settlement?.state === "failed").length,
      reversedSettlements: claims.filter((claim) => claim.settlement?.state === "reversed").length,
      reserveTotalMinor,
      payoutTotalMinor,
      payoutReversalTotalMinor,
      integrity: this.integrity,
    };
  }

  getSnapshot() {
    return {
      integrity: this.integrity,
      dashboard: this.getDashboard(),
      claims: this.listClaims(),
      reconciliation: {
        batches: this.listBatches(),
        cases: this.listCases(),
        openExceptions: this.listCases().filter((item) => item.status === "EXCEPTION"),
      },
      ledgerEntries: this.listLedgerEntries(),
      recentEvents: this.listEvents(),
    };
  }
}
