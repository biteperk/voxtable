CREATE TABLE IF NOT EXISTS operations.onboarding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_events_restaurant
  ON operations.onboarding_events (restaurant_id, at);

DROP TRIGGER IF EXISTS trg_onboarding_transition ON core.restaurants;
CREATE TRIGGER trg_onboarding_transition
AFTER UPDATE OF onboarding_status ON core.restaurants
FOR EACH ROW EXECUTE FUNCTION core.log_onboarding_transition();
