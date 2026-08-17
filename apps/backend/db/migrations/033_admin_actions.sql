-- 033: admin_actions — who did what on the platform-admin surface.
--
-- Every mutating /api/admin/* call writes one row. The dashboard and the legal
-- ledger are only trustworthy if operator actions are attributable: before this
-- table, binding a phone number to the wrong venue left no record of who did it
-- (the request log deliberately drops bodies and carries no uid).
--
-- Append-only by convention, not by trigger: this is an operational trail, not
-- legal evidence — agreement_acceptances keeps its triggers, this stays cheap.

CREATE TABLE IF NOT EXISTS admin_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_uid     TEXT NOT NULL,
  actor_email   TEXT,
  action        TEXT NOT NULL,
  -- Nullable: some actions (support-request updates) target a venue indirectly,
  -- and the venue may be deleted later — the trail must outlive it, so no FK.
  restaurant_id UUID,
  -- Free-form secondary target (job id, support-request id, field list).
  target        TEXT,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created
  ON admin_actions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_actions_restaurant
  ON admin_actions (restaurant_id, created_at DESC)
  WHERE restaurant_id IS NOT NULL;
