-- 011_provisioning_jobs.sql
-- Phase 4b: durable, step-tracked automated provisioning. One job per restaurant
-- drives: buy Twilio number → configure voice → create Retell agent → bind.
-- `step` + `payload` make retries idempotent: a partially-completed provision
-- resumes from the last completed step and never re-buys a number.

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  step TEXT NOT NULL DEFAULT 'buy_number'
    CHECK (step IN ('buy_number', 'configure_voice', 'create_agent', 'bind', 'complete')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- accumulates acquired resources as steps complete (twilio_number, twilio_sid,
  -- retell_agent_id) so a retry checks "already done?" before acting.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provisioning_pending
  ON provisioning_jobs (next_attempt_at)
  WHERE status IN ('pending', 'processing');

-- One active job per restaurant (re-enqueue is idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_one_active
  ON provisioning_jobs (restaurant_id)
  WHERE status IN ('pending', 'processing');

DROP TRIGGER IF EXISTS set_provisioning_jobs_updated_at ON provisioning_jobs;
CREATE TRIGGER set_provisioning_jobs_updated_at
BEFORE UPDATE ON provisioning_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
