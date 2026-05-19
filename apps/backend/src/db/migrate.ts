import { promises as fs } from "node:fs";
import path from "node:path";

import { closePool, pool } from "./pool";

async function migrate(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, "../../db/migrations");
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  for (const file of files) {
    const alreadyApplied = await pool.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [file]
    );

    if (alreadyApplied.rowCount) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

migrate()
  .then(async () => {
    await closePool();
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
