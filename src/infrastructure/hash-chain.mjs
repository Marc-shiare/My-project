import { createHash } from "node:crypto";

import { stableSerialize } from "../lib/json.mjs";

export function toCanonicalEventEnvelope(event, previousHash = event.metadata?.previousHash ?? "GENESIS") {
  return {
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
      commandId: event.metadata?.commandId,
      correlationId: event.metadata?.correlationId,
      causationId: event.metadata?.causationId,
      previousHash,
    },
  };
}

export function computeEventHash(event, previousHash = event.metadata?.previousHash ?? "GENESIS") {
  return createHash("sha256").update(stableSerialize(toCanonicalEventEnvelope(event, previousHash))).digest("hex");
}

export function verifyEventChain(events) {
  let previousHash = "GENESIS";

  for (const event of events) {
    const expectedHash = computeEventHash(event, previousHash);
    if (event.metadata?.previousHash !== previousHash || event.metadata?.hash !== expectedHash) {
      return {
        ok: false,
        eventId: event.eventId,
        expectedPreviousHash: previousHash,
        actualPreviousHash: event.metadata?.previousHash,
        expectedHash,
        actualHash: event.metadata?.hash,
      };
    }

    previousHash = event.metadata.hash;
  }

  return { ok: true, eventCount: events.length, lastHash: previousHash };
}
