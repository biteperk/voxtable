-- 015_staff_invites.sql
-- Manager-driven staff onboarding: a manager sends an invite (email + role), the
-- system generates a unique token the invitee opens to join the restaurant.
-- Pending invites expire after N days (default 7, enforced at the app layer).
--
-- Depends on 014 having COMMITTED the 'server'/'kitchen' enum values: the role
-- column defaults to 'server', which is only legal once that ADD VALUE is
-- committed (you cannot use a freshly-added enum value in the same txn — that is
-- precisely why the enum extension is a separate, earlier migration).

CREATE TABLE IF NOT EXISTS staff_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role member_role NOT NULL DEFAULT 'server',
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one pending invite per email per restaurant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_invites_pending
  ON staff_invites (restaurant_id, lower(email))
  WHERE status = 'pending';

-- Fast lookup by token (the accept-invite flow).
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_invites_token
  ON staff_invites (token)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_staff_invites_restaurant
  ON staff_invites (restaurant_id);

-- updated_at trigger (reuses the set_updated_at() function from 001).
DROP TRIGGER IF EXISTS set_staff_invites_updated_at ON staff_invites;
CREATE TRIGGER set_staff_invites_updated_at
BEFORE UPDATE ON staff_invites
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
