-- Mirror of migrations/033_admin_actions.sql.
--
-- Append-only by convention, not by trigger: this is an operational trail, not
-- legal evidence — core.agreement_acceptances keeps its triggers, this stays
-- cheap.

CREATE TABLE IF NOT EXISTS operations.admin_actions (
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
  ON operations.admin_actions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_actions_restaurant
  ON operations.admin_actions (restaurant_id, created_at DESC)
  WHERE restaurant_id IS NOT NULL;
