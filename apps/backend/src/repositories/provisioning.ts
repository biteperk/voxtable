import { DbClient, pool } from "../db/pool";

export type ProvisioningStep = "buy_number" | "configure_voice" | "create_agent" | "bind" | "complete";

export interface ProvisioningJobPayload {
  twilio_number?: string;
  twilio_sid?: string;
  retell_agent_id?: string;
  /**
   * Set immediately BEFORE we ask Twilio for a number, so a crash between the
   * purchase and recording the result is detectable. Without it the reaper
   * re-runs buy_number against an empty payload and buys a SECOND number we pay
   * for every month. See the buy_number step in workers/provisioningWorker.ts.
   */
  buy_started_at?: string;
}

export interface ProvisioningJob {
  id: string;
  restaurant_id: string;
  status: "pending" | "processing" | "done" | "failed";
  step: ProvisioningStep;
  attempts: number;
  next_attempt_at: string;
  payload: ProvisioningJobPayload;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Enqueue a provisioning job. Idempotent via the partial unique index — if an
 * active job already exists for the restaurant, this is a no-op and returns it.
 */
export async function enqueueProvisioningJob(restaurantId: string): Promise<ProvisioningJob | null> {
  const result = await pool.query<ProvisioningJob>(
    `
    INSERT INTO provisioning_jobs (restaurant_id)
    VALUES ($1)
    ON CONFLICT (restaurant_id) WHERE status IN ('pending', 'processing')
      DO NOTHING
    RETURNING *
    `,
    [restaurantId]
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await pool.query<ProvisioningJob>(
    "SELECT * FROM provisioning_jobs WHERE restaurant_id = $1 AND status IN ('pending','processing') LIMIT 1",
    [restaurantId]
  );
  return existing.rows[0] ?? null;
}

export async function claimReadyProvisioningJobs(limit: number, db: DbClient = pool): Promise<ProvisioningJob[]> {
  const result = await db.query<ProvisioningJob>(
    `
    UPDATE provisioning_jobs
    SET status = 'processing', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM provisioning_jobs
      WHERE (status = 'pending' AND next_attempt_at <= now())
         -- Reaper: re-claim jobs whose worker died mid-step (crash/redeploy).
         -- Safe because steps are resumable via payload ("already done?"
         -- checks); without this a crashed job is orphaned forever.
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

/**
 * Advance the step + merge acquired resources into payload (resumable).
 *
 * Resets `attempts`, because a completed step is real progress: the budget is
 * there to stop a step failing forever, not to cap how many steps a healthy job
 * may complete. Without the reset a clean 4-step run burned 4 of 6 attempts, so
 * two unrelated blips permanently failed a paying customer's provisioning.
 */
export async function advanceProvisioningStep(
  id: string,
  step: ProvisioningStep,
  payloadPatch: ProvisioningJobPayload
): Promise<void> {
  await pool.query(
    `UPDATE provisioning_jobs
        SET step = $2, payload = payload || $3::jsonb, status = 'pending', attempts = 0, last_error = NULL
      WHERE id = $1`,
    [id, step, JSON.stringify(payloadPatch)]
  );
}

/**
 * Merge into payload WITHOUT touching status, step or attempts — the job keeps
 * its 'processing' lease. Used to record intent before an irreversible external
 * call (buying a Twilio number): advanceProvisioningStep would flip status back
 * to 'pending' and hand the job to another claim mid-purchase.
 */
export async function patchProvisioningPayload(
  id: string,
  payloadPatch: ProvisioningJobPayload
): Promise<void> {
  await pool.query(
    "UPDATE provisioning_jobs SET payload = payload || $2::jsonb WHERE id = $1",
    [id, JSON.stringify(payloadPatch)]
  );
}

export async function markProvisioningDone(id: string): Promise<void> {
  await pool.query("UPDATE provisioning_jobs SET status = 'done', step = 'complete' WHERE id = $1", [id]);
}

/**
 * Remove one key from the payload. Exists so the buy_number step can clear
 * its crash-window marker when Twilio PROVABLY rejected the purchase (4xx) —
 * leaving the marker in place turned a rate-limit blip into a permanently
 * failed job for a paying customer.
 */
export async function clearProvisioningPayloadKey(
  id: string,
  key: keyof ProvisioningJobPayload
): Promise<void> {
  await pool.query("UPDATE provisioning_jobs SET payload = payload - $2::text WHERE id = $1", [id, key]);
}

export async function markProvisioningRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
  await pool.query(
    "UPDATE provisioning_jobs SET status = 'pending', next_attempt_at = $2, last_error = $3 WHERE id = $1",
    [id, nextAttemptAt.toISOString(), error.slice(0, 500)]
  );
}

export interface ProvisioningJobWithVenue extends ProvisioningJob {
  restaurant_name: string | null;
}

export async function listProvisioningJobs(
  status?: ProvisioningJob["status"]
): Promise<ProvisioningJobWithVenue[]> {
  const params: string[] = [];
  let where = "";
  if (status) {
    params.push(status);
    where = "WHERE j.status = $1";
  }
  const result = await pool.query<ProvisioningJobWithVenue>(
    `SELECT j.*, r.name AS restaurant_name
       FROM provisioning_jobs j
       LEFT JOIN restaurants r ON r.id = j.restaurant_id
       ${where}
      ORDER BY j.updated_at DESC
      LIMIT 100`,
    params
  );
  return result.rows;
}

/**
 * Reset a FAILED job in place so the worker picks it up again. Never inserts:
 * the unique index is partial (active statuses only), so enqueueing while a
 * failed row exists creates a SECOND job with an empty payload — and an empty
 * payload means the buy_number step purchases another Twilio number we pay
 * for monthly. Preserving the row preserves the payload. Returns null when
 * the job doesn't exist or isn't failed.
 */
export async function resetFailedProvisioningJob(id: string): Promise<ProvisioningJob | null> {
  const result = await pool.query<ProvisioningJob>(
    `UPDATE provisioning_jobs
        SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE id = $1 AND status = 'failed'
      RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function markProvisioningFailed(id: string, error: string): Promise<void> {
  await pool.query("UPDATE provisioning_jobs SET status = 'failed', last_error = $2 WHERE id = $1", [
    id,
    error.slice(0, 500)
  ]);
}
