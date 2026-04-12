# Phase 2: Reconciliation Engine

## Business Purpose

Phase 2 closes the control gap between an internally approved settlement instruction and the actual external money movement. The module is responsible for:

- initiating approved settlements through an adapter boundary
- tracking provider settlement state transitions
- preventing duplicate outbound instructions and duplicate imported cash movements
- handling partial cash settlement across multiple statement lines
- handling settlement reversal as an appended compensating action
- checking channel float before dispatch so cash release does not outrun available operational liquidity
- reconciling only confirmed settlements to imported bank or mobile money statement lines

## Phase 2 Adjustment For Best Practice

To align with Phase 1, this phase treats settlement intent, provider confirmation, and reconciliation as separate concerns:

- settlement initiation does not mutate balances by itself
- only settlement confirmation posts the payout ledger entry
- reversal posts a compensating payout reversal entry
- pending or failed settlement attempts remain operational events, not financial mutations
- reconciliation runs only against externally confirmed settlements

This keeps the broader claims workflow consistent with the ledger foundation principle that financial truth must come from appended facts rather than mutable status fields.

## Operational Risks

- posting payout entries before the provider confirms execution
- duplicate provider dispatch attempts causing duplicate beneficiary payments
- duplicate statement lines making reconciled cash appear larger than reality
- partial payments being treated as full settlement and hiding outstanding exposure
- insufficient float causing a dispatch attempt that operations cannot actually fund
- delayed confirmations leaving claims stranded between approval and cash certainty
- API failures creating ambiguous settlement state unless every attempt is appended and replayable
- reversal logic removing prior history instead of appending compensating records

## Domain Boundaries

Included:

- settlement initiation governance after maker-checker approval
- provider settlement state tracking
- float availability checks through an abstraction layer
- reconciliation matching against imported statement lines
- duplicate statement detection
- partial match accumulation
- settlement reversal and compensating payout reversal entries
- simulation of delayed confirmations, duplicate transaction responses, and adapter failures

Excluded:

- real bank, switch, or mobile money APIs without formal specifications
- FX conversion and cross-currency settlement
- customer notification workflows
- chargeback and legal dispute workflows outside settlement reversal
- mutable balance tables as the source of truth

## Failure Points

- settlement initiated twice with the same payment reference
- provider rejects a retry as a duplicate transaction
- float available at approval time but unavailable at dispatch time
- provider remains pending for too long and requires operator retry or escalation
- statement imports contain duplicate lines across different batches
- one statement line is incorrectly treated as the full payout when it is only a partial payment
- a confirmed payout is reversed without a compensating payout reversal entry
- reconciliation engine matches against pending or failed settlements instead of confirmed ones

## Event Contracts

Existing events retained for backward compatibility:

- `SettlementProposed`
- `ApprovalRequested`
- `ApprovalGranted`
- `SettlementRecorded`
- `ReconciliationBatchImported`
- `StatementLineRecorded`
- `MatchCandidateGenerated`
- `AutoMatchApplied`
- `ReconciliationExceptionOpened`
- `ReconciliationExceptionResolved`

New Phase 2 events:

- `SettlementInitiated`
- `SettlementPendingProvider`
- `SettlementConfirmed`
- `SettlementFailed`
- `SettlementRetried`
- `SettlementReversed`
- `PartialMatchApplied`

### Contract Notes

- `SettlementInitiated` records dispatch intent, float observations, and attempt metadata
- `SettlementPendingProvider` records delayed confirmation states without posting any cash movement
- `SettlementConfirmed` is the first provider fact that can trigger the payout ledger posting
- `SettlementFailed` records insufficient float, duplicate provider transaction, and API failure outcomes
- `SettlementRetried` records retry governance before a new provider attempt is made
- `SettlementReversed` records the compensating operational fact and must be paired with a payout reversal ledger entry
- `PartialMatchApplied` records accumulated reconciliation against a subset of the confirmed settlement amount

## Schema Impact

Phase 2 extends the broader claims event model with:

- a settlement provider state machine: `initiated`, `pending_provider`, `confirmed`, `failed`, `retried`, `reversed`
- settlement attempt tracking and provider references
- confirmed, matched, and outstanding settlement amount fields
- float observation fields captured on settlement attempts
- duplicate and partial-match metadata on reconciliation cases
- additional reconciliation exception codes for duplicates and amount variance

## Service Structure

- `src/reconciliation/settlement-matching-engine.mjs`
  - pure candidate evaluation for exact, partial, duplicate, and exception outcomes
- `src/adapters/ports.mjs`
  - settlement channel abstraction upgraded with float check, initiate, poll, and reverse operations
- `src/application/platform.mjs`
  - settlement initiation, retry, refresh, reversal, and reconciliation orchestration
- `src/infrastructure/projection-store.mjs`
  - projection updates for settlement provider state, partial matching, and duplicate handling

## Integrity Rules

- no payout ledger mutation on settlement initiation alone
- every provider attempt is appended as a new event
- retries do not overwrite earlier failed attempts
- reversals append compensating entries instead of editing prior payout history
- reconciliation can only fully match confirmed settlements
- duplicate cash movement detection is conservative and exception-first
- partial matching accumulates until the confirmed settlement amount is fully covered
