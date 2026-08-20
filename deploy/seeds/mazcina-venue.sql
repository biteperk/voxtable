-- Mazcina Resto-Bar — the real venue details for the staging row.
-- (The hyphen is part of the name. It is what Bella says: restaurants.name becomes
-- the {{restaurant_name}} dynamic variable, so this value is heard, not just shown.)
--
-- Applied as UPDATEs, not INSERTs: the row already exists, and staging-venue.sql's
-- INSERT is ON CONFLICT (id) DO NOTHING, so editing that file would change nothing here.
--
-- ⚠️ The live row is named "Natalia Bistro", NOT "VoxTable Staging Venue" (verified
-- against the staging database 19 Aug 2026). staging-venue.sql intends the latter, but
-- because the row already existed its DO NOTHING never applied the name — so that seed
-- does not describe the live row, and anything matching on the old name will miss.
-- The UPDATEs below match on id, so they are unaffected.
--
-- PREFER THE API for the profile half. `PATCH /api/restaurant/profile` accepts
-- every field below INCLUDING opening_hours, and it invalidates the name cache
-- in the process that serves it. This file exists for the staging database,
-- which is private-only and reachable solely through the throwaway Cloud Run
-- job — see deploy/runbooks/mazcina-staging-conversion.md.
--
-- If you do apply this by SQL: the name and timezone caches are per process and
-- expire after 60s, so allow a minute before trusting what a call says the venue
-- is called.
--
-- Sources: the venue's Google Business listing, its OpenTable listing, and the 2026
-- menu PDF, all 18 Aug 2026. Owner confirmed as Camilo.
-- 'Shop 6' and the third cuisine come from OpenTable; Google and the PDF omit both.

BEGIN;

UPDATE restaurants SET
  name                  = 'Mazcina Resto-Bar',
  owner_name            = 'Camilo',
  timezone              = 'Australia/Sydney',
  address               = '248 Palmer St, Shop 6',
  suburb                = 'Darlinghurst',
  state                 = 'NSW',
  postcode              = '2010',
  cuisine_type          = ARRAY['Mediterranean', 'South American', 'Chilean'],
  -- The venue's own advertised line. NOT the platform number: callers reach
  -- Mazcina on the staging DID +61 468 203 234, and this is where Bella offers
  -- to transfer or call back.
  phone_number          = '+61433865661',
  transfer_phone_number = '+61433865661'
  -- contact_email stays NULL until setup is finished: binding the number fires
  -- a `number_ready` notification, and a real address would email the venue
  -- mid-install. Backfill it at go-live.
WHERE id = '33333333-3333-4333-8333-333333333333';

-- Real trading hours. Closed Tuesday and Wednesday — an empty array is the
-- explicit form of "closed"; getOpeningWindowsForDate does `openingHours[day] ?? []`,
-- so omitting the key would work too, but stating it makes the closure visible
-- rather than an accident of absence.
--
-- ✅ WEDNESDAY RESOLVED (19 Aug 2026): Sam confirmed the venue is closed Tuesday
-- AND Wednesday, settling the listing disagreement in Google's favour. For the
-- record, the two public listings disagreed:
--
--     day  | Google (used here) | OpenTable
--     -----+--------------------+---------------
--     Mon  | 12:00-21:00        | 12:00-21:30
--     Wed  | CLOSED             | 16:00-21:30
--
-- Monday's close time (21:00 vs 21:30) is the one cell still on Google's word
-- alone — a 30-minute error there costs at most one late booking.
--
-- Note what this implies for bookings: with a 90-minute duration, the last
-- bookable slot is 20:00 on a 21:30 close and 19:30 on a 21:00 close. A caller
-- asking for 9pm on a Sunday should be offered an alternative, not a table.
UPDATE restaurant_settings SET
  booking_duration_minutes = 90,
  opening_hours_json = '{
    "monday":    [{"open":"12:00","close":"21:00"}],
    "tuesday":   [],
    "wednesday": [],
    "thursday":  [{"open":"12:00","close":"21:30"}],
    "friday":    [{"open":"12:00","close":"21:30"}],
    "saturday":  [{"open":"12:00","close":"21:30"}],
    "sunday":    [{"open":"12:00","close":"21:00"}]
  }'::jsonb
WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';


-- The venue's own answers, read out by Bella via the `venue_faq` dynamic
-- variable. Source: the OpenTable listing's "Additional" attributes + the menu
-- PDF footer. Anything not stated there is deliberately absent — the prompt
-- makes Bella offer to take a message when the FAQ does not cover a question,
-- and that is strictly better than a confident guess about wheelchair access or
-- what a dietary claim really means.
--
-- Keys become spoken labels ("wheelchair_access" -> "Wheelchair access"), and
-- the whole thing is capped at 16 entries / 1200 characters (FAQ_MAX_* in
-- services/venueFaq.ts) because it is injected into EVERY call's prompt,
-- answered or not. Over-budget entries are dropped WHOLE, in alphabetical key
-- order — so count before adding.
--
-- ⚠️ DELIBERATELY OMITTED until Camilo confirms the specifics:
--   * happy hour TIMES — the listing says it exists, not when.
--   * the corkage AMOUNT — likewise.
-- A wrong number spoken aloud is worse than "let me take a message".
UPDATE restaurant_settings SET faq_json = '{
  "hours": "Open Thursday to Monday from 12 noon - until 9:30pm Thursday to Saturday, and 9pm Sunday and Monday. Closed Tuesdays and Wednesdays.",
  "parking": "There is street parking on Palmer Street and around Darlinghurst.",
  "wheelchair_access": "Yes, the venue is wheelchair accessible.",
  "dogs": "Dogs are welcome at the outdoor tables.",
  "outdoor_seating": "Yes, there is patio and outdoor dining.",
  "BYO": "You are welcome to BYO wine. A corkage fee applies - the team can confirm the amount.",
  "dietary": "There are gluten free, vegetarian and vegan options, and they are marked on the menu.",
  "takeaway": "Yes, takeaway is available.",
  "dress_code": "Casual dress - it is a relaxed, casual dining room.",
  "payment": "We accept AMEX, Mastercard and Visa.",
  "surcharge": "A 10 percent surcharge applies on Sundays and 15 percent on public holidays.",
  "groups": "The sharing boards suit larger groups. For big bookings the team will confirm the details."
}'::jsonb
WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';

-- `voice_config_json` is the other column nothing reads. It is deliberately NOT
-- revived: its contents (language, voice/telephony providers, model candidates)
-- now live in env and on the Retell agent, so reading it would create a second,
-- conflicting source of truth for how the line sounds.

COMMIT;

-- ✅ RESOLVED: the real floor plan is in deploy/seeds/mazcina-tables.sql —
-- 10 tables, 36 seats (4x 1-2, 4x 2-4, 2x 4-6), confirmed by the venue.
--
-- ⚠️ Note the consequence: the largest table seats 6, down from the fixture's 8.
-- Nothing in the platform combines tables, so 6 is a hard ceiling and a party of
-- 7+ cannot be booked by voice. checkAvailability now says so honestly
-- (reason='party_too_large') and offers a callback instead of suggesting other
-- times, which could never help.

-- VERIFY
--   SELECT name, owner_name, phone_number, cuisine_type FROM restaurants
--    WHERE id = '33333333-3333-4333-8333-333333333333';
--   SELECT opening_hours_json FROM restaurant_settings
--    WHERE restaurant_id = '33333333-3333-4333-8333-333333333333';
