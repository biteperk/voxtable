-- 018_legal_layer.sql
-- Legal layer for self-serve onboarding: the client's Order-Form elections on
-- restaurants, an APPEND-ONLY acceptance ledger (the evidence that a specific
-- document version was accepted, by whom, when), and a notice log for
-- subprocessor/fee/terms changes with their objection windows.
--
-- DDL discipline (per CLAUDE.md 08P01 gotcha): single-statement DDL, guarded
-- DO blocks, no GENERATED columns. The 'agreement' enum value is added in 017.

-- --- Order-Form elections on the restaurant --------------------------------
-- These are the values the owner elects in the "Service & data setup" wizard
-- step. They are CURRENT state (mutable via re-acceptance); the immutable
-- history lives in agreement_acceptances.order_form_json.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS client_legal_name TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS client_abn TEXT;
-- Sellable services only. 'voxdrive' must never appear here: it is a concept
-- product and its absence from the app-layer enum is the enforcement.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS services TEXT[] NOT NULL DEFAULT '{}';
-- Language(s) the agent operates in. en-AU only until multilingual ships —
-- the app layer refuses anything else (decision D2, 29 Jul 2026).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{en-AU}';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS phone_mode TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_targets JSONB;
-- Retell data_storage_retention_days source of truth. 30 or 90 (Schedule B
-- §8). Provisioning fails closed on NULL — "keep forever" must be impossible.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS retention_days INTEGER;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS storage_tier TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pii_redaction BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS service_start_date DATE;
-- Stamped when the owner has HEARD the agent (preview call) and approved it —
-- CSA 3.4 forbids connecting the live line before this.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS playback_approved_at TIMESTAMPTZ;
-- The document_set_version this restaurant most recently accepted.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS terms_version TEXT;

-- Value guards (guarded DO blocks — ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_retention_days') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_retention_days
      CHECK (retention_days IS NULL OR retention_days IN (30, 90));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_storage_tier') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_storage_tier
      CHECK (storage_tier IS NULL OR storage_tier IN ('everything', 'everything_except_pii'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_phone_mode') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_phone_mode
      CHECK (phone_mode IS NULL OR phone_mode IN ('forward_existing', 'new_dedicated'));
  END IF;
END $$;

-- --- Acceptance ledger ------------------------------------------------------
-- One row per acceptance event. APPEND-ONLY, enforced by trigger below — the
-- rows are legal evidence, and evidence that can be edited is not evidence.
-- channel 'offline' backfills a paper/email acceptance (existing customers).
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  user_id TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL DEFAULT 'online' CHECK (channel IN ('online', 'offline')),
  document_set_version TEXT NOT NULL,
  csa_sha256 TEXT NOT NULL,
  schedule_sha256 TEXT NOT NULL,
  consent_terms BOOLEAN NOT NULL,
  consent_overseas BOOLEAN NOT NULL,
  consent_disclosure BOOLEAN NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  order_form_json JSONB NOT NULL,
  order_form_pdf_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_restaurant
  ON agreement_acceptances (restaurant_id, accepted_at DESC);

-- Append-only enforcement: any UPDATE or DELETE raises. Deliberately no
-- escape hatch — corrections are a NEW row, and data-destruction requests are
-- handled at the restaurant level under the retention schedule, not by
-- editing the ledger.
CREATE OR REPLACE FUNCTION agreement_acceptances_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'agreement_acceptances is append-only (% blocked)', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agreement_acceptances_append_only') THEN
    CREATE TRIGGER trg_agreement_acceptances_append_only
      BEFORE UPDATE OR DELETE ON agreement_acceptances
      FOR EACH ROW EXECUTE FUNCTION agreement_acceptances_append_only();
  END IF;
END $$;

-- --- Notice log -------------------------------------------------------------
-- Subprocessor additions (30 days), fee changes (60 days), terms changes
-- (30 days): the exit/objection rights in the Schedule are only real if there
-- is a record the notice was delivered and when the window closes.
CREATE TABLE IF NOT EXISTS legal_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('subprocessor', 'fees', 'terms', 'announcement_override')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ,
  objection_deadline TIMESTAMPTZ,
  objected_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legal_notices_restaurant
  ON legal_notices (restaurant_id, sent_at DESC);

CREATE TRIGGER set_legal_notices_updated_at
  BEFORE UPDATE ON legal_notices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
