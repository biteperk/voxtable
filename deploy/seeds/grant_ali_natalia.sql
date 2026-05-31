-- Make Ali's existing (legacy-bridge) access to Natalia's Bistro explicit, so
-- MULTITENANCY_LEGACY_FALLBACK=false does not lock him out. Manager role matches
-- his DASHBOARD_MANAGER_EMAILS level. Authorized by Sam (2026-05-30).
INSERT INTO users (id, email, name, email_verified)
VALUES ('VtYjIUM30rSYlhlfQkwaD0UipvF3', 'ali.alganzz@gmail.com', 'Ali Umit ALGAN', true)
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO restaurant_members (user_id, restaurant_id, role)
VALUES ('VtYjIUM30rSYlhlfQkwaD0UipvF3', '11111111-1111-4111-8111-111111111111', 'manager')
ON CONFLICT (user_id, restaurant_id) DO UPDATE SET role = 'manager';

SELECT u.email, r.name, rm.role
FROM restaurant_members rm
JOIN users u ON u.id = rm.user_id
JOIN restaurants r ON r.id = rm.restaurant_id
WHERE rm.user_id = 'VtYjIUM30rSYlhlfQkwaD0UipvF3';
