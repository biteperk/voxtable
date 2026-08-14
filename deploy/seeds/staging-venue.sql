-- staging-venue.sql — VoxTable Staging Venue, the STAGING end-to-end test
-- restaurant. Pattern: Cuban-Corner/cuban-corner-restaurant.sql.
--
-- This venue already EXISTS on staging (created 13 Aug 2026 during the
-- staging bring-up, previously uncommitted). This file makes it code: applying
-- it to a fresh staging database recreates the venue exactly; applying it to
-- the live one is a no-op plus whatever is newly added here (the menu).
--
-- SAFE TO RE-RUN:
--   * Idempotent — fixed UUIDs + bare ON CONFLICT DO NOTHING throughout, so
--     either the id or a natural-key constraint absorbs the duplicate.
--   * Additive — touches only this venue's rows.
--
-- THE ONE RULE: never bind a second venue to +61 468 203 234. Dialled-number
-- routing is `WHERE twilio_phone_number = $1 ... LIMIT 1` with NO uniqueness
-- constraint — two rows on one number would route calls arbitrarily.
--
-- Menu prices are load-bearing: smoke-orders.ts asserts Fish & Chips (2200)
-- + Large (+400) + Coke (0) totals exactly 2600. Change a price and the
-- staging smoke fails on purpose.
--
-- Apply via the throwaway Cloud Run job — deploy/runbooks/staging-venue.md.

BEGIN;

-- Owners / members. Membership (not the allowlist) is what makes the venue
-- visible on the dashboard; the email must ALSO be in staging's
-- DASHBOARD_ALLOWED_EMAILS for the request to get past the gate.
INSERT INTO users (id, email, name, email_verified)
VALUES ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', 'skalaliya@gmail.com', 'Sam Kalaliya', true)
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      name = COALESCE(users.name, EXCLUDED.name),
      email_verified = users.email_verified OR EXCLUDED.email_verified;

INSERT INTO restaurants
  (id, name, timezone, phone_number, transfer_phone_number,
   address, suburb, state, postcode, cuisine_type, contact_email, owner_name,
   onboarding_status, twilio_phone_number, retell_phone_number, retell_agent_id)
VALUES
  ('33333333-3333-4333-8333-333333333333', 'VoxTable Staging Venue', 'Australia/Sydney',
   '+61468203234', NULL,
   'Level 1 / 457-459 Elizabeth Street', 'Surry Hills', 'NSW', '2010',
   ARRAY['Test'],
   NULL,  -- contact_email stays NULL: keeps notifyRestaurant() quiet on re-binds
   NULL,
   'provisioning',  -- matches the live row; go-live is the admin endpoint's job
   '+61468203234',                          -- the staging Twilio number
   '+61468203234',
   'agent_b9087333b7030f0cee06a19ffc')      -- Staging workspace agent (Natalia's clone)
ON CONFLICT (id) DO NOTHING;

INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes, opening_hours_json)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  90,
  '{"monday":[{"open":"09:00","close":"23:00"}],
    "tuesday":[{"open":"09:00","close":"23:00"}],
    "wednesday":[{"open":"09:00","close":"23:00"}],
    "thursday":[{"open":"09:00","close":"23:00"}],
    "friday":[{"open":"09:00","close":"23:00"}],
    "saturday":[{"open":"09:00","close":"23:00"}],
    "sunday":[{"open":"09:00","close":"23:00"}]}'::jsonb
)
ON CONFLICT (restaurant_id) DO NOTHING;

INSERT INTO restaurant_members (user_id, restaurant_id, role)
VALUES ('fBufe7XgkBYDDoQGXZj4aQ50c4T2', '33333333-3333-4333-8333-333333333333', 'owner')
ON CONFLICT (user_id, restaurant_id) DO NOTHING;

-- 4 tables, matching the live rows created at bring-up (labels + capacities
-- read back from staging 14 Aug 2026). Bare ON CONFLICT so either the fixed
-- id or UNIQUE (restaurant_id, label) absorbs the duplicate — the live rows
-- carry their own ids for these labels.
INSERT INTO tables (id, restaurant_id, label, min_capacity, max_capacity) VALUES
  ('33333333-3333-4333-8333-000000000001', '33333333-3333-4333-8333-333333333333', 'S1', 1, 2),
  ('33333333-3333-4333-8333-000000000002', '33333333-3333-4333-8333-333333333333', 'S2', 2, 4),
  ('33333333-3333-4333-8333-000000000003', '33333333-3333-4333-8333-333333333333', 'S3', 3, 6),
  ('33333333-3333-4333-8333-000000000004', '33333333-3333-4333-8333-333333333333', 'S4', 4, 8)
ON CONFLICT DO NOTHING;

-- ───────────────────────────── Test menu ─────────────────────────────
-- Small on purpose: exactly what the smokes and the call battery exercise.
--   * Fish & Chips — the smoke-orders contract (prices asserted, see header).
--   * House Lager  — is_restricted: Bella must refuse it with the licensing line.
--   * Big Breakfast — menu window 09:00–11:30: refused outside the window.

INSERT INTO menu_categories (id, restaurant_id, name, display_order, is_active) VALUES
  ('33333333-3333-4333-8333-000000000101', '33333333-3333-4333-8333-333333333333', 'Mains', 1, true),
  ('33333333-3333-4333-8333-000000000102', '33333333-3333-4333-8333-333333333333', 'Breakfast', 2, true),
  ('33333333-3333-4333-8333-000000000103', '33333333-3333-4333-8333-333333333333', 'Drinks', 3, true)
ON CONFLICT DO NOTHING;

INSERT INTO menu_items
  (id, restaurant_id, category_id, name, description, base_price_cents,
   is_available, display_order, available_from, available_until, is_restricted)
VALUES
  ('33333333-3333-4333-8333-000000000201', '33333333-3333-4333-8333-333333333333',
   '33333333-3333-4333-8333-000000000101', 'Fish & Chips',
   'Beer-battered flathead with hand-cut chips and tartare.', 2200, true, 1,
   NULL, NULL, false),
  ('33333333-3333-4333-8333-000000000202', '33333333-3333-4333-8333-333333333333',
   '33333333-3333-4333-8333-000000000101', 'Garden Salad',
   'Leaves, tomato, cucumber, house dressing.', 1400, true, 2,
   NULL, NULL, false),
  ('33333333-3333-4333-8333-000000000203', '33333333-3333-4333-8333-333333333333',
   '33333333-3333-4333-8333-000000000102', 'Big Breakfast',
   'Eggs, bacon, sausage, mushrooms, toast. Breakfast hours only.', 2400, true, 1,
   '09:00', '11:30', false),
  ('33333333-3333-4333-8333-000000000204', '33333333-3333-4333-8333-333333333333',
   '33333333-3333-4333-8333-000000000103', 'Coke', NULL, 500, true, 1,
   NULL, NULL, false),
  ('33333333-3333-4333-8333-000000000205', '33333333-3333-4333-8333-333333333333',
   '33333333-3333-4333-8333-000000000103', 'House Lager',
   'Licensed item — dine-in with a meal only.', 900, true, 2,
   NULL, NULL, true)
ON CONFLICT DO NOTHING;

INSERT INTO menu_item_variants (id, menu_item_id, name, price_delta_cents, display_order) VALUES
  ('33333333-3333-4333-8333-000000000301', '33333333-3333-4333-8333-000000000201', 'Small',  -800, 1),
  ('33333333-3333-4333-8333-000000000302', '33333333-3333-4333-8333-000000000201', 'Medium',    0, 2),
  ('33333333-3333-4333-8333-000000000303', '33333333-3333-4333-8333-000000000201', 'Large',   400, 3)
ON CONFLICT DO NOTHING;

INSERT INTO menu_item_modifiers
  (id, menu_item_id, group_name, name, price_delta_cents,
   group_min_select, group_max_select, is_default, display_order)
VALUES
  ('33333333-3333-4333-8333-000000000401', '33333333-3333-4333-8333-000000000201',
   'Drink', 'Coke', 0, 1, 1, true, 1),
  ('33333333-3333-4333-8333-000000000402', '33333333-3333-4333-8333-000000000201',
   'Drink', 'Lemonade', 0, 1, 1, false, 2),
  ('33333333-3333-4333-8333-000000000403', '33333333-3333-4333-8333-000000000201',
   'Drink', 'Sparkling Water', 0, 1, 1, false, 3)
ON CONFLICT DO NOTHING;

COMMIT;

-- CLEANUP (only if the venue must be rebuilt from scratch; order matters —
-- order_items/reservations FKs are RESTRICT):
-- BEGIN;
-- DELETE FROM menu_item_modifiers WHERE menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = '33333333-3333-4333-8333-333333333333');
-- DELETE FROM menu_item_variants  WHERE menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = '33333333-3333-4333-8333-333333333333');
-- DELETE FROM menu_items          WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';
-- DELETE FROM menu_categories     WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';
-- DELETE FROM tables              WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';
-- DELETE FROM restaurant_members  WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';
-- DELETE FROM restaurant_settings WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';
-- DELETE FROM restaurants         WHERE id = '33333333-3333-4333-8333-333333333333';
-- COMMIT;
