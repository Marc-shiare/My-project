import { clone } from "../lib/json.mjs";

function byNewest(a, b) {
  return b.updatedAt.localeCompare(a.updatedAt);
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
    if (!current) {
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
        version: 0,
        updatedAt: new Date(0).toISOString(),
      };
      this.cases.set(caseId, fallback);
      return fallback;
    }
    return current;
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
      status: "PROPOSED",
      proposedAt: event.occurredAt,
      approvedAt: null,
      recordedAt: null,
      postingRef: null,
      externalStatus: null,
      matchedCaseId: null,
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
      claim.settlement.status = "APPROVED";
      claim.settlement.approvedAt = event.occurredAt;
      claim.settlement.checkerActorId = event.payload.checkerActorId;
    }
    claim.status = "SETTLEMENT_APPROVED";
    claim.updatedAt = event.occurredAt;
    claim.version = event.aggregateVersion;
  }

  #applySettlementRecorded(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    if (claim.settlement) {
      claim.settlement.status = "RECORDED";
      claim.settlement.postingRef = event.payload.postingRef;
      claim.settlement.recordedAt = event.occurredAt;
      claim.settlement.externalStatus = event.payload.externalStatus;
    }
    claim.status = "SETTLED_PENDING_RECON";
    claim.updatedAt = event.occurredAt;
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
    item.claimId = event.payload.claimId;
    item.settlementId = event.payload.settlementId;
    item.status = "MATCHED";
    item.exception = null;
    item.resolution = null;
    item.updatedAt = event.occurredAt;
    item.version = event.aggregateVersion;

    const claim = this.claims.get(event.payload.claimId);
    if (claim) {
      claim.reconciliation.status = "MATCHED";
      if (!claim.reconciliation.caseIds.includes(item.caseId)) {
        claim.reconciliation.caseIds.push(item.caseId);
      }
      if (claim.settlement) {
        claim.settlement.matchedCaseId = item.caseId;
      }
      claim.status = "RECONCILED";
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
        if (!claim.reconciliation.caseIds.includes(item.caseId)) {
          claim.reconciliation.caseIds.push(item.caseId);
        }
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

    return {
      totalClaims: claims.length,
      awaitingChecker: claims.filter((claim) => claim.status === "AWAITING_SETTLEMENT_CHECKER").length,
      settledPendingReconciliation: claims.filter((claim) => claim.status === "SETTLED_PENDING_RECON").length,
      reconciledClaims: claims.filter((claim) => claim.status === "RECONCILED").length,
      openExceptions: cases.filter((item) => item.status === "EXCEPTION").length,
      reserveTotalMinor,
      payoutTotalMinor,
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
