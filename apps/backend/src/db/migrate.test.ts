import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverMigrations } from "./migrate";

test("discoverMigrations preserves root ids and includes domain namespaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vocotable-migrations-"));
  try {
    await mkdir(path.join(root, "reservations"), { recursive: true });
    await mkdir(path.join(root, "billing"), { recursive: true });
    await writeFile(path.join(root, "001_schemas.sql"), "select 1;");
    await writeFile(path.join(root, "reservations", "020_tables.sql"), "select 1;");
    await writeFile(path.join(root, "billing", "070_stripe_webhook_events.sql"), "select 1;");
    await writeFile(path.join(root, "README.md"), "ignore me");

    const migrations = await discoverMigrations(root);

    assert.deepEqual(
      migrations.map((migration) => migration.id),
      [
        "001_schemas.sql",
        "reservations/020_tables.sql",
        "billing/070_stripe_webhook_events.sql"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
