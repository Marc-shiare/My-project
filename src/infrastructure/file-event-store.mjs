import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { stableSerialize } from "../lib/json.mjs";
import { ConflictError, IntegrityError, ValidationError } from "../lib/errors.mjs";
import { validateEventContract } from "../domain/event-catalog.mjs";

export class FileEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.streamVersions = new Map();
    this.commandIds = new Set();
    this.lastHash = "GENESIS";
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await open(this.filePath, "a+");
    await handle.close();
    await this.#loadFromDisk();
  }

  async #loadFromDisk() {
    const raw = await readFile(this.filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parsedEvents = lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new IntegrityError(`Event log line ${index + 1} is not valid JSON.`);
      }
    });

    this.#rebuildIndexes(parsedEvents);
    const integrity = this.verifyIntegrity();
    if (!integrity.ok) {
      throw new IntegrityError("Event log hash verification failed.", integrity);
    }
  }

  #rebuildIndexes(events) {
    this.events = [];
    this.streamVersions = new Map();
    this.commandIds = new Set();
    this.lastHash = "GENESIS";

    for (const event of events) {
      this.events.push(event);
      const streamId = `${event.aggregateType}:${event.aggregateId}`;
      this.streamVersions.set(streamId, event.aggregateVersion);
      if (event.metadata?.commandId) {
        this.commandIds.add(event.metadata.commandId);
      }
      this.lastHash = event.metadata.hash;
    }
  }

  verifyIntegrity() {
    let previousHash = "GENESIS";

    for (const event of this.events) {
      const canonical = {
        eventId: event.eventId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateVersion: event.aggregateVersion,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        actor: event.actor,
        payload: event.payload,
        metadata: {
          commandId: event.metadata.commandId,
          correlationId: event.metadata.correlationId,
          causationId: event.metadata.causationId,
          previousHash,
        },
      };

      const expectedHash = createHash("sha256").update(stableSerialize(canonical)).digest("hex");
      if (event.metadata.previousHash !== previousHash || event.metadata.hash !== expectedHash) {
        return {
          ok: false,
          eventId: event.eventId,
          expectedPreviousHash: previousHash,
          actualPreviousHash: event.metadata.previousHash,
          expectedHash,
          actualHash: event.metadata.hash,
        };
      }

      previousHash = event.metadata.hash;
    }

    return { ok: true, eventCount: this.events.length, lastHash: previousHash };
  }

  hasCommand(commandId) {
    return this.commandIds.has(commandId);
  }

  getEvents() {
    return [...this.events];
  }

  append({ aggregateType, aggregateId, expectedVersion, actor, commandId, correlationId, causationId, events }) {
    const work = async () => {
      if (!Array.isArray(events) || events.length === 0) {
        throw new ValidationError("At least one event is required for append.");
      }

      if (commandId && this.commandIds.has(commandId)) {
        return { deduplicated: true, events: [] };
      }

      const streamId = `${aggregateType}:${aggregateId}`;
      const currentVersion = this.streamVersions.get(streamId) ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new ConflictError(
          `Stream version conflict for ${streamId}. Expected ${expectedVersion}, found ${currentVersion}.`,
          { aggregateType, aggregateId, expectedVersion, currentVersion },
        );
      }

      let previousHash = this.lastHash;
      let aggregateVersion = currentVersion;
      const recordedAt = new Date().toISOString();

      const prepared = events.map((entry) => {
        aggregateVersion += 1;
        const payload = validateEventContract(entry.eventType, entry.payload);
        const envelope = {
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

        const hash = createHash("sha256").update(stableSerialize(envelope)).digest("hex");
        envelope.metadata.hash = hash;
        previousHash = hash;
        return envelope;
      });

      const handle = await open(this.filePath, "a");
      try {
        await handle.appendFile(prepared.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      for (const event of prepared) {
        this.events.push(event);
        this.streamVersions.set(streamId, event.aggregateVersion);
        if (commandId) {
          this.commandIds.add(commandId);
        }
        this.lastHash = event.metadata.hash;
      }

      return { deduplicated: false, events: prepared, version: aggregateVersion };
    };

    this.queue = this.queue.then(work, work);
    return this.queue;
  }
}
