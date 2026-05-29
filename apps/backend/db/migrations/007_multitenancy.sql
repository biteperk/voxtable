-- 007_multitenancy.sql
-- Multi-tenant foundation: a users table keyed by Firebase uid, a
-- restaurant_members join table (user <-> restaurant + role), and the
-- voice-routing columns that map a dialed number to a restaurant.
--
-- The data layer is already tenant-scoped (every domain table has a
-- restaurant_id FK); this migration adds the IDENTITY layer that the
-- application uses to resolve "which restaurant is this request/call for".
--
-- DDL discipline (per CLAUDE.md 08P01 gotcha): single-statement DDL only,
-- guarded enum block, no GENERATED columns, functional index on lower(email)
-- instead of a generated lowercased column.

-- Role within a restaurant. Ranked staff < manager < owner at the app layer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
    CREATE TYPE member_role AS ENUM ('owner', 'manager', 'staff');
  END IF;
END $$;

-- One row per authenticated user. id is the Firebase uid (opaque string),
-- NOT a UUID. email_verified is mirrored from the Firebase token so the app
-- can gate cost/paid actions (OCR, provisioning) on a verified email.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness on email without a generated column.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (lower(email));

-- Membership: which users belong to which restaurant, and with what role.
-- A user can belong to many restaurants; a restaurant can have many members.
CREATE TABLE IF NOT EXISTS restaurant_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role member_role NOT NULL DEFAULT 'staff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, restaurant_id)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_members_user
  ON restaurant_members (user_id);

CREATE INDEX IF NOT EXISTS idx_restaurant_members_restaurant
  ON restaurant_members (restaurant_id);

-- Voice routing: the trusted dialed number (the number the caller rang) maps
-- to exactly one restaurant. twilio_phone_number is the VocoTable DID the
-- restaurant forwards their advertised line to; retell_phone_number is the
-- Retell-side inbound number. Both are stored normalized to E.164.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS retell_phone_number TEXT;

-- Partial unique indexes: many restaurants may have NULL numbers (not yet
-- provisioned), but any given number maps to at most one restaurant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_twilio_phone
  ON restaurants (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_retell_phone
  ON restaurants (retell_phone_number)
  WHERE retell_phone_number IS NOT NULL;

-- updated_at triggers (reuse the set_updated_at() function from 001).
DROP TRIGGER IF EXISTS set_users_updated_at ON users;
CREATE TRIGGER set_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_restaurant_members_updated_at ON restaurant_members;
CREATE TRIGGER set_restaurant_members_updated_at
BEFORE UPDATE ON restaurant_members
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
