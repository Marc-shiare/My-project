import { createHash } from "node:crypto";

import { createManualAdapters } from "../adapters/ports.mjs";
import { createId, ensureCommandId } from "../lib/ids.mjs";
import { stableSerialize } from "../lib/json.mjs";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.mjs";
import {
  ensureActor,
  ensureCurrency,
  ensureEnum,
  ensureHasRole,
  ensureInteger,
  ensureIsoDate,
  ensureObject,
  ensureOptionalString,
  ensureString,
  ensureStringArray,
} from "../lib/validation.mjs";
import { SettlementMatchingEngine } from "../reconciliation/settlement-matching-engine.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLEMENT_FAILURE_CODES = [
  "API_FAILURE",
  "DUPLICATE_TRANSACTION",
  "INSUFFICIENT_FLOAT",
  "PROVIDER_REJECTED",
  "PENDING_TIMEOUT",
];

function money(amountMinor, currency) {
  return {
    amountMinor: ensureInteger(amountMinor, "amountMinor", { min: 0 }),
    currency: ensureCurrency(currency),
  };
}

function claimLedgerLines(claimId, amountMinor) {
  return [
    { account: "Claims Expense", debitMinor: amountMinor, creditMinor: 0, reference: claimId },
    { account: "Claims Reserve", debitMinor: 0, creditMinor: amountMinor, reference: claimId },
  ];
}

function payoutLedgerLines(claimId, amountMinor) {
  return [
    { account: "Claims Reserve", debitMinor: amountMinor, creditMinor: 0, reference: claimId },
    { account: "Cash At Bank", debitMinor: 0, creditMinor: amountMinor, reference: claimId },
  ];
}

function payoutReversalLedgerLines(claimId, amountMinor) {
  return [
    { account: "Cash At Bank", debitMinor: amountMinor, creditMinor: 0, reference: claimId },
    { account: "Claims Reserve", debitMinor: 0, creditMinor: amountMinor, reference: claimId },
  ];
}

function settlementConfirmedAmount(settlement) {
  return settlement.confirmedAmountMinor > 0 ? settlement.confirmedAmountMinor : settlement.amountMinor;
}

function normalizeStatementLine(line, field) {
  const value = ensureObject(line, field);
  return {
    lineId: ensureOptionalString(value.lineId, `${field}.lineId`, { max: 80 }) ?? createId("line"),
    externalReference: ensureString(value.externalReference, `${field}.externalReference`, { max: 120 }),
    narrative: ensureString(value.narrative ?? value.externalReference, `${field}.narrative`, { max: 240 }),
    amountMinor: ensureInteger(value.amountMinor, `${field}.amountMinor`, { min: 0 }),
    currency: ensureCurrency(value.currency ?? "KES"),
    direction: ensureEnum(value.direction, `${field}.direction`, ["DEBIT", "CREDIT"]),
    valueDate: ensureIsoDate(value.valueDate, `${field}.valueDate`),
    channelType: ensureEnum(value.channelType ?? "UNKNOWN", `${field}.channelType`, [
      "BANK_TRANSFER",
      "MOBILE_MONEY",
      "CARD_REVERSAL",
      "CHEQUE",
      "UNKNOWN",
    ]),
  };
}

export class ClaimsPlatform {
  constructor({
    eventStore,
    projections,
    adapters = createManualAdapters(),
    checkpointStore = null,
    projectionName = "claims-platform",
    checkpointEvery = 100,
    matchingEngine = new SettlementMatchingEngine(),
  }) {
    this.eventStore = eventStore;
    this.projections = projections;
    this.adapters = adapters;
    this.checkpointStore = checkpointStore;
    this.projectionName = projectionName;
    this.checkpointEvery = checkpointEvery;
    this.lastCheckpointPosition = 0;
    this.matchingEngine = matchingEngine;
  }

  async init() {
    await this.eventStore.init();
    const integrity = this.eventStore.verifyIntegrity();
    const checkpoint = this.checkpointStore ? await this.checkpointStore.load(this.projectionName) : null;
    if (checkpoint && checkpoint.lastGlobalPosition <= this.#getLastGlobalPosition()) {
      this.projections.restoreState(checkpoint.snapshot, checkpoint.integrity ?? integrity);
      this.projections.applyEvents(this.eventStore.getEventsAfter(checkpoint.lastGlobalPosition));
      this.lastCheckpointPosition = checkpoint.lastGlobalPosition;
      return;
    }

    this.projections.rebuild(this.eventStore.getEvents(), integrity);
    this.lastCheckpointPosition = this.#getLastGlobalPosition();
  }

  getSnapshot() {
    this.projections.integrity = this.eventStore.verifyIntegrity();
    return this.projections.getSnapshot();
  }

  async submitClaim(command) {
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["CLAIMS_MAKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, claim: null };
    }

    const body = ensureObject(command.body, "body");
    const claimId = ensureOptionalString(body.claimId, "claimId", { max: 80 }) ?? createId("clm");
    const payload = {
      tenantId: ensureString(body.tenantId, "tenantId", { max: 80 }),
      policyRef: ensureString(body.policyRef, "policyRef", { max: 80 }),
      memberRef: ensureString(body.memberRef, "memberRef", { max: 80 }),
      providerRef: ensureString(body.providerRef, "providerRef", { max: 80 }),
      incidentDate: ensureIsoDate(body.incidentDate, "incidentDate"),
      ...money(body.amountMinor, body.currency ?? "KES"),
      narrative: ensureString(body.narrative, "narrative", { max: 400 }),
      source: ensureString(body.source ?? "WEB_PORTAL", "source", { max: 80 }),
    };

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: 0,
      actor,
      commandId,
      correlationId: claimId,
      events: [{ eventType: "ClaimSubmitted", payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async validateClaim(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["CLAIMS_CHECKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const payload = {
      outcome: ensureEnum(body.outcome, "outcome", ["VALID", "NEEDS_INFO", "REJECTED"]),
      findings: ensureStringArray(body.findings ?? [], "findings"),
      duplicateCheckKey: ensureString(body.duplicateCheckKey ?? `${claim.policyRef}:${claim.memberRef}:${claim.incidentDate}`, "duplicateCheckKey", {
        max: 120,
      }),
    };

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [{ eventType: "ClaimValidated", payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async adjudicateClaim(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["CLAIMS_CHECKER"]);
    if (!claim.validation || claim.validation.outcome !== "VALID") {
      throw new ConflictError("Claim must be validated before adjudication.");
    }

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const decision = ensureEnum(body.decision, "decision", ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"]);
    const approvedAmountMinor =
      decision === "REJECTED"
        ? 0
        : ensureInteger(body.approvedAmountMinor ?? claim.amountMinor, "approvedAmountMinor", { min: 0, max: claim.amountMinor });
    const reserveAmountMinor =
      decision === "REJECTED" ? 0 : ensureInteger(body.reserveAmountMinor ?? approvedAmountMinor, "reserveAmountMinor", { min: 0 });
    const events = [
      {
        eventType: "ClaimAdjudicated",
        payload: {
          decision,
          approvedAmountMinor,
          reserveAmountMinor,
          reasonCodes: ensureStringArray(body.reasonCodes ?? [], "reasonCodes"),
        },
      },
    ];

    if (decision !== "REJECTED" && reserveAmountMinor > 0) {
      events.push({
        eventType: "LedgerEntryPosted",
        payload: {
          entryType: "CLAIM_RESERVE",
          currency: claim.currency,
          lines: claimLedgerLines(claimId, reserveAmountMinor),
        },
      });
    }

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events,
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async proposeSettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_MAKER"]);
    if (!claim.adjudication || !["APPROVED", "PARTIALLY_APPROVED"].includes(claim.adjudication.decision)) {
      throw new ConflictError("Claim must be approved before settlement can be proposed.");
    }
    if (claim.settlement && claim.settlement.state !== "reversed") {
      throw new ConflictError("Settlement is already present for this claim.");
    }

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const settlementId = createId("stl");
    const requestId = createId("apr");
    const amountMinor = ensureInteger(body.amountMinor ?? claim.adjudication.approvedAmountMinor, "amountMinor", {
      min: 0,
      max: claim.adjudication.approvedAmountMinor,
    });

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [
        {
          eventType: "SettlementProposed",
          payload: {
            settlementId,
            channelType: ensureEnum(body.channelType ?? "BANK_TRANSFER", "channelType", [
              "BANK_TRANSFER",
              "MOBILE_MONEY",
              "CARD_REVERSAL",
              "CHEQUE",
            ]),
            beneficiaryRef: ensureString(body.beneficiaryRef, "beneficiaryRef", { max: 120 }),
            paymentReference: ensureString(body.paymentReference, "paymentReference", { max: 120 }),
            amountMinor,
            currency: claim.currency,
            makerNote: ensureString(body.makerNote ?? "Prepared for controlled release.", "makerNote", { max: 240 }),
            makerActorId: actor.actorId,
          },
        },
        {
          eventType: "ApprovalRequested",
          payload: {
            requestId,
            action: "SETTLEMENT_RELEASE",
            makerActorId: actor.actorId,
            checkerRole: "FINANCE_CHECKER",
          },
        },
      ],
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async approveSettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    if (!claim.settlement || !claim.approvalRequest) {
      throw new ConflictError("There is no settlement awaiting approval.");
    }
    if (claim.settlement.makerActorId === actor.actorId) {
      throw new ConflictError("Maker-checker violation: the settlement maker cannot approve the same release.");
    }

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [
        {
          eventType: "ApprovalGranted",
          payload: {
            requestId: claim.approvalRequest.requestId,
            checkerActorId: actor.actorId,
            approvalNote: ensureString(body.approvalNote ?? "Dual control satisfied.", "approvalNote", { max: 240 }),
          },
        },
      ],
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async initiateSettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    this.#requireApprovedSettlement(claim);

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const attemptId = ensureOptionalString(body.attemptId, "attemptId", { max: 80 }) ?? createId("stla");
    const attemptNumber = (claim.settlement.attemptCount ?? 0) + 1;
    const events = await this.#buildDispatchAttemptEvents({
      claim,
      actor,
      attemptId,
      attemptNumber,
    });

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events,
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async recordSettlement(claimId, command) {
    return this.initiateSettlement(claimId, command);
  }

  async refreshSettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER", "SYSTEM"]);
    this.#requirePendingSettlement(claim);

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    let outcome;
    try {
      outcome = await this.adapters.settlementChannelPort.pollSettlement({
        settlementId: claim.settlement.settlementId,
        attemptId: claim.settlement.lastAttemptId,
        providerReference: claim.settlement.providerReference,
        paymentReference: claim.settlement.paymentReference,
        amountMinor: claim.settlement.amountMinor,
        currency: claim.currency,
        channelType: claim.settlement.channelType,
      });
    } catch (error) {
      outcome = {
        providerStatus: "pending_provider",
        providerReference: claim.settlement.providerReference ?? claim.settlement.paymentReference,
        reason: `Settlement status refresh failed: ${error.message}`,
        nextReviewAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
    }

    const events = this.#buildSettlementOutcomeEvents({
      claim,
      attemptId: claim.settlement.lastAttemptId,
      attemptNumber: claim.settlement.attemptCount ?? 1,
      outcome,
    });

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events,
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async retrySettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    this.#requireFailedSettlement(claim);

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const attemptId = ensureOptionalString(body.attemptId, "attemptId", { max: 80 }) ?? createId("stla");
    const attemptNumber = (claim.settlement.attemptCount ?? 0) + 1;
    const retryReason = ensureString(body.reason ?? "Retry requested after operational failure.", "reason", { max: 240 });
    const events = [
      {
        eventType: "SettlementRetried",
        payload: {
          settlementId: claim.settlement.settlementId,
          previousAttemptNumber: Math.max(claim.settlement.attemptCount ?? 1, 1),
          nextAttemptNumber: attemptNumber,
          reason: retryReason,
        },
      },
      ...(await this.#buildDispatchAttemptEvents({
        claim,
        actor,
        attemptId,
        attemptNumber,
      })),
    ];

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events,
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async reverseSettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    this.#requireConfirmedSettlement(claim);

    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { claim: this.projections.getClaim(claimId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const reason = ensureString(body.reason, "reason", { max: 240 });
    const reversal = await this.adapters.settlementChannelPort.reverseSettlement({
      settlementId: claim.settlement.settlementId,
      paymentReference: claim.settlement.paymentReference,
      providerReference: claim.settlement.providerReference,
      amountMinor: settlementConfirmedAmount(claim.settlement),
      currency: claim.currency,
      channelType: claim.settlement.channelType,
    });

    const reversedAmountMinor = ensureInteger(
      reversal.reversedAmountMinor ?? settlementConfirmedAmount(claim.settlement),
      "reversedAmountMinor",
      { min: 1, max: settlementConfirmedAmount(claim.settlement) },
    );

    const result = await this.eventStore.append({
      aggregateType: "claim",
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [
        {
          eventType: "SettlementReversed",
          payload: {
            settlementId: claim.settlement.settlementId,
            reversalId: ensureOptionalString(body.reversalId, "reversalId", { max: 80 }) ?? createId("reversal"),
            providerReference: reversal.providerReference ?? claim.settlement.providerReference,
            reversedAmountMinor,
            currency: claim.currency,
            reason,
            reversedAt: reversal.reversedAt ?? new Date().toISOString(),
          },
        },
        {
          eventType: "LedgerEntryPosted",
          payload: {
            entryType: "CLAIM_PAYOUT_REVERSAL",
            currency: claim.currency,
            lines: payoutReversalLedgerLines(claimId, reversedAmountMinor),
          },
        },
      ],
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
  }

  async refreshPendingSettlements(command) {
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER", "SYSTEM"]);

    let confirmed = 0;
    let stillPending = 0;
    let failed = 0;

    const claims = this.projections
      .listClaims()
      .filter((claim) => claim.settlement && claim.settlement.state === "pending_provider");

    for (const claim of claims) {
      let outcome;
      try {
        outcome = await this.adapters.settlementChannelPort.pollSettlement({
          settlementId: claim.settlement.settlementId,
          attemptId: claim.settlement.lastAttemptId,
          providerReference: claim.settlement.providerReference,
          paymentReference: claim.settlement.paymentReference,
          amountMinor: claim.settlement.amountMinor,
          currency: claim.currency,
          channelType: claim.settlement.channelType,
        });
      } catch (error) {
        outcome = {
          providerStatus: "pending_provider",
          providerReference: claim.settlement.providerReference ?? claim.settlement.paymentReference,
          reason: `Settlement status refresh failed: ${error.message}`,
          nextReviewAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };
      }

      const events = this.#buildSettlementOutcomeEvents({
        claim,
        attemptId: claim.settlement.lastAttemptId,
        attemptNumber: claim.settlement.attemptCount ?? 1,
        outcome,
      });

      const result = await this.eventStore.append({
        aggregateType: "claim",
        aggregateId: claim.claimId,
        expectedVersion: claim.version,
        actor,
        commandId: undefined,
        correlationId: claim.claimId,
        events,
      });
      await this.#applyAndCheckpoint(result.events);

      if (outcome.providerStatus === "confirmed") {
        confirmed += 1;
      } else if (outcome.providerStatus === "pending_provider") {
        stillPending += 1;
      } else {
        failed += 1;
      }
    }

    return {
      confirmed,
      stillPending,
      failed,
      processedAt: new Date().toISOString(),
    };
  }

  async importReconciliationBatch(command) {
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["RECON_ANALYST"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, batch: null };
    }

    const body = ensureObject(command.body ?? {}, "body");
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new ValidationError("body.lines must be a non-empty array.");
    }

    const requestedLines = body.lines.map((line, index) => normalizeStatementLine(line, `lines[${index}]`));
    const importedLines = await this.adapters.statementImportPort.ingestBatch(requestedLines);
    if (!Array.isArray(importedLines) || importedLines.length === 0) {
      throw new ValidationError("Imported statement lines must be a non-empty array.");
    }

    const normalizedLines = importedLines.map((line, index) => normalizeStatementLine(line, `importedLines[${index}]`));
    const batchId = createId("rcb");
    const digest = createHash("sha256").update(stableSerialize(normalizedLines)).digest("hex");
    const batchResult = await this.eventStore.append({
      aggregateType: "reconciliation_batch",
      aggregateId: batchId,
      expectedVersion: 0,
      actor,
      commandId,
      correlationId: batchId,
      events: [
        {
          eventType: "ReconciliationBatchImported",
          payload: {
            batchId,
            sourceSystem: ensureString(body.sourceSystem ?? "MANUAL_IMPORT", "sourceSystem", { max: 120 }),
            accountRef: ensureString(body.accountRef, "accountRef", { max: 120 }),
            statementDate: ensureIsoDate(body.statementDate, "statementDate"),
            lineCount: normalizedLines.length,
            digest,
          },
        },
      ],
    });
    await this.#applyAndCheckpoint(batchResult.events);

    for (const line of normalizedLines) {
      const caseId = createId("rcc");
      const lineResult = await this.eventStore.append({
        aggregateType: "reconciliation_case",
        aggregateId: caseId,
        expectedVersion: 0,
        actor,
        commandId: undefined,
        correlationId: batchId,
        causationId: commandId,
        events: [
          {
            eventType: "StatementLineRecorded",
            payload: {
              caseId,
              batchId,
              lineId: line.lineId,
              externalReference: line.externalReference,
              narrative: line.narrative,
              amountMinor: line.amountMinor,
              currency: line.currency,
              direction: line.direction,
              valueDate: line.valueDate,
              channelType: line.channelType,
            },
          },
        ],
      });
      await this.#applyAndCheckpoint(lineResult.events);
    }

    return { batch: this.projections.getBatch(batchId), deduplicated: false };
  }

  async runSelfHealing(command) {
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["RECON_ANALYST", "SYSTEM"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, summary: this.#buildSelfHealSummary(0, 0, 0) };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const maxAgeDays = ensureInteger(body.maxAgeDays ?? 2, "maxAgeDays", { min: 1, max: 30 });
    const now = new Date(body.asAt ?? new Date().toISOString());
    if (Number.isNaN(now.getTime())) {
      throw new ValidationError("body.asAt must be a valid ISO timestamp when supplied.");
    }

    let autoMatches = 0;
    let partialMatches = 0;
    let exceptionsOpened = 0;

    const allLineCases = this.projections.listCases().filter((item) => item.lineId);
    const duplicateCaseIds = this.matchingEngine.findDuplicateCaseIds(allLineCases);
    const openCases = allLineCases
      .filter((item) => item.status === "OPEN")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    let claims = this.projections.listClaims();

    for (const item of openCases) {
      const evaluation = this.matchingEngine.evaluateCase(item, claims, duplicateCaseIds);
      if (evaluation.outcome === "ignore") {
        continue;
      }

      let events;
      if (evaluation.outcome === "full_match") {
        events = [
          {
            eventType: "MatchCandidateGenerated",
            payload: {
              caseId: item.caseId,
              claimId: evaluation.claimId,
              settlementId: evaluation.settlementId,
              matchType: evaluation.matchType,
              confidence: evaluation.confidence,
            },
          },
          {
            eventType: "AutoMatchApplied",
            payload: {
              caseId: item.caseId,
              claimId: evaluation.claimId,
              settlementId: evaluation.settlementId,
              matchedAmountMinor: evaluation.matchedAmountMinor,
              reason: evaluation.reason,
            },
          },
        ];
        autoMatches += 1;
      } else if (evaluation.outcome === "partial_match") {
        events = [
          {
            eventType: "MatchCandidateGenerated",
            payload: {
              caseId: item.caseId,
              claimId: evaluation.claimId,
              settlementId: evaluation.settlementId,
              matchType: evaluation.matchType,
              confidence: evaluation.confidence,
            },
          },
          {
            eventType: "PartialMatchApplied",
            payload: {
              caseId: item.caseId,
              claimId: evaluation.claimId,
              settlementId: evaluation.settlementId,
              matchedAmountMinor: evaluation.matchedAmountMinor,
              cumulativeMatchedAmountMinor: evaluation.cumulativeMatchedAmountMinor,
              remainingAmountMinor: evaluation.remainingAmountMinor,
              reason: evaluation.reason,
            },
          },
        ];
        partialMatches += 1;
      } else {
        events = [
          {
            eventType: "ReconciliationExceptionOpened",
            payload: {
              caseId: item.caseId,
              batchId: item.batchId,
              lineId: item.lineId,
              claimId: evaluation.claimId ?? null,
              settlementId: evaluation.settlementId ?? null,
              code: evaluation.code,
              severity: evaluation.severity,
              reason: evaluation.reason,
            },
          },
        ];
        exceptionsOpened += 1;
      }

      const result = await this.eventStore.append({
        aggregateType: "reconciliation_case",
        aggregateId: item.caseId,
        expectedVersion: item.version,
        actor,
        commandId: undefined,
        correlationId: item.caseId,
        causationId: commandId,
        events,
      });
      await this.#applyAndCheckpoint(result.events);
      claims = this.projections.listClaims();
    }

    const missingCashMovementClaims = this.matchingEngine.findMissingCashMovementClaims(
      this.projections.listClaims(),
      this.projections.listCases(),
      now,
      maxAgeDays,
    );

    for (const claim of missingCashMovementClaims) {
      const existingCase = this.projections
        .listCases()
        .find((item) => item.settlementId === claim.settlement.settlementId && item.exception?.code === "MISSING_CASH_MOVEMENT");
      if (existingCase) {
        continue;
      }

      const caseId = createId("rcc");
      const result = await this.eventStore.append({
        aggregateType: "reconciliation_case",
        aggregateId: caseId,
        expectedVersion: 0,
        actor,
        commandId: undefined,
        correlationId: caseId,
        causationId: commandId,
        events: [
          {
            eventType: "ReconciliationExceptionOpened",
            payload: {
              caseId,
              batchId: null,
              lineId: null,
              claimId: claim.claimId,
              settlementId: claim.settlement.settlementId,
              code: "MISSING_CASH_MOVEMENT",
              severity: "HIGH",
              reason: `No cash movement has been imported within ${maxAgeDays} days of settlement confirmation.`,
            },
          },
        ],
      });
      await this.#applyAndCheckpoint(result.events);
      exceptionsOpened += 1;
    }

    return {
      deduplicated: false,
      summary: this.#buildSelfHealSummary(autoMatches, partialMatches, exceptionsOpened),
    };
  }

  async resolveException(caseId, command) {
    const current = this.projections.getCase(caseId);
    if (!current) {
      throw new NotFoundError(`Reconciliation case ${caseId} was not found.`);
    }
    if (current.status !== "EXCEPTION") {
      throw new ConflictError("Only open exceptions can be resolved.");
    }

    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["RECON_ANALYST", "FINANCE_CHECKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { case: this.projections.getCase(caseId), deduplicated: true };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const result = await this.eventStore.append({
      aggregateType: "reconciliation_case",
      aggregateId: caseId,
      expectedVersion: current.version,
      actor,
      commandId,
      correlationId: caseId,
      events: [
        {
          eventType: "ReconciliationExceptionResolved",
          payload: {
            caseId,
            resolutionCode: ensureEnum(body.resolutionCode ?? "MANUAL_CONFIRMED", "resolutionCode", [
              "MANUAL_CONFIRMED",
              "WRITE_OFF",
              "FALSE_POSITIVE",
              "ESCALATED_EXTERNALLY",
            ]),
            resolutionNote: ensureString(body.resolutionNote ?? "Reviewed and dispositioned by operations.", "resolutionNote", {
              max: 240,
            }),
          },
        },
      ],
    });
    await this.#applyAndCheckpoint(result.events);
    return { case: this.projections.getCase(caseId), deduplicated: false };
  }

  async seedDemo() {
    const roles = {
      claimsMaker: { actorId: "claims-maker-1", displayName: "Claims Maker", roles: ["CLAIMS_MAKER"] },
      claimsChecker: { actorId: "claims-checker-1", displayName: "Claims Checker", roles: ["CLAIMS_CHECKER"] },
      financeMaker: { actorId: "finance-maker-1", displayName: "Finance Maker", roles: ["FINANCE_MAKER"] },
      financeChecker: { actorId: "finance-checker-1", displayName: "Finance Checker", roles: ["FINANCE_CHECKER"] },
      reconAnalyst: { actorId: "recon-analyst-1", displayName: "Recon Analyst", roles: ["RECON_ANALYST"] },
      system: { actorId: "system-bot", displayName: "System Bot", roles: ["SYSTEM"] },
    };

    const existing = this.projections.listClaims().find((claim) => claim.policyRef === "POL-DEMO-001");
    if (existing) {
      return this.getSnapshot();
    }

    const claimOne = await this.submitClaim({
      actor: roles.claimsMaker,
      commandId: "demo-submit-1",
      body: {
        tenantId: "demo-insurer-ke",
        policyRef: "POL-DEMO-001",
        memberRef: "MEM-DEMO-001",
        providerRef: "PROV-NRB-HOSP",
        incidentDate: "2026-04-01",
        amountMinor: 275000,
        currency: "KES",
        narrative: "Outpatient claim awaiting settlement.",
        source: "WEB_PORTAL",
      },
    });
    await this.validateClaim(claimOne.claim.claimId, {
      actor: roles.claimsChecker,
      commandId: "demo-validate-1",
      body: { outcome: "VALID", findings: ["Duplicate check passed."] },
    });
    await this.adjudicateClaim(claimOne.claim.claimId, {
      actor: roles.claimsChecker,
      commandId: "demo-adjudicate-1",
      body: { decision: "APPROVED", approvedAmountMinor: 250000, reserveAmountMinor: 250000, reasonCodes: ["BENEFIT_VALID"] },
    });
    await this.proposeSettlement(claimOne.claim.claimId, {
      actor: roles.financeMaker,
      commandId: "demo-propose-1",
      body: {
        beneficiaryRef: "BENEF-NRB-001",
        paymentReference: "PAY-KE-0001",
        amountMinor: 250000,
        channelType: "BANK_TRANSFER",
        makerNote: "Batch release for hospital reimbursement.",
      },
    });
    await this.approveSettlement(claimOne.claim.claimId, {
      actor: roles.financeChecker,
      commandId: "demo-approve-1",
      body: { approvalNote: "Verified supporting documents and beneficiary reference." },
    });
    await this.initiateSettlement(claimOne.claim.claimId, {
      actor: roles.financeChecker,
      commandId: "demo-initiate-1",
      body: {},
    });

    const claimTwo = await this.submitClaim({
      actor: roles.claimsMaker,
      commandId: "demo-submit-2",
      body: {
        tenantId: "demo-insurer-ke",
        policyRef: "POL-DEMO-002",
        memberRef: "MEM-DEMO-002",
        providerRef: "PROV-MSA-CLINIC",
        incidentDate: "2026-04-02",
        amountMinor: 180000,
        currency: "KES",
        narrative: "Specialist consultation claim.",
        source: "FIELD_OFFLINE_SYNC",
      },
    });
    await this.validateClaim(claimTwo.claim.claimId, {
      actor: roles.claimsChecker,
      commandId: "demo-validate-2",
      body: { outcome: "VALID", findings: ["Provider reference verified."] },
    });
    await this.adjudicateClaim(claimTwo.claim.claimId, {
      actor: roles.claimsChecker,
      commandId: "demo-adjudicate-2",
      body: { decision: "APPROVED", approvedAmountMinor: 180000, reserveAmountMinor: 180000, reasonCodes: ["CONSULTATION_COVERED"] },
    });
    await this.proposeSettlement(claimTwo.claim.claimId, {
      actor: roles.financeMaker,
      commandId: "demo-propose-2",
      body: {
        beneficiaryRef: "BENEF-MSA-001",
        paymentReference: "PAY-KE-0002",
        amountMinor: 180000,
        channelType: "MOBILE_MONEY",
        makerNote: "Provider mobile settlement.",
      },
    });
    await this.approveSettlement(claimTwo.claim.claimId, {
      actor: roles.financeChecker,
      commandId: "demo-approve-2",
      body: { approvalNote: "Beneficiary mobile reference verified." },
    });
    await this.initiateSettlement(claimTwo.claim.claimId, {
      actor: roles.financeChecker,
      commandId: "demo-initiate-2",
      body: {},
    });

    await this.importReconciliationBatch({
      actor: roles.reconAnalyst,
      commandId: "demo-import-batch-1",
      body: {
        sourceSystem: "MANUAL_BANK_UPLOAD",
        accountRef: "KES-OPERATIONS-001",
        statementDate: "2026-04-03",
        lines: [
          {
            externalReference: "PAY-KE-0001",
            narrative: "Hospital reimbursement",
            amountMinor: 250000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "BANK_TRANSFER",
          },
          {
            externalReference: "PAY-KE-0002",
            narrative: "Provider mobile settlement partial one",
            amountMinor: 100000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "MOBILE_MONEY",
          },
          {
            externalReference: "PAY-KE-0002X",
            narrative: "Provider mobile settlement duplicate mismatch",
            amountMinor: 100000,
            currency: "KES",
            direction: "DEBIT",
            valueDate: "2026-04-03",
            channelType: "MOBILE_MONEY",
          },
        ],
      },
    });

    await this.runSelfHealing({
      actor: roles.system,
      commandId: "demo-self-heal-1",
      body: { maxAgeDays: 1, asAt: "2026-04-03T12:00:00.000Z" },
    });

    return this.getSnapshot();
  }

  async #resolveActor(actor) {
    return this.adapters.identityContextPort.resolveActor(ensureActor(actor));
  }

  async #applyAndCheckpoint(events) {
    this.projections.applyEvents(events);
    await this.#maybeCheckpoint();
  }

  #requireClaim(claimId) {
    const claim = this.projections.getClaim(claimId);
    if (!claim) {
      throw new NotFoundError(`Claim ${claimId} was not found.`);
    }
    return claim;
  }

  #requireApprovedSettlement(claim) {
    if (!claim.settlement || claim.settlement.workflowStatus !== "APPROVED") {
      throw new ConflictError("Settlement must be approved before initiation.");
    }
    if (claim.settlement.state && !["failed"].includes(claim.settlement.state)) {
      throw new ConflictError("Settlement is already in progress or completed.");
    }
  }

  #requirePendingSettlement(claim) {
    if (!claim.settlement || claim.settlement.state !== "pending_provider") {
      throw new ConflictError("Settlement must be awaiting provider confirmation before refresh.");
    }
  }

  #requireFailedSettlement(claim) {
    if (!claim.settlement || claim.settlement.state !== "failed") {
      throw new ConflictError("Only failed settlements can be retried.");
    }
    if (claim.settlement.failure && claim.settlement.failure.retryable === false) {
      throw new ConflictError("This settlement failure is marked as non-retryable and requires manual investigation.");
    }
  }

  #requireConfirmedSettlement(claim) {
    if (!claim.settlement || claim.settlement.state !== "confirmed") {
      throw new ConflictError("Only confirmed settlements can be reversed.");
    }
  }

  async #buildDispatchAttemptEvents({ claim, actor, attemptId, attemptNumber }) {
    let floatAvailability;
    try {
      floatAvailability = await this.adapters.settlementChannelPort.checkFloatAvailability({
        channelType: claim.settlement.channelType,
        currency: claim.currency,
      });
    } catch (error) {
      return [
        {
          eventType: "SettlementFailed",
          payload: {
            settlementId: claim.settlement.settlementId,
            attemptId,
            attemptNumber,
            failureCode: "API_FAILURE",
            retryable: true,
            reason: `Float availability check failed: ${error.message}`,
          },
        },
      ];
    }

    const floatAccountRef = ensureString(floatAvailability.floatAccountRef, "floatAccountRef", { max: 160 });
    const availableFloatMinor = ensureInteger(floatAvailability.availableFloatMinor, "availableFloatMinor", { min: 0 });

    if (availableFloatMinor < claim.settlement.amountMinor) {
      return [
        {
          eventType: "SettlementFailed",
          payload: {
            settlementId: claim.settlement.settlementId,
            attemptId,
            attemptNumber,
            failureCode: "INSUFFICIENT_FLOAT",
            retryable: true,
            reason: `Available float ${availableFloatMinor} is below required settlement amount ${claim.settlement.amountMinor}.`,
            availableFloatMinor,
          },
        },
      ];
    }

    const events = [
      {
        eventType: "SettlementInitiated",
        payload: {
          settlementId: claim.settlement.settlementId,
          attemptId,
          attemptNumber,
          channelType: claim.settlement.channelType,
          beneficiaryRef: claim.settlement.beneficiaryRef,
          paymentReference: claim.settlement.paymentReference,
          amountMinor: claim.settlement.amountMinor,
          currency: claim.currency,
          floatAccountRef,
          availableFloatMinor,
          initiatedByActorId: actor.actorId,
        },
      },
    ];

    let outcome;
    try {
      outcome = await this.adapters.settlementChannelPort.initiateSettlement({
        settlementId: claim.settlement.settlementId,
        attemptId,
        attemptNumber,
        beneficiaryRef: claim.settlement.beneficiaryRef,
        paymentReference: claim.settlement.paymentReference,
        amountMinor: claim.settlement.amountMinor,
        currency: claim.currency,
        channelType: claim.settlement.channelType,
      });
    } catch (error) {
      outcome = {
        providerStatus: "failed",
        failureCode: "API_FAILURE",
        retryable: true,
        reason: error.message,
        availableFloatMinor,
      };
    }

    return [...events, ...this.#buildSettlementOutcomeEvents({ claim, attemptId, attemptNumber, outcome })];
  }

  #buildSettlementOutcomeEvents({ claim, attemptId, attemptNumber, outcome }) {
    const settlementId = claim.settlement.settlementId;
    switch (outcome.providerStatus) {
      case "pending_provider":
        return [
          {
            eventType: "SettlementPendingProvider",
            payload: {
              settlementId,
              attemptId,
              providerReference: ensureString(
                outcome.providerReference ?? claim.settlement.providerReference ?? claim.settlement.paymentReference,
                "providerReference",
                { max: 120 },
              ),
              reason: ensureString(outcome.reason ?? "Awaiting provider confirmation.", "reason", { max: 240 }),
              nextReviewAt: ensureOptionalString(outcome.nextReviewAt, "nextReviewAt", { max: 40 }),
            },
          },
        ];
      case "confirmed": {
        const confirmedAmountMinor = ensureInteger(
          outcome.confirmedAmountMinor ?? claim.settlement.amountMinor,
          "confirmedAmountMinor",
          { min: 1, max: claim.settlement.amountMinor },
        );
        return [
          {
            eventType: "SettlementConfirmed",
            payload: {
              settlementId,
              attemptId,
              providerReference: ensureString(
                outcome.providerReference ?? claim.settlement.providerReference ?? claim.settlement.paymentReference,
                "providerReference",
                { max: 120 },
              ),
              confirmedAmountMinor,
              currency: claim.currency,
              providerConfirmedAt: outcome.providerConfirmedAt ?? new Date().toISOString(),
              externalStatus: ensureEnum(
                outcome.externalStatus ?? "POSTED_FROM_ADAPTER",
                "externalStatus",
                ["MANUALLY_CONFIRMED", "POSTED_FROM_ADAPTER", "SIMULATED_CONFIRMATION"],
              ),
            },
          },
          {
            eventType: "LedgerEntryPosted",
            payload: {
              entryType: "CLAIM_PAYOUT",
              currency: claim.currency,
              lines: payoutLedgerLines(claim.claimId, confirmedAmountMinor),
            },
          },
        ];
      }
      default: {
        const failureCode = ensureEnum(outcome.failureCode ?? "PROVIDER_REJECTED", "failureCode", SETTLEMENT_FAILURE_CODES);
        return [
          {
            eventType: "SettlementFailed",
            payload: {
              settlementId,
              attemptId,
              attemptNumber,
              failureCode,
              retryable:
                typeof outcome.retryable === "boolean"
                  ? outcome.retryable
                  : !["DUPLICATE_TRANSACTION", "PROVIDER_REJECTED"].includes(failureCode),
              reason: ensureString(outcome.reason ?? "Settlement failed at the provider boundary.", "reason", { max: 240 }),
              availableFloatMinor: Number.isInteger(outcome.availableFloatMinor) ? outcome.availableFloatMinor : undefined,
            },
          },
        ];
      }
    }
  }

  #buildSelfHealSummary(autoMatches, partialMatches, exceptionsOpened) {
    return {
      autoMatches,
      partialMatches,
      exceptionsOpened,
      generatedAt: new Date().toISOString(),
    };
  }

  #getLastGlobalPosition() {
    if (typeof this.eventStore.getLastGlobalPosition === "function") {
      return this.eventStore.getLastGlobalPosition();
    }
    return this.eventStore.getEvents().length;
  }

  async #maybeCheckpoint(force = false) {
    if (!this.checkpointStore) {
      return;
    }

    const currentPosition = this.#getLastGlobalPosition();
    if (!force && currentPosition - this.lastCheckpointPosition < this.checkpointEvery) {
      return;
    }

    await this.checkpointStore.save({
      projectionName: this.projectionName,
      lastGlobalPosition: currentPosition,
      integrity: this.eventStore.verifyIntegrity(),
      snapshot: this.projections.exportState(),
    });
    this.lastCheckpointPosition = currentPosition;
  }
}
