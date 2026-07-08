import { DbClient, pool } from "../db/pool";

export type ProvisioningStep = "buy_number" | "configure_voice" | "create_agent" | "bind" | "complete";

export interface ProvisioningJobPayload {
  twilio_number?: string;
  twilio_sid?: string;
  retell_agent_id?: string;
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

/** Advance the step + merge acquired resources into payload (resumable). */
export async function advanceProvisioningStep(
  id: string,
  step: ProvisioningStep,
  payloadPatch: ProvisioningJobPayload
): Promise<void> {
  await pool.query(
    `UPDATE provisioning_jobs
        SET step = $2, payload = payload || $3::jsonb, status = 'pending', last_error = NULL
      WHERE id = $1`,
    [id, step, JSON.stringify(payloadPatch)]
  );
}

export async function markProvisioningDone(id: string): Promise<void> {
  await pool.query("UPDATE provisioning_jobs SET status = 'done', step = 'complete' WHERE id = $1", [id]);
}

export async function markProvisioningRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
  await pool.query(
    "UPDATE provisioning_jobs SET status = 'pending', next_attempt_at = $2, last_error = $3 WHERE id = $1",
    [id, nextAttemptAt.toISOString(), error.slice(0, 500)]
  );
}

export async function markProvisioningFailed(id: string, error: string): Promise<void> {
  await pool.query("UPDATE provisioning_jobs SET status = 'failed', last_error = $2 WHERE id = $1", [
    id,
    error.slice(0, 500)
  ]);
}
