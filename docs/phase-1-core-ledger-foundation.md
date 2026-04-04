# Phase 1: Core Ledger Foundation

## Business Purpose

Phase 1 establishes the accounting backbone for claims processing before broader workflow automation expands. The purpose of this module is to ensure that every financially relevant claims decision is captured as an immutable, replayable event with balanced double-entry impact.

This foundation is responsible for:

- recording claim intake facts that may later produce accounting consequences
- establishing and adjusting claim reserves through approval events
- recording tax-confirmed liability reallocations without mutating prior entries
- recording payment release movements against the reserve
- recording reversals as appended compensating events
- producing balances only from replayed journal lines, never from direct mutation

## Operational Risks

- reserve liabilities being changed directly instead of via append-only accounting events
- tax reclassification and payment release causing reserve liability drift
- reversal logic partially undoing balances instead of inverting exact prior postings
- stale version updates causing approval or payment events to be appended out of order
- tampering with historical events breaking auditability and financial trust
- duplicate command submission creating double reserve or payment postings

## Domain Boundaries

Included:

- claims ledger case lifecycle
- reserve accounting
- tax confirmation accounting
- payment release accounting
- reversal accounting
- append-only balance projection
- hash-chain verification

Excluded:

- bank API dispatch
- tax authority API integration
- customer communications
- reconciliation and self-healing workflows outside ledger posting
- mutable balance tables as a source of truth

## Failure Points

- claim submitted twice with different aggregate ids
- approval posted before claim submission
- payment released for more than the available reserve after tax reclassification
- reversal posted against a non-existent or already reversed source event
- event log edited manually, invalidating the hash chain
- projection rebuilt incorrectly from historical events

## Event Contracts

Required domain events for Phase 1:

- `CLAIM_SUBMITTED`
- `AMOUNT_APPROVED`
- `PAYMENT_RELEASED`
- `REVERSAL_POSTED`
- `TAX_CONFIRMED`

### Contract Notes

- `CLAIM_SUBMITTED` is operational only and carries no journal lines
- `AMOUNT_APPROVED` always carries a balanced reserve journal, including downward adjustments
- `TAX_CONFIRMED` carries a balanced reclassification journal from reserve liability to tax payable
- `PAYMENT_RELEASED` carries a balanced cash release journal
- `REVERSAL_POSTED` carries the exact inverse of the referenced event's journal lines

## Schema Impact

Phase 1 introduces a dedicated ledger foundation schema alongside the broader application:

- aggregate type: `ledger_claim`
- append-only envelope schema with actor, version, hash chain, and idempotency metadata
- journal schema embedded inside event payloads for financially relevant events
- replay-only projection schema for claim ledger state and account balances

## Service Structure

- `src/ledger/schema.mjs`
  - canonical account codes, aggregate types, event names, and projection shapes
- `src/ledger/event-contracts.mjs`
  - runtime contract validation for the Phase 1 event set
- `src/ledger/double-entry-engine.mjs`
  - balanced journal generation and reversal inversion logic
- `src/ledger/ledger-projection-store.mjs`
  - replay-only account and claim state projection
- `src/ledger/ledger-service.mjs`
  - append-only application service for claim submission, approval, tax, payment, and reversal flows

## Accounting Model

Reserve establishment:

- Debit `CLAIMS_EXPENSE`
- Credit `CLAIMS_RESERVE_LIABILITY`

Tax confirmation:

- Debit `CLAIMS_RESERVE_LIABILITY`
- Credit `WITHHOLDING_TAX_PAYABLE`

Payment release:

- Debit `CLAIMS_RESERVE_LIABILITY`
- Credit `CASH_AT_BANK`

Reversal:

- exact inverse of the referenced event journal lines

## Integrity Rules

- no direct balance mutation
- every adjustment is appended as a new event
- reversals are compensating events, not edits
- every journal must balance
- every event participates in the hash chain
- projections are disposable and rebuildable from the event log
