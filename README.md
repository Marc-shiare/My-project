# Self-Healing Claims and Reconciliation Platform

This repository contains a runnable reference platform for insurance claims, settlement governance, and reconciliation operations tailored to Kenyan financial control requirements. The implementation is deliberately conservative:

- event-sourced and append-only
- immutable financial posting events
- maker-checker settlement governance
- offline-capable browser workflow
- audit-first hash-chained event log
- no invented bank, mobile money, or insurer APIs

## What Is Included

- A no-dependency Node.js backend with a file-backed event store
- Runtime event contract validation for claims, approvals, ledger postings, and reconciliation events
- Read-model projections for dashboard, claims, settlements, ledger, and exceptions
- A web UI with offline queueing and a service worker
- Sample self-healing logic that auto-matches only exact low-risk reconciliations
- Automated tests for governance, immutable postings, idempotency, and self-healing

## Run

```bash
cmd /c npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Test

```bash
cmd /c npm test
```

## Architecture Notes

The platform uses a file-backed event store in [`data/events.jsonl`](data/events.jsonl). This is appropriate for a reference implementation and local resilience testing; production deployment should replace the storage adapter with a transactional database while keeping the same event contracts.

Business and architecture analysis is documented in [docs/architecture.md](docs/architecture.md).

## Demo Personas

The UI includes built-in personas to exercise governance rules:

- Claims Maker
- Claims Checker
- Finance Maker
- Finance Checker
- Reconciliation Analyst
- System Bot

## External Boundaries

Banking rails, mobile money, insurer core systems, and identity providers are not implemented as fake APIs. Instead, explicit adapter boundaries are defined in [src/adapters/ports.mjs](src/adapters/ports.mjs). The current build uses manual confirmation and file-based imports until real specifications are available.
