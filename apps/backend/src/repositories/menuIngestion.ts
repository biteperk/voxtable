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
  /** Page 1. Kept for rows written before multi-page support (migration 023). */
  source_url: string;
  /**
   * Ordered page images, page 1 first. May be EMPTY on two paths that both still
   * have to work: a row written by the old single-page client, and any row read
   * in the window where new code is live but migration 023 hasn't run yet
   * (deploy-backend.yml restarts containers before migrating).
   *
   * Never read this directly — use pagesForJob() below.
   */
  source_urls?: string[];
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
 * The pages to parse for a job, in order. The single place that knows how to
 * reconcile the multi-page column with the legacy single-URL one — so a legacy
 * row, a pre-migration read, and a modern 12-page row all look the same to
 * callers.
 */
export function pagesForJob(job: MenuIngestionJob): string[] {
  const pages = Array.isArray(job.source_urls) ? job.source_urls.filter((u) => typeof u === "string" && u) : [];
  return pages.length > 0 ? pages : [job.source_url];
}

/**
 * Enqueue an ingestion job. Idempotent on (restaurant_id, source_sha256): a
 * re-upload of the same menu returns the existing job instead of paying for a
 * second parse. Without a sha256, every call is a new job.
 *
 * A re-upload of a job that FAILED is reset to pending and re-run. Previously
 * the conflict clause only touched source_url and returned the row untouched,
 * so a failed job stayed failed with attempts already exhausted: the owner
 * re-uploaded, got the same stale error instantly, and had no way to retry short
 * of altering the file. `parsed` and `committed` rows are deliberately NOT
 * reset — that work is done, and re-running it would duplicate the menu.
 */
export async function enqueueIngestionJob(input: {
  restaurantId: string;
  sourceKind: "image" | "pdf";
  /** Ordered page images, page 1 first. */
  sourceUrls: string[];
  sha256?: string | null;
}): Promise<MenuIngestionJob> {
  const pages = input.sourceUrls;
  const firstPage = pages[0];
  if (!firstPage) throw new Error("enqueueIngestionJob requires at least one page URL");

  if (input.sha256) {
    const result = await pool.query<MenuIngestionJob>(
      `
      INSERT INTO menu_ingestion_jobs (restaurant_id, source_kind, source_url, source_urls, source_sha256)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (restaurant_id, source_sha256) WHERE source_sha256 IS NOT NULL
        DO UPDATE SET
          source_url  = EXCLUDED.source_url,
          source_urls = EXCLUDED.source_urls,
          -- Give a failed import a genuine second chance; leave finished work alone.
          status          = CASE WHEN menu_ingestion_jobs.status = 'failed' THEN 'pending'
                                 ELSE menu_ingestion_jobs.status END,
          attempts        = CASE WHEN menu_ingestion_jobs.status = 'failed' THEN 0
                                 ELSE menu_ingestion_jobs.attempts END,
          next_attempt_at = CASE WHEN menu_ingestion_jobs.status = 'failed' THEN now()
                                 ELSE menu_ingestion_jobs.next_attempt_at END,
          last_error      = CASE WHEN menu_ingestion_jobs.status = 'failed' THEN NULL
                                 ELSE menu_ingestion_jobs.last_error END,
          updated_at      = now()
      RETURNING *
      `,
      [input.restaurantId, input.sourceKind, firstPage, JSON.stringify(pages), input.sha256]
    );
    return result.rows[0]!;
  }
  const result = await pool.query<MenuIngestionJob>(
    `INSERT INTO menu_ingestion_jobs (restaurant_id, source_kind, source_url, source_urls)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [input.restaurantId, input.sourceKind, firstPage, JSON.stringify(pages)]
  );
  return result.rows[0]!;
}

/**
 * Push `updated_at` forward on an in-flight job.
 *
 * The claim query re-claims any row stuck in 'processing' for 10 minutes, on the
 * assumption its worker died. A batched multi-page parse can legitimately run
 * that long (8 batches × a 60s model call), so without this a second worker
 * would grab a job that is still running — paying twice for the same menu and
 * racing to commit it. Called after each batch to prove we're alive.
 */
export async function heartbeatIngestionJob(id: string, db: DbClient = pool): Promise<void> {
  await db.query("UPDATE menu_ingestion_jobs SET updated_at = now() WHERE id = $1 AND status = 'processing'", [id]);
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

/**
 * Flip a parsed job to committed. Returns false if it was NOT still 'parsed' —
 * i.e. someone else committed it first.
 *
 * The `status = 'parsed'` predicate is the concurrency control: commitDraft
 * reads the job outside its transaction, so two simultaneous commits (a
 * double-click, or a retry racing the original) both saw 'parsed' and both
 * inserted the entire menu, duplicating every category and item. Whoever loses
 * this race updates 0 rows and rolls back.
 */
export async function markCommitted(id: string, db: DbClient = pool): Promise<boolean> {
  const result = await db.query(
    "UPDATE menu_ingestion_jobs SET status = 'committed' WHERE id = $1 AND status = 'parsed'",
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}
