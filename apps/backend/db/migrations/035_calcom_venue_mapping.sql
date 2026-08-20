-- One Cal.com event type per venue.
--
-- Until now there was a single global CALCOM_EVENT_TYPE_ID, and every inbound
-- web booking was hardcoded to DEFAULT_RESTAURANT_ID (calcomService.ts). With
-- one venue that was merely inaccurate. With two it is a cross-tenant bug: a
-- diner booking venue B online lands on venue A's floor, with every name
-- resolving correctly on the way through, which is what makes that version read
-- as a mystery rather than a bug. The comment admitting this has been sitting in
-- calcomService.ts since the mirror was written.
--
-- The event type id is what a Cal.com webhook carries, so it is the key the
-- inbound handler can resolve a tenant from — the same shape as resolving a
-- venue from the dialled number (repositories/restaurants.ts).
--
-- A venue with no event type id is simply not mirrored. That is the per-venue
-- opt-in, and there is no extra flag. Note the deliberate asymmetry in the
-- service layer: `create` is gated on the venue holding an event type, but
-- `cancel`/`reschedule` are gated on the reservation already holding a Cal.com
-- uid. Unbinding a venue must stop NEW mirroring without stranding bookings
-- that are already live on Cal.com as uncancellable ghosts.
--
-- Seats (allowing many parties to hold one time slot) is a separate, larger
-- change and deliberately NOT in this migration. It invalidates the
-- one-booking-one-reservation assumption that four live code paths depend on,
-- and it ships in its own migration once the real Cal.com payloads have been
-- captured. Nothing here presumes it.
--
-- The runner wraps each file in its own BEGIN/COMMIT. If this trips node-pg's
-- 08P01, apply via `psql -f` and INSERT INTO schema_migrations manually (see 004).

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS calcom_event_type_id INTEGER;

DO $$
DECLARE
  conflict_text TEXT;
BEGIN
  -- Fail with the offending venues named, rather than the bare duplicate-key
  -- error CREATE UNIQUE INDEX would give. A migration that blocks a deploy must
  -- say exactly what to fix. Same shape as 034.
  SELECT string_agg(detail, '; ')
    INTO conflict_text
    FROM (
      SELECT calcom_event_type_id::text || ' -> ' || string_agg(name, ', ' ORDER BY name) AS detail
        FROM restaurants
       WHERE calcom_event_type_id IS NOT NULL
       GROUP BY calcom_event_type_id
      HAVING count(*) > 1
    ) AS dupes;

  IF conflict_text IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one-event-type-per-venue: these Cal.com event types are bound to more than one restaurant (%). Give each venue its own event type, then re-run.',
      conflict_text;
  END IF;
END $$;

-- Partial, for the same reason 034 added one to retell_agent_id: two venues
-- sharing one event type means one venue's diners silently book the other
-- venue's tables. Most venues are unbound and hold NULL, and NULLs must not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_calcom_event_type
  ON restaurants (calcom_event_type_id)
  WHERE calcom_event_type_id IS NOT NULL;
