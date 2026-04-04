import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { ConflictError, IntegrityError, ValidationError } from "../lib/errors.mjs";
import { validateEventContract } from "../domain/event-catalog.mjs";
import { computeEventHash, verifyEventChain } from "./hash-chain.mjs";

export class FileEventStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.validateEvent = options.validateEvent ?? validateEventContract;
    this.queue = Promise.resolve();
    this.#resetIndexes();
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
    this.integrityCache = { ok: true, eventCount: 0, lastHash: "GENESIS" };
    this.integrityDirty = false;
  }

  #rebuildIndexes(events) {
    this.#resetIndexes();

    for (const [index, event] of events.entries()) {
      this.validateEvent(event.eventType, event.payload);
      this.#indexEvent({ ...event, globalPosition: index + 1 });
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
    return this.events.slice(globalPosition);
  }

  getLastGlobalPosition() {
    return this.events.length;
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
        const payload = this.validateEvent(entry.eventType, entry.payload);
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

        const hash = computeEventHash(envelope, previousHash);
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

      const startingGlobalPosition = this.getLastGlobalPosition();
      for (const [index, event] of prepared.entries()) {
        this.#indexEvent({
          ...event,
          globalPosition: startingGlobalPosition + index + 1,
        });
      }
      this.integrityCache = { ok: true, eventCount: this.events.length, lastHash: this.lastHash };
      this.integrityDirty = false;

      return { deduplicated: false, events: prepared, version: aggregateVersion };
    };

    this.queue = this.queue.then(work, work);
    return this.queue;
  }
}
