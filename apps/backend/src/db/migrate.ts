import { promises as fs } from "node:fs";
import path from "node:path";

import { closePool, pool } from "./pool";

export interface MigrationFile {
  id: string;
  path: string;
}

async function walkSqlFiles(dir: string, rootDir: string): Promise<MigrationFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSqlFiles(fullPath, rootDir)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }

    const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    files.push({ id: relativePath, path: fullPath });
  }

  return files;
}

export async function discoverMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  const files = await walkSqlFiles(migrationsDir, migrationsDir);
  return files.sort((a, b) => {
    const aName = path.basename(a.id);
    const bName = path.basename(b.id);
    const aPrefix = /^(\d+)/.exec(aName)?.[1];
    const bPrefix = /^(\d+)/.exec(bName)?.[1];
    if (aPrefix && bPrefix && aPrefix !== bPrefix) {
      return Number(aPrefix) - Number(bPrefix);
    }
    if (aPrefix && !bPrefix) return -1;
    if (!aPrefix && bPrefix) return 1;
    return a.id.localeCompare(b.id);
  });
}

export async function migrate(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, "../../db/migrations");
  const migrations = await discoverMigrations(migrationsDir);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  for (const migration of migrations) {
    const alreadyApplied = await pool.query(
      "SELECT filename FROM public.schema_migrations WHERE filename = $1",
      [migration.id]
    );

    if (alreadyApplied.rowCount) {
      continue;
    }

    const sql = await fs.readFile(migration.path, "utf8");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [migration.id]);
      await client.query("COMMIT");
      console.log(`Applied migration ${migration.id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  migrate()
    .then(async () => {
      await closePool();
    })
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exit(1);
    });
}
