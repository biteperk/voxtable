-- Mazcina's real floor plan: 10 tables, 36 seats.
--
--   T1-T4   1-2   four two-tops
--   T5-T8   2-4   four four-tops
--   T9-T10  4-6   two six-tops
--
-- Replaces the four synthetic tables the venue inherited from the fixture.
--
-- ⚠️ THE LARGEST TABLE NOW SEATS 6, DOWN FROM 8. There is no table-combining
-- anywhere in the platform — one party must fit one table — so 6 is a hard
-- ceiling and a party of 7+ cannot be booked by voice. That is handled
-- honestly: checkAvailability reports reason='party_too_large' and Bella offers
-- a callback instead of suggesting other times (which could never help).
--
-- WHY DEACTIVATE RATHER THAN DELETE
-- reservations.table_id and orders.table_id are ON DELETE **SET NULL**, not
-- RESTRICT. Deleting a table therefore does not error — it quietly nulls
-- table_id on every existing reservation, and migration 025's
-- reservations_no_overlap is `WHERE (... AND table_id IS NOT NULL)`, so those
-- bookings fall OUT of the overlap guard and their seats become sellable again.
-- They also vanish from the floor view, which inner-joins on tables.
--
-- Deactivating preserves table_id, so existing bookings stay linked, stay
-- guarded, and stay in history. Nothing needs re-pointing — which is just as
-- well, since a historical party of 8 could not be moved to any remaining table.
--
-- Known consequence, stated rather than discovered later: listTables filters
-- is_active, so a FUTURE booking still sitting on a retired table disappears
-- from the floor view. On staging those are smoke-test rows. For a real venue,
-- let such bookings run out before retiring their table.
--
-- WHY UPSERT BY LABEL
-- `tables` has UNIQUE (restaurant_id, label), and environments disagree today:
-- staging carries S1-S4 (from staging-venue.sql) while the local replica
-- carries T1-T4. A plain INSERT of 'T1' succeeds on one and collides on the
-- other. Upserting by label corrects whatever is already there and inserts the
-- rest, so this file is safe and identical from either starting state, and
-- re-running it changes nothing.

BEGIN;

INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active)
VALUES
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

-- Retire anything else this venue still has — S1-S4 on staging, nothing on a
-- replica that already used T-labels. Matching on "not in the real set" rather
-- than naming S1-S4 keeps this correct whatever the venue started with.
UPDATE tables
   SET is_active = false
 WHERE restaurant_id = '33333333-3333-4333-8333-333333333333'
   AND label NOT IN ('T1','T2','T3','T4','T5','T6','T7','T8','T9','T10')
   AND is_active;

COMMIT;

-- VERIFY — the first three are the ones that matter.
--
--   -- exactly 10 active tables, largest seats 6
--   SELECT count(*) AS active, max(max_capacity) AS ceiling FROM tables
--    WHERE restaurant_id = '33333333-3333-4333-8333-333333333333' AND is_active;
--
--   -- the old set retired, NOT deleted
--   SELECT label, is_active FROM tables
--    WHERE restaurant_id = '33333333-3333-4333-8333-333333333333' AND NOT is_active;
--
--   -- no reservation was orphaned (this is the silent failure; expect 0)
--   SELECT count(*) FROM reservations
--    WHERE restaurant_id = '33333333-3333-4333-8333-333333333333' AND table_id IS NULL;
