-- 019_onboarding_events.sql
-- Onboarding transition audit: one row per onboarding_status change, written
-- by a trigger so every path (wizard, Stripe webhook, admin console, cleanup
-- worker) is captured without any route-level bookkeeping. Ported from the
-- split-services baseline (operations.onboarding_events) into the live
-- append-only chain — public schema, additive, per the migration discipline.
--
-- DDL discipline (per CLAUDE.md 08P01 gotcha): single-statement DDL, guarded
-- DO block for the trigger, no GENERATED columns.

CREATE TABLE IF NOT EXISTS onboarding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_events_restaurant
  ON onboarding_events (restaurant_id, at);

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_onboarding_transition') THEN
    CREATE TRIGGER trg_onboarding_transition
      AFTER UPDATE OF onboarding_status ON restaurants
      FOR EACH ROW EXECUTE FUNCTION log_onboarding_transition();
  END IF;
END $$;
