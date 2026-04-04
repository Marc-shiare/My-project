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

const DAY_MS = 24 * 60 * 60 * 1000;

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

export class ClaimsPlatform {
  constructor({
    eventStore,
    projections,
    adapters = createManualAdapters(),
    checkpointStore = null,
    projectionName = "claims-platform",
    checkpointEvery = 100,
  }) {
    this.eventStore = eventStore;
    this.projections = projections;
    this.adapters = adapters;
    this.checkpointStore = checkpointStore;
    this.projectionName = projectionName;
    this.checkpointEvery = checkpointEvery;
    this.lastCheckpointPosition = 0;
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
    if (claim.settlement) {
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

  async recordSettlement(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = await this.#resolveActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    if (!claim.settlement || claim.settlement.status !== "APPROVED") {
      throw new ConflictError("Settlement must be approved before recording.");
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
          eventType: "SettlementRecorded",
          payload: {
            settlementId: claim.settlement.settlementId,
            postingRef: ensureString(body.postingRef, "postingRef", { max: 120 }),
            amountMinor: claim.settlement.amountMinor,
            currency: claim.currency,
            channelType: claim.settlement.channelType,
            externalStatus: ensureEnum(body.externalStatus ?? "MANUALLY_CONFIRMED", "externalStatus", [
              "MANUALLY_CONFIRMED",
              "POSTED_FROM_ADAPTER",
            ]),
          },
        },
        {
          eventType: "LedgerEntryPosted",
          payload: {
            entryType: "CLAIM_PAYOUT",
            currency: claim.currency,
            lines: payoutLedgerLines(claimId, claim.settlement.amountMinor),
          },
        },
      ],
    });
    await this.#applyAndCheckpoint(result.events);
    return { claim: this.projections.getClaim(claimId), deduplicated: false };
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

    const normalizedLines = await this.adapters.statementImportPort.ingestBatch(
      body.lines.map((line, index) => {
        const value = ensureObject(line, `lines[${index}]`);
        return {
          lineId: ensureOptionalString(value.lineId, `lines[${index}].lineId`, { max: 80 }) ?? createId("line"),
          externalReference: ensureString(value.externalReference, `lines[${index}].externalReference`, { max: 120 }),
          narrative: ensureString(value.narrative ?? value.externalReference, `lines[${index}].narrative`, { max: 240 }),
          amountMinor: ensureInteger(value.amountMinor, `lines[${index}].amountMinor`, { min: 0 }),
          currency: ensureCurrency(value.currency ?? "KES"),
          direction: ensureEnum(value.direction, `lines[${index}].direction`, ["DEBIT", "CREDIT"]),
          valueDate: ensureIsoDate(value.valueDate, `lines[${index}].valueDate`),
          channelType: ensureEnum(value.channelType ?? "UNKNOWN", `lines[${index}].channelType`, [
            "BANK_TRANSFER",
            "MOBILE_MONEY",
            "CARD_REVERSAL",
            "CHEQUE",
            "UNKNOWN",
          ]),
        };
      }),
    );

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
      return { deduplicated: true, summary: this.#buildSelfHealSummary(0, 0) };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const maxAgeDays = ensureInteger(body.maxAgeDays ?? 2, "maxAgeDays", { min: 1, max: 30 });
    const now = new Date(body.asAt ?? new Date().toISOString());
    if (Number.isNaN(now.getTime())) {
      throw new ValidationError("body.asAt must be a valid ISO timestamp when supplied.");
    }

    let autoMatches = 0;
    let exceptionsOpened = 0;
    const openCases = this.projections.listCases().filter((item) => item.status === "OPEN" && item.lineId);
    const claims = this.projections.listClaims();

    for (const item of openCases) {
      if (item.direction !== "DEBIT") {
        continue;
      }

      const candidates = claims.filter((claim) => {
        const settlement = claim.settlement;
        return (
          settlement &&
          ["APPROVED", "RECORDED"].includes(settlement.status) &&
          settlement.amountMinor === item.amountMinor &&
          claim.currency === item.currency &&
          !settlement.matchedCaseId
        );
      });

      const exact = candidates.filter((claim) => claim.settlement.paymentReference === item.externalReference);
      if (exact.length === 1) {
        const winner = exact[0];
        const result = await this.eventStore.append({
          aggregateType: "reconciliation_case",
          aggregateId: item.caseId,
          expectedVersion: item.version,
          actor,
          commandId: undefined,
          correlationId: item.caseId,
          causationId: commandId,
          events: [
            {
              eventType: "MatchCandidateGenerated",
              payload: {
                caseId: item.caseId,
                claimId: winner.claimId,
                settlementId: winner.settlement.settlementId,
                matchType: "EXACT_REFERENCE_AMOUNT",
                confidence: 1,
              },
            },
            {
              eventType: "AutoMatchApplied",
              payload: {
                caseId: item.caseId,
                claimId: winner.claimId,
                settlementId: winner.settlement.settlementId,
                reason: "Exact payment reference, currency, and amount matched.",
              },
            },
          ],
        });
        await this.#applyAndCheckpoint(result.events);
        autoMatches += 1;
        continue;
      }

      const amountOnly = candidates.filter((claim) => claim.settlement.paymentReference !== item.externalReference);
      if (amountOnly.length === 1) {
        const winner = amountOnly[0];
        const result = await this.eventStore.append({
          aggregateType: "reconciliation_case",
          aggregateId: item.caseId,
          expectedVersion: item.version,
          actor,
          commandId: undefined,
          correlationId: item.caseId,
          causationId: commandId,
          events: [
            {
              eventType: "ReconciliationExceptionOpened",
              payload: {
                caseId: item.caseId,
                batchId: item.batchId,
                lineId: item.lineId,
                claimId: winner.claimId,
                settlementId: winner.settlement.settlementId,
                code: "REFERENCE_MISMATCH",
                severity: "MEDIUM",
                reason: "Amount matched a single payout, but the external reference did not.",
              },
            },
          ],
        });
        await this.#applyAndCheckpoint(result.events);
        exceptionsOpened += 1;
        continue;
      }

      const code = amountOnly.length > 1 ? "AMBIGUOUS_MATCH" : "UNLINKED_CASHFLOW";
      const reason =
        code === "AMBIGUOUS_MATCH"
          ? "Multiple candidate payouts share the same amount. Manual review is required."
          : "No approved or recorded payout matched this statement line.";

      const result = await this.eventStore.append({
        aggregateType: "reconciliation_case",
        aggregateId: item.caseId,
        expectedVersion: item.version,
        actor,
        commandId: undefined,
        correlationId: item.caseId,
        causationId: commandId,
        events: [
          {
            eventType: "ReconciliationExceptionOpened",
            payload: {
              caseId: item.caseId,
              batchId: item.batchId,
              lineId: item.lineId,
              claimId: null,
              settlementId: null,
              code,
              severity: code === "AMBIGUOUS_MATCH" ? "HIGH" : "MEDIUM",
              reason,
            },
          },
        ],
      });
      await this.#applyAndCheckpoint(result.events);
      exceptionsOpened += 1;
    }

    const refreshedClaims = this.projections.listClaims();
    for (const claim of refreshedClaims) {
      if (!claim.settlement || !["APPROVED", "RECORDED"].includes(claim.settlement.status) || claim.settlement.matchedCaseId) {
        continue;
      }

      const anchor = claim.settlement.recordedAt ?? claim.settlement.approvedAt ?? claim.updatedAt;
      const ageDays = Math.floor((now.getTime() - new Date(anchor).getTime()) / DAY_MS);
      if (ageDays < maxAgeDays) {
        continue;
      }

      const existingCase = this.projections
        .listCases()
        .find(
          (item) =>
            item.settlementId === claim.settlement.settlementId &&
            item.exception?.code === "MISSING_CASH_MOVEMENT" &&
            item.status === "EXCEPTION",
        );
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
              reason: `No cash movement has been imported within ${maxAgeDays} days of payout approval/recording.`,
            },
          },
        ],
      });
      await this.#applyAndCheckpoint(result.events);
      exceptionsOpened += 1;
    }

    return { deduplicated: false, summary: this.#buildSelfHealSummary(autoMatches, exceptionsOpened) };
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
    await this.recordSettlement(claimOne.claim.claimId, {
      actor: roles.financeChecker,
      commandId: "demo-record-1",
      body: { postingRef: "BANKPOST-001", externalStatus: "MANUALLY_CONFIRMED" },
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
    await this.recordSettlement(claimTwo.claim.claimId, {
      actor: roles.financeChecker,
      commandId: "demo-record-2",
      body: { postingRef: "MMP-002", externalStatus: "MANUALLY_CONFIRMED" },
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
            externalReference: "PAY-KE-0002X",
            narrative: "Provider mobile settlement",
            amountMinor: 180000,
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

  #buildSelfHealSummary(autoMatches, exceptionsOpened) {
    return {
      autoMatches,
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
