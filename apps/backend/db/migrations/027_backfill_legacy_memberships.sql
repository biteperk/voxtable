-- Give the last allowlist-only operator a real membership row, so the
-- MULTITENANCY_LEGACY_FALLBACK bridge can be removed.
--
-- That flag grants any authenticated user whose email is in
-- DASHBOARD_ALLOWED_EMAILS access to DEFAULT_RESTAURANT_ID when they have no
-- restaurant_members row. It shipped as a bridge between deploying the
-- multi-tenant code and running the backfill, and it has been on ever since —
-- a second, invisible authorisation path that no membership table records and
-- no audit of restaurant_members would ever show.
--
-- Production, checked 2 Aug 2026: of the five allowlisted addresses, only
-- abhishekyadav01@gmail.com has ever signed in AND has no membership. Everyone
-- else either owns a restaurant already or has no users row at all. So this one
-- row is the entire remaining dependency on the bridge.
--
-- Role is 'manager' — it matches his existing DASHBOARD_MANAGER_EMAILS entry,
-- so his access is unchanged and simply comes from the membership table rather
-- than from a flag.
--
-- Matched by email rather than by uid: the uid is a Firebase implementation
-- detail, and this way the migration is a readable no-op on a fresh database
-- (CI, a new environment, the Sydney rebuild) where that user does not exist.
-- Idempotent via ON CONFLICT, and DEFAULT_RESTAURANT_ID is spelled out because
-- a migration cannot read the application's env.

INSERT INTO restaurant_members (user_id, restaurant_id, role)
SELECT u.id, '11111111-1111-4111-8111-111111111111'::uuid, 'manager'::member_role
FROM users u
WHERE lower(u.email) = 'abhishekyadav01@gmail.com'
  AND EXISTS (
    SELECT 1 FROM restaurants r
    WHERE r.id = '11111111-1111-4111-8111-111111111111'::uuid
  )
ON CONFLICT (user_id, restaurant_id) DO NOTHING;
