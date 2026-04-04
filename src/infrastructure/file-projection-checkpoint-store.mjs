import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { IntegrityError, ValidationError } from "../lib/errors.mjs";

export class FileProjectionCheckpointStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async load(projectionName) {
    this.#assertProjectionName(projectionName);
    await this.#ensureFile();
    const checkpoints = await this.#readAll();
    return checkpoints[projectionName] ?? null;
  }

  async save(checkpoint) {
    const projectionName = this.#assertProjectionName(checkpoint?.projectionName);
    if (!Number.isInteger(checkpoint.lastGlobalPosition) || checkpoint.lastGlobalPosition < 0) {
      throw new ValidationError("checkpoint.lastGlobalPosition must be a non-negative integer.");
    }

    const work = async () => {
      await this.#ensureFile();
      const checkpoints = await this.#readAll();
      checkpoints[projectionName] = {
        projectionName,
        lastGlobalPosition: checkpoint.lastGlobalPosition,
        integrity: checkpoint.integrity ?? { ok: true, eventCount: 0, lastHash: "GENESIS" },
        snapshot: checkpoint.snapshot ?? {},
        updatedAt: new Date().toISOString(),
      };
      await writeFile(this.filePath, `${JSON.stringify(checkpoints, null, 2)}\n`, "utf8");
      return checkpoints[projectionName];
    };

    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  async #ensureFile() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const handle = await open(this.filePath, "a+");
      await handle.close();
      const existing = await readFile(this.filePath, "utf8");
      if (!existing.trim()) {
        await writeFile(this.filePath, "{}\n", "utf8");
      }
    } catch (error) {
      throw new IntegrityError(`Failed to initialize projection checkpoint file ${this.filePath}.`, { cause: error?.message });
    }
  }

  async #readAll() {
    const raw = await readFile(this.filePath, "utf8");
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Checkpoint file root must be an object.");
      }
      return parsed;
    } catch (error) {
      throw new IntegrityError(`Projection checkpoint file ${this.filePath} is not valid JSON.`, {
        cause: error?.message,
      });
    }
  }

  #assertProjectionName(projectionName) {
    if (typeof projectionName !== "string" || projectionName.trim().length === 0) {
      throw new ValidationError("projectionName must be a non-empty string.");
    }
    return projectionName.trim();
  }
}
