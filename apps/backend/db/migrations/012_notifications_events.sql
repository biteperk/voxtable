-- 012_notifications_events.sql
-- Phase 5: a durable notification outbox (email/SMS) and an onboarding funnel
-- event log. Notifications go through an outbox so a provider outage never
-- blocks the onboarding/booking path. Funnel events are captured by a trigger
-- so EVERY onboarding_status transition is recorded regardless of code path.

CREATE TABLE IF NOT EXISTS notifications_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON notifications_outbox (next_attempt_at)
  WHERE status = 'pending';

-- Onboarding funnel: one row per status transition, for drop-off analytics.
CREATE TABLE IF NOT EXISTS onboarding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_events_restaurant
  ON onboarding_events (restaurant_id, at);

-- Capture every onboarding_status change automatically (can't be bypassed by a
-- code path that updates the column directly).
CREATE OR REPLACE FUNCTION log_onboarding_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.onboarding_status IS DISTINCT FROM OLD.onboarding_status THEN
    INSERT INTO onboarding_events (restaurant_id, from_status, to_status)
    VALUES (NEW.id, OLD.onboarding_status::text, NEW.onboarding_status::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onboarding_transition ON restaurants;
CREATE TRIGGER trg_onboarding_transition
AFTER UPDATE OF onboarding_status ON restaurants
FOR EACH ROW EXECUTE FUNCTION log_onboarding_transition();
