CREATE OR REPLACE FUNCTION core.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.log_onboarding_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.onboarding_status IS DISTINCT FROM OLD.onboarding_status THEN
    INSERT INTO operations.onboarding_events (restaurant_id, from_status, to_status)
    VALUES (NEW.id, OLD.onboarding_status::text, NEW.onboarding_status::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
