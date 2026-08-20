-- Mirror of migrations/018_legal_layer.sql (notice-log half).
--
-- Subprocessor additions (30 days), fee changes (60 days), terms changes
-- (30 days): the exit/objection rights in the Schedule are only real if there
-- is a record the notice was delivered and when the window closes.

CREATE TABLE IF NOT EXISTS core.legal_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id),
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
  ON core.legal_notices (restaurant_id, sent_at DESC);

DROP TRIGGER IF EXISTS set_legal_notices_updated_at ON core.legal_notices;
CREATE TRIGGER set_legal_notices_updated_at
BEFORE UPDATE ON core.legal_notices
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
