CREATE TABLE IF NOT EXISTS operations.provisioning_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  step TEXT NOT NULL DEFAULT 'buy_number'
    CHECK (step IN ('buy_number', 'configure_voice', 'create_agent', 'bind', 'complete')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provisioning_pending
  ON operations.provisioning_jobs (next_attempt_at)
  WHERE status IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_one_active
  ON operations.provisioning_jobs (restaurant_id)
  WHERE status IN ('pending', 'processing');

DROP TRIGGER IF EXISTS set_provisioning_jobs_updated_at ON operations.provisioning_jobs;
CREATE TRIGGER set_provisioning_jobs_updated_at
BEFORE UPDATE ON operations.provisioning_jobs
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
