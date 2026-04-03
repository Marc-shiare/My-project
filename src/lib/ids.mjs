import { randomUUID } from "node:crypto";

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function ensureCommandId(commandId) {
  return commandId ?? createId("cmd");
}
