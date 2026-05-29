-- 008_onboarding_profile.sql
-- Restaurant self-serve onboarding: profile fields, provisioning bindings, and
-- the onboarding state machine column that drives the signup wizard.
--
-- DDL discipline (per CLAUDE.md 08P01 gotcha): single-statement DDL, guarded
-- enum block, no GENERATED columns.

-- Profile captured during onboarding.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS suburb TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS postcode TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS cuisine_type TEXT[];
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT;
-- The restaurant's EXISTING advertised number (what they forward to Bella).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS existing_phone_number TEXT;

-- Provisioning bindings (filled later by billing + telephony phases).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS retell_agent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_stripe_customer
  ON restaurants (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Onboarding state machine. Names match the codebase's UK 'cancelled' spelling
-- (cf. reservation_status). Order: account_created → profile → menu → trial →
-- provisioning → live. suspended/cancelled are side states.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_status') THEN
    CREATE TYPE onboarding_status AS ENUM (
      'account_created',
      'profile',
      'menu',
      'trial',
      'provisioning',
      'live',
      'suspended',
      'cancelled'
    );
  END IF;
END $$;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS onboarding_status onboarding_status NOT NULL DEFAULT 'account_created';

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Every restaurant that exists BEFORE this feature is already operational, so
-- mark it live (it must not be trapped in the wizard). Static SQL can't read
-- DEFAULT_RESTAURANT_ID, so this is unconditional — at migration time the only
-- rows present are pre-onboarding. Future inserts get the 'account_created'
-- default and flow through the wizard.
UPDATE restaurants
  SET onboarding_status = 'live',
      onboarding_completed_at = COALESCE(onboarding_completed_at, now())
  WHERE onboarding_status = 'account_created';
