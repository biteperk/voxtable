import { DbClient, pool } from "../db/pool";
import type { MenuDraft } from "../http/schemas";

export type MenuIngestionStatus =
  | "pending"
  | "processing"
  | "parsed"
  | "committed"
  | "failed";

export interface MenuIngestionJob {
  id: string;
  restaurant_id: string;
  source_kind: "image" | "pdf";
  source_url: string;
  source_sha256: string | null;
  status: MenuIngestionStatus;
  attempts: number;
  next_attempt_at: string;
  parsed_draft: MenuDraft | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Enqueue an ingestion job. Idempotent on (restaurant_id, source_sha256): a
 * re-upload of the same file returns the existing job instead of paying for a
 * second parse. Without a sha256, every call is a new job.
 */
export async function enqueueIngestionJob(input: {
  restaurantId: string;
  sourceKind: "image" | "pdf";
  sourceUrl: string;
  sha256?: string | null;
}): Promise<MenuIngestionJob> {
  if (input.sha256) {
    const result = await pool.query<MenuIngestionJob>(
      `
      INSERT INTO menu_ingestion_jobs (restaurant_id, source_kind, source_url, source_sha256)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (restaurant_id, source_sha256) WHERE source_sha256 IS NOT NULL
        DO UPDATE SET source_url = EXCLUDED.source_url
      RETURNING *
      `,
      [input.restaurantId, input.sourceKind, input.sourceUrl, input.sha256]
    );
    return result.rows[0]!;
  }
  const result = await pool.query<MenuIngestionJob>(
    `INSERT INTO menu_ingestion_jobs (restaurant_id, source_kind, source_url)
     VALUES ($1, $2, $3) RETURNING *`,
    [input.restaurantId, input.sourceKind, input.sourceUrl]
  );
  return result.rows[0]!;
}

export async function getIngestionJob(
  id: string,
  restaurantId: string
): Promise<MenuIngestionJob | null> {
  const result = await pool.query<MenuIngestionJob>(
    "SELECT * FROM menu_ingestion_jobs WHERE id = $1 AND restaurant_id = $2",
    [id, restaurantId]
  );
  return result.rows[0] ?? null;
}

export async function countJobsSince(
  restaurantId: string,
  sinceIso: string
): Promise<number> {
  const result = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM menu_ingestion_jobs WHERE restaurant_id = $1 AND created_at >= $2",
    [restaurantId, sinceIso]
  );
  return Number(result.rows[0]?.n ?? "0");
}

/**
 * Atomically claim up to `limit` due jobs, flipping them to 'processing'.
 * FOR UPDATE SKIP LOCKED so multiple worker ticks / instances never double-claim
 * (mirrors the Cal.com outbox worker).
 */
export async function claimReadyJobs(limit: number, db: DbClient = pool): Promise<MenuIngestionJob[]> {
  const result = await db.query<MenuIngestionJob>(
    `
    UPDATE menu_ingestion_jobs
    SET status = 'processing', attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM menu_ingestion_jobs
      WHERE (status = 'pending' AND next_attempt_at <= now())
         -- Reaper: a 'processing' row whose worker died mid-tick (crash /
         -- redeploy) would otherwise be stuck forever — nothing else ever
         -- re-selects it. 10 min is far beyond any single tick's work.
         -- updated_at is trigger-maintained on every UPDATE.
         OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    RETURNING *
    `,
    [limit]
  );
  return result.rows;
}

export async function markParsed(id: string, draft: MenuDraft): Promise<void> {
  await pool.query(
    "UPDATE menu_ingestion_jobs SET status = 'parsed', parsed_draft = $2::jsonb, last_error = NULL WHERE id = $1",
    [id, JSON.stringify(draft)]
  );
}

export async function markRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
  await pool.query(
    "UPDATE menu_ingestion_jobs SET status = 'pending', next_attempt_at = $2, last_error = $3 WHERE id = $1",
    [id, nextAttemptAt.toISOString(), error.slice(0, 500)]
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await pool.query(
    "UPDATE menu_ingestion_jobs SET status = 'failed', last_error = $2 WHERE id = $1",
    [id, error.slice(0, 500)]
  );
}

export async function updateDraft(
  id: string,
  restaurantId: string,
  draft: MenuDraft
): Promise<MenuIngestionJob | null> {
  const result = await pool.query<MenuIngestionJob>(
    `UPDATE menu_ingestion_jobs SET parsed_draft = $3::jsonb
      WHERE id = $1 AND restaurant_id = $2 AND status = 'parsed'
      RETURNING *`,
    [id, restaurantId, JSON.stringify(draft)]
  );
  return result.rows[0] ?? null;
}

export async function markCommitted(id: string, db: DbClient = pool): Promise<void> {
  await db.query("UPDATE menu_ingestion_jobs SET status = 'committed' WHERE id = $1", [id]);
}
