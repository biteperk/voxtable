-- 009_menu_ingestion.sql
-- Async menu OCR ingestion jobs (Phase 2). A job tracks one uploaded menu
-- photo/PDF from upload → vision-LLM parse → owner review → commit. Reuses the
-- outbox worker pattern (claim with FOR UPDATE SKIP LOCKED, backoff retries).
-- Nothing touches menu_items until the owner confirms the parsed draft.

CREATE TABLE IF NOT EXISTS menu_ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('image', 'pdf')),
  source_url TEXT NOT NULL,
  -- sha256 of the uploaded file: dedupes accidental re-uploads of the same menu
  -- so we don't pay for the same parse twice.
  source_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'parsed', 'committed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- vision-LLM output: { categories: [{ name, items: [...] }] }. Editable by the
  -- owner before commit; prices are integer cents.
  parsed_draft JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker claim index: due jobs still in flight.
CREATE INDEX IF NOT EXISTS idx_menu_ingestion_pending
  ON menu_ingestion_jobs (next_attempt_at)
  WHERE status IN ('pending', 'processing');

-- Per-restaurant listing (newest first) for the wizard.
CREATE INDEX IF NOT EXISTS idx_menu_ingestion_restaurant
  ON menu_ingestion_jobs (restaurant_id, created_at DESC);

-- Idempotent re-upload guard: one job per (restaurant, file hash).
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_ingestion_dedup
  ON menu_ingestion_jobs (restaurant_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;

DROP TRIGGER IF EXISTS set_menu_ingestion_jobs_updated_at ON menu_ingestion_jobs;
CREATE TRIGGER set_menu_ingestion_jobs_updated_at
BEFORE UPDATE ON menu_ingestion_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
