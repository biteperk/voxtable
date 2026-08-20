CREATE TABLE IF NOT EXISTS core.restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  phone_number TEXT,
  transfer_phone_number TEXT,
  twilio_phone_number TEXT,
  retell_phone_number TEXT,
  address TEXT,
  suburb TEXT,
  state TEXT,
  postcode TEXT,
  cuisine_type TEXT[],
  contact_email TEXT,
  owner_name TEXT,
  logo_url TEXT,
  existing_phone_number TEXT,
  stripe_customer_id TEXT,
  retell_agent_id TEXT,
  calcom_event_type_id INTEGER,
  onboarding_status core.onboarding_status NOT NULL DEFAULT 'account_created',
  onboarding_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_twilio_phone
  ON core.restaurants (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_retell_phone
  ON core.restaurants (retell_phone_number)
  WHERE retell_phone_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_stripe_customer
  ON core.restaurants (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Migration 035. Two venues sharing one Cal.com event type means one venue's
-- online diners book the other venue's tables.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_calcom_event_type
  ON core.restaurants (calcom_event_type_id)
  WHERE calcom_event_type_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_restaurants_updated_at ON core.restaurants;
CREATE TRIGGER set_restaurants_updated_at
BEFORE UPDATE ON core.restaurants
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
