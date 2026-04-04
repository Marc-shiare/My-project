import { clone } from "../lib/json.mjs";
import {
  createEmptyAccountBalance,
  createEmptyClaimLedgerState,
  LEDGER_AGGREGATE_TYPES,
  LEDGER_EVENT_TYPES,
} from "./schema.mjs";

function byNewest(a, b) {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export class LedgerProjectionStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.claims = new Map();
    this.accountBalances = new Map();
    this.commandIds = new Set();
    this.eventIndex = new Map();
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
    this.accountBalances = new Map((state.accountBalances ?? []).map(([key, value]) => [key, clone(value)]));
    this.commandIds = new Set(state.commandIds ?? []);
    this.events = (state.recentEvents ?? []).map(clone);
    this.eventIndex = new Map(this.events.map((event) => [event.eventId, event]));
    this.integrity = integrity;
  }

  exportState() {
    return {
      claims: [...this.claims.entries()].map(([key, value]) => [key, clone(value)]),
      accountBalances: [...this.accountBalances.entries()].map(([key, value]) => [key, clone(value)]),
      commandIds: [...this.commandIds],
      recentEvents: this.events.slice(-100).map(clone),
    };
  }

  applyEvent(event) {
    if (event.aggregateType !== LEDGER_AGGREGATE_TYPES.CLAIM) {
      return;
    }

    this.events.push(event);
    this.eventIndex.set(event.eventId, event);
    if (event.metadata?.commandId) {
      this.commandIds.add(event.metadata.commandId);
    }

    switch (event.eventType) {
      case LEDGER_EVENT_TYPES.CLAIM_SUBMITTED:
        this.#applyClaimSubmitted(event);
        break;
      case LEDGER_EVENT_TYPES.AMOUNT_APPROVED:
        this.#applyAmountApproved(event);
        break;
      case LEDGER_EVENT_TYPES.TAX_CONFIRMED:
        this.#applyTaxConfirmed(event);
        break;
      case LEDGER_EVENT_TYPES.PAYMENT_RELEASED:
        this.#applyPaymentReleased(event);
        break;
      case LEDGER_EVENT_TYPES.REVERSAL_POSTED:
        this.#applyReversalPosted(event);
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

  #ensureBalance(accountCode) {
    const current = this.accountBalances.get(accountCode);
    if (current) {
      return current;
    }

    const next = createEmptyAccountBalance(accountCode);
    this.accountBalances.set(accountCode, next);
    return next;
  }

  #applyJournal(journal) {
    for (const line of journal.lines) {
      const balance = this.#ensureBalance(line.accountCode);
      balance.debitTotalMinor += line.debitMinor;
      balance.creditTotalMinor += line.creditMinor;
      balance.netMinor = balance.debitTotalMinor - balance.creditTotalMinor;
    }
  }

  #touchClaim(claim, event) {
    claim.version = event.aggregateVersion;
    claim.lastEventType = event.eventType;
    claim.updatedAt = event.occurredAt;
  }

  #applyClaimSubmitted(event) {
    const claim = createEmptyClaimLedgerState(event.aggregateId);
    claim.tenantId = event.payload.tenantId;
    claim.claimNumber = event.payload.claimNumber;
    claim.policyRef = event.payload.policyRef;
    claim.claimantRef = event.payload.claimantRef;
    claim.currency = event.payload.currency;
    claim.claimedAmountMinor = event.payload.claimedAmountMinor;
    claim.reserveBasis = event.payload.reserveBasis;
    claim.narrative = event.payload.narrative;
    claim.claimDate = event.payload.claimDate;
    claim.status = "SUBMITTED";
    claim.createdAt = event.occurredAt;
    this.#touchClaim(claim, event);
    this.claims.set(event.aggregateId, claim);
  }

  #applyAmountApproved(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.approvedAmountMinor += event.payload.approvedDeltaMinor;
    claim.reserveOutstandingMinor += event.payload.reserveDeltaMinor;
    claim.status = claim.reserveOutstandingMinor > 0 ? "RESERVED" : "APPROVED";
    this.#applyJournal(event.payload.journal);
    this.#touchClaim(claim, event);
  }

  #applyTaxConfirmed(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.taxConfirmedMinor += event.payload.taxAmountMinor;
    claim.reserveOutstandingMinor -= event.payload.taxAmountMinor;
    claim.status = claim.reserveOutstandingMinor > 0 ? "PARTIALLY_UTILIZED" : "RESERVE_CLEARED";
    this.#applyJournal(event.payload.journal);
    this.#touchClaim(claim, event);
  }

  #applyPaymentReleased(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.paymentReleasedMinor += event.payload.netAmountMinor;
    claim.reserveOutstandingMinor -= event.payload.netAmountMinor;
    claim.status = claim.reserveOutstandingMinor > 0 ? "PARTIALLY_PAID" : "SETTLED";
    this.#applyJournal(event.payload.journal);
    this.#touchClaim(claim, event);
  }

  #applyReversalPosted(event) {
    const claim = this.#ensureClaim(event.aggregateId);
    claim.approvedAmountMinor += event.payload.reversalImpact.approvedDeltaMinor;
    claim.reserveOutstandingMinor += event.payload.reversalImpact.reserveDeltaMinor;
    claim.taxConfirmedMinor += event.payload.reversalImpact.taxDeltaMinor;
    claim.paymentReleasedMinor += event.payload.reversalImpact.paymentDeltaMinor;
    claim.reversedEventIds = [...claim.reversedEventIds, event.payload.reversalOfEventId];
    claim.status = claim.reserveOutstandingMinor > 0 ? "ADJUSTED" : "REVERSED_OR_CLEARED";
    this.#applyJournal(event.payload.journal);
    this.#touchClaim(claim, event);
  }

  hasCommand(commandId) {
    return this.commandIds.has(commandId);
  }

  getClaim(claimId) {
    const claim = this.claims.get(claimId);
    return claim ? clone(claim) : null;
  }

  getEvent(eventId) {
    const event = this.eventIndex.get(eventId);
    return event ? clone(event) : null;
  }

  listClaims() {
    return [...this.claims.values()].map(clone).sort(byNewest);
  }

  listAccountBalances() {
    return [...this.accountBalances.values()].map(clone).sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }

  listEvents(limit = 50) {
    return this.events.slice(-limit).reverse().map(clone);
  }

  getSnapshot() {
    return {
      integrity: this.integrity,
      claims: this.listClaims(),
      accountBalances: this.listAccountBalances(),
      recentEvents: this.listEvents(),
    };
  }
}
