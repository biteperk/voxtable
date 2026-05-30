-- synthetic_test_restaurants.sql
-- Five synthetic "hypothesis" restaurants for exercising multi-tenant
-- operations after the onboarding cutover. Sam (skalaliya@gmail.com) is an
-- OWNER member of all five, so the dashboard restaurant-switcher + per-tenant
-- isolation can be driven end-to-end.
--
-- SAFE TO RUN ON PROD:
--   * Idempotent — every INSERT is ON CONFLICT DO NOTHING on a fixed UUID /
--     natural key, so re-running changes nothing.
--   * Additive — touches only these 5 restaurants (UUID range
--     d0000000-0000-4000-8000-00000000000{1..5}) and their children.
--   * Reversible — see the CLEANUP block at the bottom (commented out).
--
-- These restaurants are deliberately left UN-provisioned for voice
-- (twilio_phone_number / retell_phone_number are NULL) so no real inbound call
-- can ever route to a test tenant. Only Natalia's Bistro owns the live DID.
--
-- Run:  psql ... -v ON_ERROR_STOP=1 -f synthetic_test_restaurants.sql

BEGIN;

-- 1) Owner user (Sam). Real Firebase uid so dashboard auth + membership match.
INSERT INTO users (id, email, name, email_verified)
VALUES ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'skalaliya@gmail.com', 'Sam Kalaliya', true)
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      name = COALESCE(users.name, EXCLUDED.name),
      email_verified = users.email_verified OR EXCLUDED.email_verified;

-- 2) The five restaurants (distinct cuisines + AU timezones to exercise TZ).
--    All marked 'live' so they are immediately operable from the dashboard.
INSERT INTO restaurants
  (id, name, timezone, phone_number, transfer_phone_number,
   address, suburb, state, postcode, cuisine_type, contact_email, owner_name,
   onboarding_status, onboarding_completed_at)
VALUES
  ('d0000000-0000-4000-8000-000000000001', 'Saffron & Spice', 'Australia/Sydney',
   '+61286000001', NULL, '142 Crown Street', 'Surry Hills', 'NSW', '2010',
   ARRAY['Indian'], 'hello@saffronspice.test', 'Priya Nair', 'live', now()),
  ('d0000000-0000-4000-8000-000000000002', 'Bondi Greens', 'Australia/Sydney',
   '+61286000002', NULL, '88 Campbell Parade', 'Bondi Beach', 'NSW', '2026',
   ARRAY['Cafe','Healthy'], 'hello@bondigreens.test', 'Marcus Webb', 'live', now()),
  ('d0000000-0000-4000-8000-000000000003', 'Trattoria Marco', 'Australia/Melbourne',
   '+61386000003', NULL, '210 Lygon Street', 'Carlton', 'VIC', '3053',
   ARRAY['Italian'], 'hello@trattoriamarco.test', 'Marco Rossi', 'live', now()),
  ('d0000000-0000-4000-8000-000000000004', 'Sakura Teppan', 'Australia/Brisbane',
   '+61786000004', NULL, '5 Ann Street', 'Fortitude Valley', 'QLD', '4006',
   ARRAY['Japanese'], 'hello@sakurateppan.test', 'Yuki Tanaka', 'live', now()),
  ('d0000000-0000-4000-8000-000000000005', 'The Outback Grill', 'Australia/Adelaide',
   '+61886000005', NULL, '19 Jetty Road', 'Glenelg', 'SA', '5045',
   ARRAY['Steakhouse','Australian'], 'hello@outbackgrill.test', 'Dwayne Carter', 'live', now())
ON CONFLICT (id) DO NOTHING;

-- 3) Settings (one row per restaurant; varied booking durations).
INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes)
VALUES
  ('d0000000-0000-4000-8000-000000000001', 90),
  ('d0000000-0000-4000-8000-000000000002', 60),
  ('d0000000-0000-4000-8000-000000000003', 120),
  ('d0000000-0000-4000-8000-000000000004', 90),
  ('d0000000-0000-4000-8000-000000000005', 120)
ON CONFLICT (restaurant_id) DO NOTHING;

-- 4) Sam is OWNER of all five.
INSERT INTO restaurant_members (user_id, restaurant_id, role)
VALUES
  ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'd0000000-0000-4000-8000-000000000001', 'owner'),
  ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'd0000000-0000-4000-8000-000000000002', 'owner'),
  ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'd0000000-0000-4000-8000-000000000003', 'owner'),
  ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'd0000000-0000-4000-8000-000000000004', 'owner'),
  ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'd0000000-0000-4000-8000-000000000005', 'owner')
ON CONFLICT (user_id, restaurant_id) DO NOTHING;

-- 5) Tables (4 per restaurant). Fixed UUIDs => idempotent.
INSERT INTO tables (id, restaurant_id, label, min_capacity, max_capacity) VALUES
  -- Saffron & Spice
  ('d1000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 'T1', 1, 2),
  ('d1000000-0000-4000-8000-000000000102', 'd0000000-0000-4000-8000-000000000001', 'T2', 2, 4),
  ('d1000000-0000-4000-8000-000000000103', 'd0000000-0000-4000-8000-000000000001', 'T3', 4, 6),
  ('d1000000-0000-4000-8000-000000000104', 'd0000000-0000-4000-8000-000000000001', 'T4', 6, 10),
  -- Bondi Greens
  ('d1000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000002', 'B1', 1, 2),
  ('d1000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000002', 'B2', 2, 4),
  ('d1000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000002', 'B3', 2, 4),
  ('d1000000-0000-4000-8000-000000000204', 'd0000000-0000-4000-8000-000000000002', 'Patio', 4, 8),
  -- Trattoria Marco
  ('d1000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000003', 'M1', 2, 2),
  ('d1000000-0000-4000-8000-000000000302', 'd0000000-0000-4000-8000-000000000003', 'M2', 2, 4),
  ('d1000000-0000-4000-8000-000000000303', 'd0000000-0000-4000-8000-000000000003', 'M3', 4, 6),
  ('d1000000-0000-4000-8000-000000000304', 'd0000000-0000-4000-8000-000000000003', 'Booth', 4, 8),
  -- Sakura Teppan
  ('d1000000-0000-4000-8000-000000000401', 'd0000000-0000-4000-8000-000000000004', 'Teppan A', 4, 8),
  ('d1000000-0000-4000-8000-000000000402', 'd0000000-0000-4000-8000-000000000004', 'Teppan B', 4, 8),
  ('d1000000-0000-4000-8000-000000000403', 'd0000000-0000-4000-8000-000000000004', 'Sushi 1', 1, 2),
  ('d1000000-0000-4000-8000-000000000404', 'd0000000-0000-4000-8000-000000000004', 'Sushi 2', 2, 4),
  -- The Outback Grill
  ('d1000000-0000-4000-8000-000000000501', 'd0000000-0000-4000-8000-000000000005', 'G1', 2, 4),
  ('d1000000-0000-4000-8000-000000000502', 'd0000000-0000-4000-8000-000000000005', 'G2', 4, 6),
  ('d1000000-0000-4000-8000-000000000503', 'd0000000-0000-4000-8000-000000000005', 'G3', 6, 10),
  ('d1000000-0000-4000-8000-000000000504', 'd0000000-0000-4000-8000-000000000005', 'Bar', 1, 2)
ON CONFLICT (id) DO NOTHING;

-- 6) Customers (2 per restaurant). Fixed UUIDs => idempotent.
INSERT INTO customers (id, restaurant_id, name, phone) VALUES
  ('d2000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 'Anita Desai',  '+61400000101'),
  ('d2000000-0000-4000-8000-000000000102', 'd0000000-0000-4000-8000-000000000001', 'Raj Kapoor',    '+61400000102'),
  ('d2000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000002', 'Chloe Adams',   '+61400000201'),
  ('d2000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000002', 'Liam Patel',    '+61400000202'),
  ('d2000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000003', 'Sofia Bianchi', '+61400000301'),
  ('d2000000-0000-4000-8000-000000000302', 'd0000000-0000-4000-8000-000000000003', 'Tom Hughes',    '+61400000302'),
  ('d2000000-0000-4000-8000-000000000401', 'd0000000-0000-4000-8000-000000000004', 'Kenji Sato',    '+61400000401'),
  ('d2000000-0000-4000-8000-000000000402', 'd0000000-0000-4000-8000-000000000004', 'Mia Wong',      '+61400000402'),
  ('d2000000-0000-4000-8000-000000000501', 'd0000000-0000-4000-8000-000000000005', 'Jack Murphy',   '+61400000501'),
  ('d2000000-0000-4000-8000-000000000502', 'd0000000-0000-4000-8000-000000000005', 'Ella Brooks',   '+61400000502')
ON CONFLICT (id) DO NOTHING;

-- 7) A couple of upcoming reservations per restaurant (dashboards aren't empty).
--    Dates are wall-clock at each restaurant (TZ-naive DATE/TIME by design).
INSERT INTO reservations
  (id, restaurant_id, customer_id, table_id, reservation_date, start_time, party_size, status, source, notes)
VALUES
  ('d3000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000101', 'd1000000-0000-4000-8000-000000000102', '2026-05-30', '19:00', 4, 'confirmed', 'voice',     'Window seat if possible'),
  ('d3000000-0000-4000-8000-000000000102', 'd0000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000102', 'd1000000-0000-4000-8000-000000000103', '2026-05-31', '20:00', 6, 'confirmed', 'dashboard', NULL),
  ('d3000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000201', 'd1000000-0000-4000-8000-000000000202', '2026-05-30', '12:30', 2, 'confirmed', 'voice',     'Vegan'),
  ('d3000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000202', 'd1000000-0000-4000-8000-000000000204', '2026-06-01', '13:00', 5, 'pending',   'voice',     NULL),
  ('d3000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000301', 'd1000000-0000-4000-8000-000000000303', '2026-05-30', '19:30', 4, 'confirmed', 'voice',     'Anniversary'),
  ('d3000000-0000-4000-8000-000000000302', 'd0000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000302', 'd1000000-0000-4000-8000-000000000301', '2026-06-02', '18:00', 2, 'confirmed', 'dashboard', NULL),
  ('d3000000-0000-4000-8000-000000000401', 'd0000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000401', 'd1000000-0000-4000-8000-000000000401', '2026-05-31', '18:30', 6, 'confirmed', 'voice',     'Teppanyaki show'),
  ('d3000000-0000-4000-8000-000000000402', 'd0000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000402', 'd1000000-0000-4000-8000-000000000403', '2026-06-01', '19:00', 2, 'confirmed', 'voice',     NULL),
  ('d3000000-0000-4000-8000-000000000501', 'd0000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000501', 'd1000000-0000-4000-8000-000000000502', '2026-05-30', '20:00', 5, 'confirmed', 'voice',     'High chair needed'),
  ('d3000000-0000-4000-8000-000000000502', 'd0000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000502', 'd1000000-0000-4000-8000-000000000503', '2026-06-03', '19:00', 8, 'confirmed', 'dashboard', 'Birthday party')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Verify:
--   SELECT name, onboarding_status, timezone FROM restaurants
--     WHERE id BETWEEN 'd0000000-0000-4000-8000-000000000001'
--                  AND 'd0000000-0000-4000-8000-000000000005' ORDER BY name;
--   SELECT r.name, rm.role FROM restaurant_members rm
--     JOIN restaurants r ON r.id = rm.restaurant_id
--     WHERE rm.user_id = 'fBufe7XgkBYDDoQGXZj4aQ50c4T2';

-- ============================================================================
-- CLEANUP (run to remove all five test restaurants + children). Uncomment.
-- ON DELETE: reservations/tables/customers/members/settings cascade or are
-- removed here explicitly first to respect ON DELETE RESTRICT on reservations.
-- ----------------------------------------------------------------------------
-- BEGIN;
-- DELETE FROM reservations WHERE restaurant_id IN (
--   'd0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002',
--   'd0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000004',
--   'd0000000-0000-4000-8000-000000000005');
-- DELETE FROM customers WHERE restaurant_id IN (
--   'd0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002',
--   'd0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000004',
--   'd0000000-0000-4000-8000-000000000005');
-- DELETE FROM restaurants WHERE id IN (  -- cascades tables, settings, members
--   'd0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002',
--   'd0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000004',
--   'd0000000-0000-4000-8000-000000000005');
-- COMMIT;
