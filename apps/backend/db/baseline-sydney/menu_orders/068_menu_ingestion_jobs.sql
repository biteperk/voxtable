CREATE TABLE IF NOT EXISTS menu_orders.menu_ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('image', 'pdf')),
  source_url TEXT NOT NULL,
  source_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'parsed', 'committed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_draft JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_ingestion_pending
  ON menu_orders.menu_ingestion_jobs (next_attempt_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_menu_ingestion_restaurant
  ON menu_orders.menu_ingestion_jobs (restaurant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_ingestion_dedup
  ON menu_orders.menu_ingestion_jobs (restaurant_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;

DROP TRIGGER IF EXISTS set_menu_ingestion_jobs_updated_at ON menu_orders.menu_ingestion_jobs;
CREATE TRIGGER set_menu_ingestion_jobs_updated_at
BEFORE UPDATE ON menu_orders.menu_ingestion_jobs
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
