-- ROLLBACK for the Mazcina staging conversion.
--
-- Captured from the live STAGING database 19 Aug 2026, immediately before
-- deploy/runbooks/mazcina-staging-conversion.md Phase B began. Applying this
-- returns restaurant 33333333-… to exactly the state the conversion started
-- from: named "Natalia Bistro", bound to Natalia's staging agent, with the
-- fixture hours and no FAQ.
--
-- ENVIRONMENT: bp-voxtable-stg ONLY.
--
-- ⚠️ This restores the venue row, its settings and its table layout. It does
-- NOT un-import Mazcina's menu — menu rows are additive and the fixture items
-- are deactivated rather than deleted, so a rollback leaves both sets present
-- with the fixtures inactive. Reactivating them is a separate, deliberate step
-- and is only needed if something depends on the old five-item menu.
--
-- What the pre-conversion state actually was, for the record:
--   * hours 09:00-23:00 every day, including Tue and Wed (Mazcina is closed both)
--   * faq_json {} — empty, which is why venue_faq arrived blank on a live call
--   * tables S1-S4, ceiling 8 (Mazcina's real ceiling is 6)
--   * 5 menu items
--   * 0 reservations with a NULL table_id  <- the invariant to re-check after

BEGIN;

UPDATE restaurants SET
  name                  = 'Natalia Bistro',
  owner_name            = NULL,
  timezone              = 'Australia/Sydney',
  address               = NULL,
  suburb                = NULL,
  state                 = NULL,
  postcode              = NULL,
  cuisine_type          = NULL,
  phone_number          = NULL,
  transfer_phone_number = NULL,
  contact_email         = NULL,
  onboarding_status     = 'provisioning',
  twilio_phone_number   = '+61468203234',
  retell_agent_id       = 'agent_b9087333b7030f0cee06a19ffc',
  retell_phone_number   = NULL
WHERE id = '33333333-3333-4333-8333-333333333333';

UPDATE restaurant_settings SET
  booking_duration_minutes = 90,
  opening_hours_json = '{
    "monday":    [{"open":"09:00","close":"23:00"}],
    "tuesday":   [{"open":"09:00","close":"23:00"}],
    "wednesday": [{"open":"09:00","close":"23:00"}],
    "thursday":  [{"open":"09:00","close":"23:00"}],
    "friday":    [{"open":"09:00","close":"23:00"}],
    "saturday":  [{"open":"09:00","close":"23:00"}],
    "sunday":    [{"open":"09:00","close":"23:00"}]
  }'::jsonb,
  faq_json = '{}'::jsonb
WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';

-- Reactivate the fixture tables and deactivate anything the conversion added.
-- Deactivate, never delete: reservations.table_id is ON DELETE SET NULL and
-- migration 025's overlap guard is WHERE table_id IS NOT NULL, so deleting a
-- table silently orphans its bookings and makes those seats sellable again.
UPDATE tables SET is_active = (label IN ('S1','S2','S3','S4'))
 WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';

COMMIT;

-- VERIFY after applying
--   SELECT name, retell_agent_id FROM restaurants
--    WHERE id = '33333333-3333-4333-8333-333333333333';
--   -- expect: Natalia Bistro | agent_b9087333b7030f0cee06a19ffc
--
--   SELECT count(*) FROM reservations
--    WHERE restaurant_id = '33333333-3333-4333-8333-333333333333'
--      AND table_id IS NULL;
--   -- expect 0. Anything else means a table was deleted somewhere, not
--   -- deactivated, and bookings lost their seat.
--
-- Allow 60s before trusting a call: the name and timezone caches are
-- per-process with a 60s TTL and a SQL write invalidates nothing.
