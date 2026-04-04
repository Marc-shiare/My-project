import { ValidationError } from "../../lib/errors.mjs";
import { qualifyTable } from "./sql-identifiers.mjs";

export class PostgresProjectionCheckpointStore {
  constructor({ sqlPort, schema = "public", table = "projection_checkpoints" }) {
    this.sqlPort = sqlPort;
    this.tableName = qualifyTable(schema, table);
  }

  async load(projectionName) {
    this.#assertProjectionName(projectionName);
    const result = await this.sqlPort.query({
      text: `SELECT projection_name, last_global_position, snapshot, integrity, updated_at
        FROM ${this.tableName}
        WHERE projection_name = $1`,
      values: [projectionName],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return this.#mapRow(result.rows[0]);
  }

  async save(checkpoint) {
    const projectionName = this.#assertProjectionName(checkpoint?.projectionName);
    if (!Number.isInteger(checkpoint.lastGlobalPosition) || checkpoint.lastGlobalPosition < 0) {
      throw new ValidationError("checkpoint.lastGlobalPosition must be a non-negative integer.");
    }

    const result = await this.sqlPort.query({
      text: `INSERT INTO ${this.tableName}
        (projection_name, last_global_position, snapshot, integrity, updated_at)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
        ON CONFLICT (projection_name)
        DO UPDATE SET
          last_global_position = EXCLUDED.last_global_position,
          snapshot = EXCLUDED.snapshot,
          integrity = EXCLUDED.integrity,
          updated_at = EXCLUDED.updated_at
        RETURNING projection_name, last_global_position, snapshot, integrity, updated_at`,
      values: [
        projectionName,
        checkpoint.lastGlobalPosition,
        JSON.stringify(checkpoint.snapshot ?? {}),
        JSON.stringify(checkpoint.integrity ?? { ok: true, eventCount: 0, lastHash: "GENESIS" }),
        new Date().toISOString(),
      ],
    });

    return this.#mapRow(result.rows[0]);
  }

  #mapRow(row) {
    return {
      projectionName: row.projection_name,
      lastGlobalPosition: Number(row.last_global_position),
      snapshot: typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
      integrity: typeof row.integrity === "string" ? JSON.parse(row.integrity) : row.integrity,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  #assertProjectionName(projectionName) {
    if (typeof projectionName !== "string" || projectionName.trim().length === 0) {
      throw new ValidationError("projectionName must be a non-empty string.");
    }
    return projectionName.trim();
  }
}
