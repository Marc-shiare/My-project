import { AppError } from "../../lib/errors.mjs";

export async function createNodePgSqlPort({ connectionString, max = 10, ssl = undefined }) {
  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new AppError(
      "DEPENDENCY_MISSING",
      "Postgres mode requires the `pg` package. Install it before setting EVENT_STORE_DRIVER=postgres.",
      500,
    );
  }

  const { Pool } = pg;
  const pool = new Pool({
    connectionString,
    max,
    ...(ssl ? { ssl } : {}),
  });

  return {
    async query({ text, values = [] }) {
      return pool.query(text, values);
    },
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const transaction = {
          async query({ text, values = [] }) {
            return client.query(text, values);
          },
        };
        const result = await work(transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
