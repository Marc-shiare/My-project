# Architecture And Control Design

## Scope

This initial platform slice covers:

- claim intake and validation
- claims adjudication and reserve booking
- settlement proposal and maker-checker approval
- settlement recording
- reconciliation batch import
- self-healing exact-match reconciliation
- exception management
- immutable audit and ledger visibility

## Module 1: Claims Intake And Validation

### Business Purpose

Capture claims from branches, providers, TPAs, or field operations in a way that survives low-connectivity environments, prevents duplicate submissions, and preserves the original business facts before adjudication changes occur.

### Operational Risks

- duplicate claim submission during offline retries
- incomplete policy or member references
- amount rounding drift between source channels
- document loss or delayed attachment sync
- backdated incident dates used for fraud or mistake masking

### Domain Boundaries

Included:

- claim identity
- claimant/member/provider references
- claimed amount and incident date
- validation outcome and findings

Excluded:

- policy pricing and underwriting engines
- OCR and document extraction
- customer KYC and sanctions screening
- external provider portals

### Failure Points

- client submits the same command multiple times after reconnect
- claim stream version conflict caused by stale offline state
- validation completed against stale claim data
- event append succeeds but UI loses acknowledgement

### Event Contracts

- `ClaimSubmitted`
- `ClaimValidated`

### Schema Impact

- append-only `claim` stream introduced
- claim projection stores immutable submission facts plus latest validation state
- idempotency key stored in event metadata, not in mutable claim tables

## Module 2: Adjudication And Immutable Financial Posting

### Business Purpose

Turn validated claims into controlled financial commitments. Approved claims create immutable reserve postings so finance and insurance operations can distinguish operational decisioning from ledger impact.

### Operational Risks

- adjudicating before validation
- approving amounts greater than the original claim
- posting reserves without a durable audit trail
- inconsistent claim and ledger states if posting logic is not tied to the same event flow

### Domain Boundaries

Included:

- adjudication decision
- approved amount
- reserve amount
- reason codes
- ledger posting event for reserve recognition

Excluded:

- actuarial reserve modeling
- external general-ledger export
- tax calculation engines

### Failure Points

- partial approval with invalid amount bounds
- reserve event not balancing debit and credit lines
- replay divergence if ledger is derived from mutable tables

### Event Contracts

- `ClaimAdjudicated`
- `LedgerEntryPosted`

### Schema Impact

- immutable ledger-entry projection introduced
- reserve postings reference claim stream and remain replayable
- all monetary values stored as integer minor units with explicit currency

## Module 3: Settlement Governance

### Business Purpose

Release funds only after dual control. A finance maker proposes the settlement and a distinct finance checker approves it before any payout is recorded.

### Operational Risks

- same actor acting as both maker and checker
- bypassing approval for urgent payouts
- incorrect beneficiary or payment reference
- payout recorded before approval

### Domain Boundaries

Included:

- settlement proposal details
- approval request and approval grant
- payout recording

Excluded:

- live bank/mobile money dispatch APIs
- sanctions and beneficiary verification
- treasury liquidity optimization

### Failure Points

- checker approves with stale settlement payload
- payout reference reused across multiple claims
- operator records settlement without approved request

### Event Contracts

- `SettlementProposed`
- `ApprovalRequested`
- `ApprovalGranted`
- `SettlementRecorded`

### Schema Impact

- settlement state embedded in claim projection
- approval request metadata retained in immutable history
- payout posting creates a second immutable ledger event

## Module 4: Reconciliation And Self-Healing

### Business Purpose

Ingest bank or settlement statements, match them against authorized claim payouts, auto-resolve only low-risk exact matches, and raise governed exceptions for everything else.

### Operational Risks

- delayed statement availability
- reference truncation or transformation by external channels
- duplicate statement lines
- ambiguous amount-only matches
- over-aggressive automation hiding real cash breaks

### Domain Boundaries

Included:

- reconciliation batch metadata
- individual statement lines
- match candidates
- auto-match application
- reconciliation exceptions and resolutions

Excluded:

- direct bank connectivity implementations
- external ERP reconciliation posting
- automated recovery instructions to third parties

### Failure Points

- importing the same batch twice
- matching a line to the wrong payout because of amount-only similarity
- unresolved breaks accumulating without visibility
- missing cash movement not detected after payout recording

### Event Contracts

- `ReconciliationBatchImported`
- `StatementLineRecorded`
- `MatchCandidateGenerated`
- `AutoMatchApplied`
- `ReconciliationExceptionOpened`
- `ReconciliationExceptionResolved`

### Schema Impact

- `reconciliation_batch` and `reconciliation_case` streams introduced
- reconciliation case projection tracks open, matched, exception, and resolved states
- exception signatures used to prevent duplicate break creation on repeated self-heal runs

## Module 5: Auditability And Offline Operations

### Business Purpose

Keep operating during connectivity degradation without sacrificing integrity. The browser queues commands locally, the backend accepts idempotent retries, and the event store maintains a tamper-evident hash chain.

### Operational Risks

- offline queue replaying stale actions after business state changed
- clock drift affecting operational cutoffs
- event log tampering
- projection corruption after unexpected shutdown

### Domain Boundaries

Included:

- command idempotency
- service-worker shell caching
- local offline queue
- event hash chaining and startup verification

Excluded:

- enterprise device management
- full conflict-free replicated data types
- hardware-backed signing

### Failure Points

- browser queue flush collides with newer server state
- partial disk write corrupts event log
- service worker serves stale UI assets after upgrade

### Event Contracts

Operational controls rely on event metadata rather than separate event types:

- `commandId`
- `correlationId`
- `causationId`
- `previousHash`
- `hash`

### Schema Impact

- event envelope includes actor, version, timestamps, command idempotency, and hash chain fields
- no mutable financial record tables exist in the write model

## Event Envelope

Every persisted event carries:

- `eventId`
- `aggregateType`
- `aggregateId`
- `aggregateVersion`
- `eventType`
- `occurredAt`
- `recordedAt`
- `actor`
- `metadata.commandId`
- `metadata.correlationId`
- `metadata.causationId`
- `metadata.previousHash`
- `metadata.hash`
- `payload`

## Conservative Self-Healing Policy

Automation is intentionally narrow:

- exact `paymentReference + amount + currency` match: auto-apply
- single amount match but reference mismatch: raise exception
- no credible match: raise exception
- approved or recorded payout with no cash movement after threshold: raise exception

The engine never dispatches funds or mutates historical records.

## Production Replacement Points

The reference build is runnable as-is, but these adapters are intended for replacement in a production deployment:

- event store adapter: file to database or log platform
- identity context adapter: request actor to authenticated principal
- settlement channel adapter: manual confirmation to real payment rails
- statement import adapter: manual JSON upload to bank or switch ingestion
