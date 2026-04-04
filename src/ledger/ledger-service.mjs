import { createId, ensureCommandId } from "../lib/ids.mjs";
import { ConflictError, NotFoundError } from "../lib/errors.mjs";
import {
  ensureActor,
  ensureCurrency,
  ensureHasRole,
  ensureInteger,
  ensureIsoDate,
  ensureObject,
  ensureOptionalString,
  ensureString,
} from "../lib/validation.mjs";
import { DoubleEntryEngine } from "./double-entry-engine.mjs";
import { validateLedgerEventContract } from "./event-contracts.mjs";
import { LedgerProjectionStore } from "./ledger-projection-store.mjs";
import { LEDGER_AGGREGATE_TYPES, LEDGER_EVENT_TYPES } from "./schema.mjs";

function normalizeActor(actor) {
  return ensureActor(actor);
}

export class LedgerService {
  constructor({
    eventStore,
    projections = new LedgerProjectionStore(),
    doubleEntryEngine = new DoubleEntryEngine(),
    checkpointStore = null,
    projectionName = "ledger-foundation",
    checkpointEvery = 100,
  }) {
    this.eventStore = eventStore;
    this.projections = projections;
    this.doubleEntryEngine = doubleEntryEngine;
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
    const actor = normalizeActor(command.actor);
    ensureHasRole(actor, ["CLAIMS_MAKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, claim: null };
    }

    const body = ensureObject(command.body, "body");
    const claimId = ensureOptionalString(body.claimId, "claimId", { max: 80 }) ?? createId("ledclm");
    const payload = validateLedgerEventContract(LEDGER_EVENT_TYPES.CLAIM_SUBMITTED, {
      tenantId: ensureString(body.tenantId, "tenantId", { max: 80 }),
      claimNumber: ensureString(body.claimNumber, "claimNumber", { max: 80 }),
      policyRef: ensureString(body.policyRef, "policyRef", { max: 80 }),
      claimantRef: ensureString(body.claimantRef, "claimantRef", { max: 80 }),
      claimDate: ensureIsoDate(body.claimDate, "claimDate"),
      claimedAmountMinor: ensureInteger(body.claimedAmountMinor, "claimedAmountMinor", { min: 0 }),
      currency: ensureCurrency(body.currency ?? "KES"),
      reserveBasis: body.reserveBasis ?? "CLAIM_APPROVAL",
      narrative: ensureString(body.narrative, "narrative", { max: 240 }),
    });

    const result = await this.eventStore.append({
      aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
      aggregateId: claimId,
      expectedVersion: 0,
      actor,
      commandId,
      correlationId: claimId,
      events: [{ eventType: LEDGER_EVENT_TYPES.CLAIM_SUBMITTED, payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { deduplicated: false, claim: this.projections.getClaim(claimId) };
  }

  async approveAmount(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = normalizeActor(command.actor);
    ensureHasRole(actor, ["CLAIMS_CHECKER", "CLAIMS_APPROVER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, claim: this.projections.getClaim(claimId) };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const targetApprovedAmountMinor = ensureInteger(
      body.targetApprovedAmountMinor,
      "targetApprovedAmountMinor",
      { min: 0, max: claim.claimedAmountMinor },
    );
    const approvedDeltaMinor = targetApprovedAmountMinor - claim.approvedAmountMinor;
    if (approvedDeltaMinor === 0) {
      throw new ConflictError("Approval target does not change the approved amount.");
    }

    const reserveDeltaMinor = approvedDeltaMinor;
    const resultingApprovedAmountMinor = claim.approvedAmountMinor + approvedDeltaMinor;
    const resultingReserveAmountMinor = claim.reserveOutstandingMinor + reserveDeltaMinor;
    if (resultingApprovedAmountMinor < 0 || resultingReserveAmountMinor < 0) {
      throw new ConflictError("Approval adjustment would create a negative ledger state.");
    }

    const currency = this.#ensureClaimCurrency(claim, body.currency);
    const payload = validateLedgerEventContract(LEDGER_EVENT_TYPES.AMOUNT_APPROVED, {
      approvalId: ensureOptionalString(body.approvalId, "approvalId", { max: 80 }) ?? createId("apv"),
      approvalDate: ensureIsoDate(body.approvalDate, "approvalDate"),
      approvedDeltaMinor,
      reserveDeltaMinor,
      resultingApprovedAmountMinor,
      resultingReserveAmountMinor,
      currency,
      journal: this.doubleEntryEngine.createReserveApprovalJournal({
        claimId,
        reserveDeltaMinor,
        currency,
      }),
    });

    const result = await this.eventStore.append({
      aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [{ eventType: LEDGER_EVENT_TYPES.AMOUNT_APPROVED, payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { deduplicated: false, claim: this.projections.getClaim(claimId) };
  }

  async confirmTax(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = normalizeActor(command.actor);
    ensureHasRole(actor, ["TAX_OFFICER", "FINANCE_CHECKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, claim: this.projections.getClaim(claimId) };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const taxAmountMinor = ensureInteger(body.taxAmountMinor, "taxAmountMinor", { min: 1 });
    if (taxAmountMinor > claim.reserveOutstandingMinor) {
      throw new ConflictError("Tax confirmation cannot exceed the current reserve outstanding.");
    }

    const currency = this.#ensureClaimCurrency(claim, body.currency);
    const payload = validateLedgerEventContract(LEDGER_EVENT_TYPES.TAX_CONFIRMED, {
      taxConfirmationId: ensureOptionalString(body.taxConfirmationId, "taxConfirmationId", { max: 80 }) ?? createId("tax"),
      taxCode: ensureString(body.taxCode, "taxCode", { max: 80 }),
      jurisdiction: ensureString(body.jurisdiction ?? "KE", "jurisdiction", { max: 80 }),
      taxAmountMinor,
      resultingTaxConfirmedMinor: claim.taxConfirmedMinor + taxAmountMinor,
      currency,
      journal: this.doubleEntryEngine.createTaxConfirmationJournal({
        claimId,
        taxAmountMinor,
        currency,
      }),
    });

    const result = await this.eventStore.append({
      aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [{ eventType: LEDGER_EVENT_TYPES.TAX_CONFIRMED, payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { deduplicated: false, claim: this.projections.getClaim(claimId) };
  }

  async releasePayment(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = normalizeActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, claim: this.projections.getClaim(claimId) };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const netAmountMinor = ensureInteger(body.netAmountMinor, "netAmountMinor", { min: 1 });
    if (netAmountMinor > claim.reserveOutstandingMinor) {
      throw new ConflictError("Payment release cannot exceed the current reserve outstanding.");
    }

    const taxAppliedMinor = ensureInteger(body.taxAppliedMinor ?? 0, "taxAppliedMinor", { min: 0 });
    if (taxAppliedMinor > claim.taxConfirmedMinor) {
      throw new ConflictError("Applied tax cannot exceed the tax already confirmed for the claim.");
    }

    const currency = this.#ensureClaimCurrency(claim, body.currency);
    const payload = validateLedgerEventContract(LEDGER_EVENT_TYPES.PAYMENT_RELEASED, {
      paymentId: ensureOptionalString(body.paymentId, "paymentId", { max: 80 }) ?? createId("pay"),
      paymentReference: ensureString(body.paymentReference, "paymentReference", { max: 120 }),
      releaseDate: ensureIsoDate(body.releaseDate, "releaseDate"),
      netAmountMinor,
      taxAppliedMinor,
      resultingPaymentReleasedMinor: claim.paymentReleasedMinor + netAmountMinor,
      currency,
      journal: this.doubleEntryEngine.createPaymentReleaseJournal({
        claimId,
        netAmountMinor,
        currency,
      }),
    });

    const result = await this.eventStore.append({
      aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      events: [{ eventType: LEDGER_EVENT_TYPES.PAYMENT_RELEASED, payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { deduplicated: false, claim: this.projections.getClaim(claimId) };
  }

  async postReversal(claimId, command) {
    const claim = this.#requireClaim(claimId);
    const actor = normalizeActor(command.actor);
    ensureHasRole(actor, ["FINANCE_CHECKER"]);
    const commandId = ensureCommandId(command.commandId);
    if (this.projections.hasCommand(commandId)) {
      return { deduplicated: true, claim: this.projections.getClaim(claimId) };
    }

    const body = ensureObject(command.body ?? {}, "body");
    const reversalOfEventId = ensureString(body.reversalOfEventId, "reversalOfEventId", { max: 80 });
    if (claim.reversedEventIds.includes(reversalOfEventId)) {
      throw new ConflictError("The referenced event has already been reversed.");
    }

    const sourceEvent = this.eventStore.getEventById(reversalOfEventId);
    if (!sourceEvent || sourceEvent.aggregateType !== LEDGER_AGGREGATE_TYPES.CLAIM || sourceEvent.aggregateId !== claimId) {
      throw new NotFoundError(`Reversible event ${reversalOfEventId} was not found for claim ${claimId}.`);
    }

    if (
      ![
        LEDGER_EVENT_TYPES.AMOUNT_APPROVED,
        LEDGER_EVENT_TYPES.TAX_CONFIRMED,
        LEDGER_EVENT_TYPES.PAYMENT_RELEASED,
      ].includes(sourceEvent.eventType)
    ) {
      throw new ConflictError("Only approval, tax, and payment events can be reversed.");
    }

    const reversalImpact = this.#buildReversalImpact(sourceEvent);
    const resultingState = {
      approvedAmountMinor: claim.approvedAmountMinor + reversalImpact.approvedDeltaMinor,
      reserveOutstandingMinor: claim.reserveOutstandingMinor + reversalImpact.reserveDeltaMinor,
      taxConfirmedMinor: claim.taxConfirmedMinor + reversalImpact.taxDeltaMinor,
      paymentReleasedMinor: claim.paymentReleasedMinor + reversalImpact.paymentDeltaMinor,
    };
    if (Object.values(resultingState).some((value) => value < 0)) {
      throw new ConflictError("This reversal would create a negative replayed balance and is blocked.");
    }

    const payload = validateLedgerEventContract(LEDGER_EVENT_TYPES.REVERSAL_POSTED, {
      reversalId: ensureOptionalString(body.reversalId, "reversalId", { max: 80 }) ?? createId("rev"),
      reversalDate: ensureIsoDate(body.reversalDate, "reversalDate"),
      reversalOfEventId: sourceEvent.eventId,
      reversalOfEventType: sourceEvent.eventType,
      reason: ensureString(body.reason, "reason", { max: 240 }),
      currency: this.#ensureSourceCurrencyConsistency(claim, sourceEvent, body.currency),
      reversalImpact,
      journal: this.doubleEntryEngine.createReversalJournal({
        claimId,
        sourceJournal: sourceEvent.payload.journal,
        sourceEventType: sourceEvent.eventType,
      }),
    });

    const result = await this.eventStore.append({
      aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
      aggregateId: claimId,
      expectedVersion: claim.version,
      actor,
      commandId,
      correlationId: claimId,
      causationId: sourceEvent.eventId,
      events: [{ eventType: LEDGER_EVENT_TYPES.REVERSAL_POSTED, payload }],
    });
    await this.#applyAndCheckpoint(result.events);
    return { deduplicated: false, claim: this.projections.getClaim(claimId) };
  }

  #buildReversalImpact(sourceEvent) {
    switch (sourceEvent.eventType) {
      case LEDGER_EVENT_TYPES.AMOUNT_APPROVED:
        return {
          approvedDeltaMinor: -sourceEvent.payload.approvedDeltaMinor,
          reserveDeltaMinor: -sourceEvent.payload.reserveDeltaMinor,
          taxDeltaMinor: 0,
          paymentDeltaMinor: 0,
        };
      case LEDGER_EVENT_TYPES.TAX_CONFIRMED:
        return {
          approvedDeltaMinor: 0,
          reserveDeltaMinor: sourceEvent.payload.taxAmountMinor,
          taxDeltaMinor: -sourceEvent.payload.taxAmountMinor,
          paymentDeltaMinor: 0,
        };
      case LEDGER_EVENT_TYPES.PAYMENT_RELEASED:
        return {
          approvedDeltaMinor: 0,
          reserveDeltaMinor: sourceEvent.payload.netAmountMinor,
          taxDeltaMinor: 0,
          paymentDeltaMinor: -sourceEvent.payload.netAmountMinor,
        };
      default:
        throw new ConflictError(`Event type ${sourceEvent.eventType} cannot be reversed.`);
    }
  }

  #requireClaim(claimId) {
    const claim = this.projections.getClaim(claimId);
    if (!claim) {
      throw new NotFoundError(`Claim ${claimId} was not found.`);
    }
    return claim;
  }

  #ensureClaimCurrency(claim, providedCurrency) {
    const currency = ensureCurrency(providedCurrency ?? claim.currency ?? "KES");
    if (claim.currency && currency !== claim.currency) {
      throw new ConflictError(`Claim ${claim.claimId} is denominated in ${claim.currency}; mixed-currency postings are not allowed.`);
    }
    return currency;
  }

  #ensureSourceCurrencyConsistency(claim, sourceEvent, providedCurrency) {
    const currency = this.#ensureClaimCurrency(claim, providedCurrency ?? sourceEvent.payload.currency);
    if (sourceEvent.payload.currency && currency !== sourceEvent.payload.currency) {
      throw new ConflictError("Reversal currency must match the source journal currency.");
    }
    return currency;
  }

  async #applyAndCheckpoint(events) {
    this.projections.applyEvents(events);
    await this.#maybeCheckpoint();
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
