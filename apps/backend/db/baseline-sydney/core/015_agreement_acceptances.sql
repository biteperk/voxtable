-- Mirror of migrations/018_legal_layer.sql (ledger half) + 032.
--
-- One row per acceptance event: the evidence that a specific document version
-- was accepted, by whom, when. APPEND-ONLY, enforced by the trigger below —
-- rows are legal evidence, and evidence that can be edited is not evidence.
-- channel 'offline' backfills a paper/email acceptance (existing customers).

CREATE TABLE IF NOT EXISTS core.agreement_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id),
  user_id TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL DEFAULT 'online' CHECK (channel IN ('online', 'offline')),
  document_set_version TEXT NOT NULL,
  csa_sha256 TEXT NOT NULL,
  schedule_sha256 TEXT NOT NULL,
  -- Migration 032. Where the documents lived: a recorded digest with no
  -- provenance cannot be checked against anything.
  csa_url TEXT,
  schedule_url TEXT,
  consent_terms BOOLEAN NOT NULL,
  consent_overseas BOOLEAN NOT NULL,
  consent_disclosure BOOLEAN NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  order_form_json JSONB NOT NULL,
  order_form_pdf_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_restaurant
  ON core.agreement_acceptances (restaurant_id, accepted_at DESC);

-- Append-only enforcement: any UPDATE or DELETE raises. Deliberately no escape
-- hatch — corrections are a NEW row, and data-destruction requests are handled
-- at the restaurant level under the retention schedule, not by editing this.
CREATE OR REPLACE FUNCTION core.agreement_acceptances_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'agreement_acceptances is append-only (% blocked)', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agreement_acceptances_append_only ON core.agreement_acceptances;
CREATE TRIGGER trg_agreement_acceptances_append_only
  BEFORE UPDATE OR DELETE ON core.agreement_acceptances
  FOR EACH ROW EXECUTE FUNCTION core.agreement_acceptances_append_only();

-- Mirror of migrations/029_least_privilege.sql. Row-level triggers never fire
-- on TRUNCATE, which was the one silent mass-delete left open. A statement-
-- level BEFORE TRUNCATE trigger closes it for every role short of a superuser
-- who first drops the trigger — and the runtime role cannot do that (see
-- 099_least_privilege.sql).
CREATE OR REPLACE FUNCTION core.refuse_truncate_agreement_acceptances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agreement_acceptances is an append-only ledger; TRUNCATE is never legitimate here';
END;
$$;

DROP TRIGGER IF EXISTS agreement_acceptances_no_truncate ON core.agreement_acceptances;
CREATE TRIGGER agreement_acceptances_no_truncate
  BEFORE TRUNCATE ON core.agreement_acceptances
  FOR EACH STATEMENT
  EXECUTE FUNCTION core.refuse_truncate_agreement_acceptances();
