-- ⚠️ SUPERSEDED IN PART, 18 Aug 2026 — the staging venue is becoming Mazcina.
--
-- This file still describes the venue's ROW, SETTINGS and TABLES, and those are
-- still correct. Human MEMBERS left this file on 26 Aug 2026 — see the banner at
-- the end for why. Its MENU is not correct either: the five fixture items below are
-- being retired in favour of Mazcina's real 31-item menu.
--   * retire the fixtures: deploy/seeds/mazcina-retire-fixture-menu.sql
--   * import the real menu: mazcina/mazcina-menu-voxtable-import.json
--   * the whole procedure:  deploy/runbooks/mazcina-staging-conversion.md
--
-- The venue name, hours and tables here are ALSO still the synthetic ones. They
-- are deliberately not rewritten yet: the real trading hours and floor plan have
-- not been supplied, and inventing them would make every availability and
-- booking test meaningless. Update this file once they arrive.
--
-- Note the restaurants INSERT is ON CONFLICT (id) DO NOTHING, so editing this
-- file never changes the LIVE staging row — the runbook's API calls do.
--
-- ⚠️ NAME DRIFT (verified against staging 19 Aug 2026): the live row
-- 33333333-… is named "Natalia Bistro", not "VoxTable Staging Venue". The
-- restaurants INSERT below is ON CONFLICT (id) DO NOTHING and the row already
-- existed, so this file's name never applied. Do not read the name below as a
-- description of staging, and do not match on it — match on the id.
-- deploy/runbooks/mazcina-staging-conversion.md §1 renames it to Mazcina.
--
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
-- THE ONE RULE: never bind a second venue to +61 468 203 234, and never bind
-- another venue's Retell agent to this row.
--
-- (Correction, 18 Aug 2026: this comment used to claim the number columns have
-- NO uniqueness constraint. They do — migration 007 gives each a partial unique
-- index — so a duplicate number is rejected by the database. The gap was the
-- AGENT: `retell_agent_id` was bare TEXT with no constraint at all, which is
-- how this very file came to bind Natalia's agent to this venue. Migration 034
-- closes it, and the routing query is now ORDER BY'd so the cross-column
-- twilio/retell OR cannot resolve arbitrarily either.)
--
-- Menu prices are load-bearing: smoke-orders.ts asserts Fish & Chips (2200)
-- + Large (+400) + Coke (0) totals exactly 2600. Change a price and the
-- staging smoke fails on purpose.
--
-- Apply via the throwaway Cloud Run job — deploy/runbooks/staging-venue.md.

BEGIN;

-- Human members are NOT seeded here, deliberately — see the banner at the end of
-- this file. Membership (not the allowlist) is what makes the venue visible on the
-- dashboard, and it is granted against the environment, where the uid can be
-- resolved from the email rather than transcribed.

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
   -- retell_agent_id is deliberately NULL. It used to carry
   -- 'agent_b9087333b7030f0cee06a19ffc', which is "Natalia's Bistro (STAGING)"
   -- — another venue's agent, whose prompt hard-codes that venue's name and its
   -- owner's. On a real call (18 Aug 2026) this line resolved to the RIGHT
   -- restaurant and then answered as the wrong one.
   --
   -- Binding an agent is now the admin endpoint's job, not the seed's:
   -- PATCH /api/admin/restaurants/:id/provisioning verifies the agent exists in
   -- Retell and is named for THIS venue before storing it. A seed cannot do
   -- that, and a NULL now fails loudly (retell_inbound_no_agent_bound) instead
   -- of quietly borrowing someone else's voice.
   NULL)
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

-- The machine smoke user: a password identity in the STAGING Firebase project
-- (biteperk@gmail.com, uid below; password lives in staging Secret Manager as
-- voxtable-stg-smoke-user-password). smoke:staging mints its token as this
-- user, so it needs the same membership a human member would. Note staging's
-- DASHBOARD_ALLOWED_EMAILS currently lists ONLY biteperk@gmail.com.
INSERT INTO users (id, email, name, email_verified)
VALUES ('HWdoEEhHvGZuOvwQ0AsxKXdYZHI2', 'biteperk@gmail.com', 'BitePerk Smoke', true)
ON CONFLICT (id) DO UPDATE SET email_verified = true;

INSERT INTO restaurant_members (user_id, restaurant_id, role)
VALUES ('HWdoEEhHvGZuOvwQ0AsxKXdYZHI2', '33333333-3333-4333-8333-333333333333', 'owner')
ON CONFLICT (user_id, restaurant_id) DO NOTHING;

-- 4 tables, matching the live rows created at bring-up (labels + capacities
-- read back from staging 14 Aug 2026). Bare ON CONFLICT so either the fixed
-- id or UNIQUE (restaurant_id, label) absorbs the duplicate — the live rows
-- carry their own ids for these labels.
-- Mazcina's real floor plan: 10 tables, 36 seats (4x 1-2, 4x 2-4, 2x 4-6).
--
-- This block used to insert four synthetic tables S1-S4 with ON CONFLICT DO
-- NOTHING. After the venue became Mazcina that was actively dangerous: different
-- labels and different ids meant re-running this file would NOT dedupe against
-- the real tables — it would resurrect S1-S4 alongside them, silently, giving
-- the venue a fourteen-table room and a phantom 8-seat capacity.
--
-- Upserting by label instead makes this file agree with
-- deploy/seeds/mazcina-tables.sql from any starting state. Apply that file for
-- the retirement half (it also deactivates whatever is not in this set).
INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active) VALUES
  ('33333333-3333-4333-8333-333333333333', 'T1',  1, 2, true),
  ('33333333-3333-4333-8333-333333333333', 'T2',  1, 2, true),
  ('33333333-3333-4333-8333-333333333333', 'T3',  1, 2, true),
  ('33333333-3333-4333-8333-333333333333', 'T4',  1, 2, true),
  ('33333333-3333-4333-8333-333333333333', 'T5',  2, 4, true),
  ('33333333-3333-4333-8333-333333333333', 'T6',  2, 4, true),
  ('33333333-3333-4333-8333-333333333333', 'T7',  2, 4, true),
  ('33333333-3333-4333-8333-333333333333', 'T8',  2, 4, true),
  ('33333333-3333-4333-8333-333333333333', 'T9',  4, 6, true),
  ('33333333-3333-4333-8333-333333333333', 'T10', 4, 6, true)
ON CONFLICT (restaurant_id, label) DO UPDATE
  SET min_capacity = EXCLUDED.min_capacity,
      max_capacity = EXCLUDED.max_capacity,
      is_active    = true;
-- MENU: deliberately not seeded here any more.
--
-- This file used to insert a five-item fixture menu (Fish & Chips, Garden Salad,
-- Big Breakfast, Coke, House Lager) with fixed ids and ON CONFLICT DO NOTHING.
-- Once the venue became Mazcina that turned into a live hazard, and the same one
-- the tables block had: re-running this file RESURRECTED the fixture items
-- alongside Mazcina's real menu, silently, and Bella would happily read
-- "Fish & Chips" out to a caller at a Mediterranean/Chilean restaurant.
-- Observed exactly that on a replica: 31 real items became 35.
--
-- Mazcina's menu is real data and lives with the venue, not in this repo:
--
--   npm run menu:import --workspace=@vocotable/backend -- \
--     --restaurant-id 33333333-3333-4333-8333-333333333333 \
--     --file mazcina/mazcina-menu-voxtable-import.json --dry-run
--
-- (drop --dry-run to apply; use --emit-sql for the private-only staging
-- database). Full procedure: deploy/runbooks/mazcina-staging-conversion.md §4.
--
-- The licensed-item and menu-window paths that the fixture menu used to
-- exercise now have real automated cover that provisions its own venue:
--   npm run smoke:menu-guards

COMMIT;

-- CLEANUP (only if the venue must be rebuilt from scratch; order matters —
-- order_items references menu_items as RESTRICT, so menu rows must go in the
-- order below. ⚠️ CORRECTION: reservations.table_id and orders.table_id are
-- ON DELETE **SET NULL**, not RESTRICT. Deleting a table therefore does NOT
-- error — it silently nulls table_id on every reservation, dropping those
-- bookings out of migration 025's overlap guard (`WHERE table_id IS NOT NULL`)
-- so their seats become sellable again. Never delete a table that has
-- reservations; deactivate it (see deploy/seeds/mazcina-tables.sql):
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Why no human owner is seeded here (26 Aug 2026)
--
-- This file used to grant ownership to a hardcoded Firebase uid for
-- skalaliya@gmail.com. That uid was Sam's PRODUCTION uid, pasted into a staging
-- seed on 18 Aug and unnoticed until 26 Aug, when the first human tried to sign
-- in to the staging dashboard and was trapped in the onboarding wizard: the
-- venue had an owner nobody could authenticate as.
--
-- Nothing caught it, and the reasons are worth keeping:
--   * a uid is opaque and environment-scoped with no visible marker. It sits
--     next to identifiers that DO look checkable (a UUID, a +61 number) and
--     borrows their credibility.
--   * re-applying reported "0 rows" — which proves idempotency, not correctness.
--     ON CONFLICT DO NOTHING is exactly as quiet about a wrong uid as a right one.
--   * the OTHER uid in this file, the machine smoke user below, was right only
--     because smoke:staging exercises it and would have gone red.
--
-- This is the same reasoning that removed retell_agent_id from this seed: a seed
-- cannot verify, and the environment can. Human grants therefore happen against
-- the environment, which resolves email -> uid in ITS OWN Firebase project (the
-- pattern apps/backend/src/db/seed.ts already uses), making a cross-environment
-- uid unrepresentable rather than merely wrong.
--
-- Guard: `npm run check:seed-identities` fails on any uid in a seed that does not
-- belong to the target project, and names the sibling project it came from.
--
-- The smoke user's row stays because a machine identity has no email->uid path at
-- apply time and its password is environment-scoped in Secret Manager — but it is
-- covered by the same guard.
-- ─────────────────────────────────────────────────────────────────────────────
