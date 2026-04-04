import { randomUUID } from "node:crypto";

import { ConflictError, IntegrityError, ValidationError } from "../../lib/errors.mjs";
import { validateEventContract } from "../../domain/event-catalog.mjs";
import { computeEventHash, verifyEventChain } from "../hash-chain.mjs";
import { qualifyTable } from "./sql-identifiers.mjs";

function parseJson(value) {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function mapRowToEvent(row) {
  return {
    globalPosition: Number(row.global_position),
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: Number(row.aggregate_version),
    eventType: row.event_type,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
    actor: parseJson(row.actor),
    payload: parseJson(row.payload),
    metadata: {
      commandId: row.command_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      causationId: row.causation_id ?? undefined,
      previousHash: row.previous_hash,
      hash: row.event_hash,
    },
  };
}

export class PostgresEventStore {
  constructor({ sqlPort, validateEvent = validateEventContract, schema = "public", table = "event_store" }) {
    this.sqlPort = sqlPort;
    this.validateEvent = validateEvent;
    this.tableName = qualifyTable(schema, table);
    this.queue = Promise.resolve();
    this.#resetIndexes();
  }

  async init() {
    const result = await this.sqlPort.query({
      text: `SELECT global_position, event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
          occurred_at, recorded_at, actor, payload, command_id, correlation_id, causation_id, previous_hash, event_hash
        FROM ${this.tableName}
        ORDER BY global_position ASC`,
      values: [],
    });
    this.#rebuildIndexes(result.rows.map(mapRowToEvent));
    const integrity = this.verifyIntegrity({ force: true });
    if (!integrity.ok) {
      throw new IntegrityError("Event log hash verification failed.", integrity);
    }
  }

  #resetIndexes() {
    this.events = [];
    this.eventIndex = new Map();
    this.streamVersions = new Map();
    this.streamIndex = new Map();
    this.commandIds = new Set();
    this.lastHash = "GENESIS";
    this.lastGlobalPosition = 0;
    this.integrityCache = { ok: true, eventCount: 0, lastHash: "GENESIS" };
    this.integrityDirty = false;
  }

  #rebuildIndexes(events) {
    this.#resetIndexes();
    for (const event of events) {
      this.validateEvent(event.eventType, event.payload);
      this.#indexEvent(event);
    }
    this.integrityCache = { ok: true, eventCount: this.events.length, lastHash: this.lastHash };
    this.integrityDirty = false;
  }

  #indexEvent(event) {
    this.events.push(event);
    this.eventIndex.set(event.eventId, event);
    const streamId = `${event.aggregateType}:${event.aggregateId}`;
    const streamEvents = this.streamIndex.get(streamId) ?? [];
    streamEvents.push(event);
    this.streamIndex.set(streamId, streamEvents);
    this.streamVersions.set(streamId, event.aggregateVersion);
    if (event.metadata?.commandId) {
      this.commandIds.add(event.metadata.commandId);
    }
    this.lastHash = event.metadata.hash;
    this.lastGlobalPosition = event.globalPosition;
  }

  verifyIntegrity({ force = false } = {}) {
    if (!force && !this.integrityDirty) {
      return this.integrityCache;
    }

    const integrity = verifyEventChain(this.events);
    this.integrityCache = integrity;
    this.integrityDirty = false;
    return integrity;
  }

  hasCommand(commandId) {
    return this.commandIds.has(commandId);
  }

  getEvents() {
    return [...this.events];
  }

  getEventsAfter(globalPosition = 0) {
    return this.events.filter((event) => event.globalPosition > globalPosition);
  }

  getLastGlobalPosition() {
    return this.lastGlobalPosition;
  }

  getStreamEvents(aggregateType, aggregateId) {
    return [...(this.streamIndex.get(`${aggregateType}:${aggregateId}`) ?? [])];
  }

  getEventById(eventId) {
    return this.eventIndex.get(eventId) ?? null;
  }

  append({ aggregateType, aggregateId, expectedVersion, actor, commandId, correlationId, causationId, events }) {
    const work = async () => {
      if (!Array.isArray(events) || events.length === 0) {
        throw new ValidationError("At least one event is required for append.");
      }

      const result = await this.sqlPort.withTransaction(async (transaction) => {
        if (commandId) {
          const duplicate = await transaction.query({
            text: `SELECT 1
              FROM ${this.tableName}
              WHERE command_id = $1
              LIMIT 1`,
            values: [commandId],
          });
          if (duplicate.rows.length > 0) {
            return { deduplicated: true, events: [] };
          }
        }

        const versionResult = await transaction.query({
          text: `SELECT aggregate_version
            FROM ${this.tableName}
            WHERE aggregate_type = $1
              AND aggregate_id = $2
            ORDER BY aggregate_version DESC
            LIMIT 1`,
          values: [aggregateType, aggregateId],
        });
        const currentVersion = Number(versionResult.rows[0]?.aggregate_version ?? 0);
        if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
          throw new ConflictError(
            `Stream version conflict for ${aggregateType}:${aggregateId}. Expected ${expectedVersion}, found ${currentVersion}.`,
            { aggregateType, aggregateId, expectedVersion, currentVersion },
          );
        }

        const lastRow = await transaction.query({
          text: `SELECT global_position, event_hash
            FROM ${this.tableName}
            ORDER BY global_position DESC
            LIMIT 1`,
          values: [],
        });

        let previousHash = lastRow.rows[0]?.event_hash ?? "GENESIS";
        let aggregateVersion = currentVersion;
        let globalPosition = Number(lastRow.rows[0]?.global_position ?? 0);
        const recordedAt = new Date().toISOString();

        const prepared = [];
        for (const entry of events) {
          aggregateVersion += 1;
          globalPosition += 1;
          const payload = this.validateEvent(entry.eventType, entry.payload);
          const event = {
            globalPosition,
            eventId: randomUUID(),
            aggregateType,
            aggregateId,
            aggregateVersion,
            eventType: entry.eventType,
            occurredAt: entry.occurredAt ?? recordedAt,
            recordedAt,
            actor,
            payload,
            metadata: {
              commandId,
              correlationId: correlationId ?? aggregateId,
              causationId: causationId ?? commandId ?? aggregateId,
              previousHash,
            },
          };
          event.metadata.hash = computeEventHash(event, previousHash);
          previousHash = event.metadata.hash;
          prepared.push(event);
        }

        for (const event of prepared) {
          await transaction.query({
            text: `INSERT INTO ${this.tableName}
              (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
               occurred_at, recorded_at, actor, payload, command_id, correlation_id,
               causation_id, previous_hash, event_hash)
              VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)`,
            values: [
              event.eventId,
              event.aggregateType,
              event.aggregateId,
              event.aggregateVersion,
              event.eventType,
              event.occurredAt,
              event.recordedAt,
              JSON.stringify(event.actor),
              JSON.stringify(event.payload),
              event.metadata.commandId ?? null,
              event.metadata.correlationId ?? null,
              event.metadata.causationId ?? null,
              event.metadata.previousHash,
              event.metadata.hash,
            ],
          });
        }

        return {
          deduplicated: false,
          events: prepared,
          version: aggregateVersion,
        };
      });

      if (!result.deduplicated) {
        for (const event of result.events) {
          this.#indexEvent(event);
        }
        this.integrityCache = { ok: true, eventCount: this.events.length, lastHash: this.lastHash };
        this.integrityDirty = false;
      }

      return result;
    };

    this.queue = this.queue.then(work, work);
    return this.queue;
  }
}
