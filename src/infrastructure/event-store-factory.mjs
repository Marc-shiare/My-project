import path from "node:path";

import { ValidationError } from "../lib/errors.mjs";
import { FileProjectionCheckpointStore } from "./file-projection-checkpoint-store.mjs";
import { FileEventStore } from "./file-event-store.mjs";
import { createNodePgSqlPort } from "./postgres/node-pg-sql-port.mjs";
import { PostgresEventStore } from "./postgres/postgres-event-store.mjs";
import { PostgresProjectionCheckpointStore } from "./postgres/postgres-projection-checkpoint-store.mjs";

export async function createEventInfrastructure({
  dataFile,
  checkpointFile = path.join(path.dirname(dataFile), "projection-checkpoints.json"),
  validateEvent,
}) {
  const driver = (process.env.EVENT_STORE_DRIVER ?? "file").trim().toLowerCase();

  if (driver === "file") {
    return {
      driver,
      eventStore: new FileEventStore(dataFile, { validateEvent }),
      checkpointStore: new FileProjectionCheckpointStore(checkpointFile),
      async close() {},
    };
  }

  if (driver === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new ValidationError("DATABASE_URL is required when EVENT_STORE_DRIVER=postgres.");
    }

    const sqlPort = await createNodePgSqlPort({
      connectionString,
      max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
      ssl: process.env.POSTGRES_SSL === "require" ? { rejectUnauthorized: false } : undefined,
    });

    return {
      driver,
      eventStore: new PostgresEventStore({
        sqlPort,
        validateEvent,
        schema: process.env.EVENT_STORE_SCHEMA ?? "public",
        table: process.env.EVENT_STORE_TABLE ?? "event_store",
      }),
      checkpointStore: new PostgresProjectionCheckpointStore({
        sqlPort,
        schema: process.env.EVENT_STORE_SCHEMA ?? "public",
        table: process.env.PROJECTION_CHECKPOINT_TABLE ?? "projection_checkpoints",
      }),
      async close() {
        if (typeof sqlPort.close === "function") {
          await sqlPort.close();
        }
      },
    };
  }

  throw new ValidationError(`Unsupported EVENT_STORE_DRIVER: ${driver}`);
}
