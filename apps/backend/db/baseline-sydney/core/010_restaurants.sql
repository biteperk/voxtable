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

  -- Migration 018 — Order-Form elections. CURRENT state, mutable via
  -- re-acceptance; the immutable history lives in
  -- core.agreement_acceptances.order_form_json.
  client_legal_name TEXT,
  client_abn TEXT,
  -- Sellable services only. 'voxdrive' must never appear here: it is a concept
  -- product and its absence from the app-layer enum is the enforcement.
  services TEXT[] NOT NULL DEFAULT '{}',
  -- en-AU only until multilingual ships (decision D2, 29 Jul 2026).
  languages TEXT[] NOT NULL DEFAULT '{en-AU}',
  phone_mode TEXT CHECK (phone_mode IS NULL OR phone_mode IN ('forward_existing', 'new_dedicated')),
  delivery_targets JSONB,
  -- Retell data_storage_retention_days source of truth (Schedule B §8).
  -- Provisioning fails closed on NULL — "keep forever" must be impossible.
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days IN (30, 90)),
  storage_tier TEXT CHECK (storage_tier IS NULL OR storage_tier IN ('everything', 'everything_except_pii')),
  pii_redaction BOOLEAN NOT NULL DEFAULT false,
  service_start_date DATE,
  -- Stamped when the owner has HEARD the agent and approved it — CSA 3.4
  -- forbids connecting the live line before this.
  playback_approved_at TIMESTAMPTZ,
  -- The document_set_version this restaurant most recently accepted.
  terms_version TEXT,

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

-- Migration 034. A Retell agent carries a venue's identity, prompt and tool
-- endpoints, so a shared one answers in the wrong venue's voice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_retell_agent
  ON core.restaurants (retell_agent_id)
  WHERE retell_agent_id IS NOT NULL;

-- Migration 035. Two venues sharing one Cal.com event type means one venue's
-- online diners book the other venue's tables.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_calcom_event_type
  ON core.restaurants (calcom_event_type_id)
  WHERE calcom_event_type_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_restaurants_updated_at ON core.restaurants;
CREATE TRIGGER set_restaurants_updated_at
BEFORE UPDATE ON core.restaurants
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
