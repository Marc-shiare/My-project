import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { FileProjectionCheckpointStore } from "../src/infrastructure/file-projection-checkpoint-store.mjs";
import { FileEventStore } from "../src/infrastructure/file-event-store.mjs";
import { PostgresEventStore } from "../src/infrastructure/postgres/postgres-event-store.mjs";
import { PostgresProjectionCheckpointStore } from "../src/infrastructure/postgres/postgres-projection-checkpoint-store.mjs";
import { validateLedgerEventContract } from "../src/ledger/event-contracts.mjs";
import { DoubleEntryEngine } from "../src/ledger/double-entry-engine.mjs";
import { LedgerProjectionStore } from "../src/ledger/ledger-projection-store.mjs";
import { LedgerService } from "../src/ledger/ledger-service.mjs";
import { LEDGER_AGGREGATE_TYPES, LEDGER_EVENT_TYPES } from "../src/ledger/schema.mjs";

class FakeSqlPort {
  constructor() {
    this.eventRows = [];
    this.checkpointRows = new Map();
  }

  async query({ text, values = [] }) {
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT global_position, event_id")) {
      return { rows: this.eventRows.slice().sort((a, b) => a.global_position - b.global_position) };
    }

    if (normalized.includes("FROM \"public\".\"event_store\" WHERE command_id = $1")) {
      return {
        rows: this.eventRows.filter((row) => row.command_id === values[0]).slice(0, 1),
      };
    }

    if (normalized.includes("FROM \"public\".\"event_store\" WHERE aggregate_type = $1 AND aggregate_id = $2")) {
      const matches = this.eventRows
        .filter((row) => row.aggregate_type === values[0] && row.aggregate_id === values[1])
        .sort((a, b) => b.aggregate_version - a.aggregate_version);
      return { rows: matches.slice(0, 1) };
    }

    if (normalized.includes("FROM \"public\".\"event_store\" ORDER BY global_position DESC LIMIT 1")) {
      const last = this.eventRows.slice().sort((a, b) => b.global_position - a.global_position)[0];
      return { rows: last ? [last] : [] };
    }

    if (normalized.startsWith("INSERT INTO \"public\".\"event_store\"")) {
      const next = {
        global_position: this.eventRows.length + 1,
        event_id: values[0],
        aggregate_type: values[1],
        aggregate_id: values[2],
        aggregate_version: values[3],
        event_type: values[4],
        occurred_at: values[5],
        recorded_at: values[6],
        actor: JSON.parse(values[7]),
        payload: JSON.parse(values[8]),
        command_id: values[9],
        correlation_id: values[10],
        causation_id: values[11],
        previous_hash: values[12],
        event_hash: values[13],
      };
      this.eventRows.push(next);
      return { rows: [] };
    }

    if (normalized.includes("FROM \"public\".\"projection_checkpoints\" WHERE projection_name = $1")) {
      const checkpoint = this.checkpointRows.get(values[0]);
      return { rows: checkpoint ? [checkpoint] : [] };
    }

    if (normalized.startsWith("INSERT INTO \"public\".\"projection_checkpoints\"")) {
      const checkpoint = {
        projection_name: values[0],
        last_global_position: values[1],
        snapshot: JSON.parse(values[2]),
        integrity: JSON.parse(values[3]),
        updated_at: values[4],
      };
      this.checkpointRows.set(values[0], checkpoint);
      return { rows: [checkpoint] };
    }

    throw new Error(`Unexpected SQL in fake port: ${normalized}`);
  }

  async withTransaction(work) {
    return work({
      query: (params) => this.query(params),
    });
  }
}

const actors = {
  claimsMaker: { actorId: "claims-maker", displayName: "Claims Maker", roles: ["CLAIMS_MAKER"] },
  claimsChecker: { actorId: "claims-checker", displayName: "Claims Checker", roles: ["CLAIMS_CHECKER"] },
  taxOfficer: { actorId: "tax-officer", displayName: "Tax Officer", roles: ["TAX_OFFICER"] },
};

async function createReservedLedger(service, suffix = "1") {
  const submitted = await service.submitClaim({
    actor: actors.claimsMaker,
    commandId: `submit-${suffix}`,
    body: {
      claimId: `led-${suffix}`,
      tenantId: "tenant-ke",
      claimNumber: `CLM-${suffix}`,
      policyRef: `POL-${suffix}`,
      claimantRef: `C-${suffix}`,
      claimDate: "2026-04-04",
      claimedAmountMinor: 100000,
      currency: "KES",
      narrative: "Checkpointable ledger case",
    },
  });

  await service.approveAmount(submitted.claim.claimId, {
    actor: actors.claimsChecker,
    commandId: `approve-${suffix}`,
    body: {
      approvalDate: "2026-04-04",
      targetApprovedAmountMinor: 100000,
      currency: "KES",
    },
  });

  return submitted.claim.claimId;
}

test("postgres event store appends indexed immutable events", async () => {
  const sqlPort = new FakeSqlPort();
  const store = new PostgresEventStore({
    sqlPort,
    validateEvent: validateLedgerEventContract,
  });
  const engine = new DoubleEntryEngine();
  await store.init();

  await store.append({
    aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
    aggregateId: "claim-pg-1",
    expectedVersion: 0,
    actor: actors.claimsMaker,
    commandId: "pg-submit-1",
    events: [
      {
        eventType: LEDGER_EVENT_TYPES.CLAIM_SUBMITTED,
        payload: {
          tenantId: "tenant-ke",
          claimNumber: "CLM-PG-1",
          policyRef: "POL-PG-1",
          claimantRef: "C-PG-1",
          claimDate: "2026-04-04",
          claimedAmountMinor: 100000,
          currency: "KES",
          reserveBasis: "CLAIM_APPROVAL",
          narrative: "Submitted through postgres event store.",
        },
      },
    ],
  });

  await store.append({
    aggregateType: LEDGER_AGGREGATE_TYPES.CLAIM,
    aggregateId: "claim-pg-1",
    expectedVersion: 1,
    actor: actors.claimsChecker,
    commandId: "pg-approve-1",
    events: [
      {
        eventType: LEDGER_EVENT_TYPES.AMOUNT_APPROVED,
        payload: {
          approvalId: "apv-pg-1",
          approvalDate: "2026-04-04",
          approvedDeltaMinor: 100000,
          reserveDeltaMinor: 100000,
          resultingApprovedAmountMinor: 100000,
          resultingReserveAmountMinor: 100000,
          currency: "KES",
          journal: engine.createReserveApprovalJournal({
            claimId: "claim-pg-1",
            reserveDeltaMinor: 100000,
            currency: "KES",
          }),
        },
      },
    ],
  });

  assert.equal(store.getLastGlobalPosition(), 2);
  assert.equal(store.getStreamEvents(LEDGER_AGGREGATE_TYPES.CLAIM, "claim-pg-1").length, 2);
  assert.equal(store.getEventById(store.getEvents()[1].eventId).eventType, LEDGER_EVENT_TYPES.AMOUNT_APPROVED);
  assert.equal(store.verifyIntegrity().ok, true);
});

test("postgres projection checkpoint store upserts and reloads snapshots", async () => {
  const sqlPort = new FakeSqlPort();
  const checkpointStore = new PostgresProjectionCheckpointStore({ sqlPort });

  await checkpointStore.save({
    projectionName: "ledger-foundation",
    lastGlobalPosition: 12,
    integrity: { ok: true, eventCount: 12, lastHash: "abc123" },
    snapshot: { claims: [["claim-1", { claimId: "claim-1", status: "RESERVED" }]] },
  });

  const loaded = await checkpointStore.load("ledger-foundation");
  assert.equal(loaded.lastGlobalPosition, 12);
  assert.equal(loaded.integrity.lastHash, "abc123");
  assert.equal(loaded.snapshot.claims[0][1].status, "RESERVED");
});

test("ledger service restores from checkpoint and replays only the event-log tail", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-checkpoint-"));
  try {
    const eventsPath = path.join(dir, "events.jsonl");
    const checkpointPath = path.join(dir, "checkpoints.json");
    const checkpointStore = new FileProjectionCheckpointStore(checkpointPath);

    const first = new LedgerService({
      eventStore: new FileEventStore(eventsPath, { validateEvent: validateLedgerEventContract }),
      projections: new LedgerProjectionStore(),
      checkpointStore,
      projectionName: "ledger-restore",
      checkpointEvery: 100,
    });
    await first.init();

    const claimId = await createReservedLedger(first, "checkpoint");
    await checkpointStore.save({
      projectionName: "ledger-restore",
      lastGlobalPosition: first.eventStore.getLastGlobalPosition(),
      integrity: first.eventStore.verifyIntegrity(),
      snapshot: first.projections.exportState(),
    });

    await first.confirmTax(claimId, {
      actor: actors.taxOfficer,
      commandId: "tax-checkpoint",
      body: {
        taxCode: "WHT",
        jurisdiction: "KE",
        taxAmountMinor: 5000,
        currency: "KES",
      },
    });

    const reloaded = new LedgerService({
      eventStore: new FileEventStore(eventsPath, { validateEvent: validateLedgerEventContract }),
      projections: new LedgerProjectionStore(),
      checkpointStore,
      projectionName: "ledger-restore",
      checkpointEvery: 100,
    });
    await reloaded.init();

    assert.deepEqual(reloaded.getSnapshot().claims, first.getSnapshot().claims);
    assert.deepEqual(reloaded.getSnapshot().accountBalances, first.getSnapshot().accountBalances);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
