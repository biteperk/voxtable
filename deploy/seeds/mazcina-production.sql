-- Mazcina — PRODUCTION venue row for the BitePerk-owned line +61 468 202 846.
--
-- Mirrors deploy/seeds/mazcina-venue.sql + mazcina-tables.sql (staging), because data
-- never promotes between environments — every venue is inserted twice, deliberately.
--
-- ⚠️ twilio_phone_number and retell_agent_id are deliberately NOT set here. They are
-- bound together in one statement AFTER the Retell agent exists (a half-bind is exactly
-- what the admin endpoint's both-or-neither rule exists to prevent).
--
-- The junk 'Mazcina 123' signup row (status 'menu', no bindings) is left alone.

BEGIN;

INSERT INTO restaurants
  (id, name, timezone, phone_number, transfer_phone_number,
   address, suburb, state, postcode, cuisine_type, owner_name, onboarding_status)
VALUES
  ('44444444-4444-4444-8444-444444444444', 'Mazcina', 'Australia/Sydney',
   '+61433865661', '+61433865661',
   '248 Palmer St, Shop 6', 'Darlinghurst', 'NSW', '2010',
   ARRAY['Mediterranean','South American','Chilean'], 'Camilo', 'provisioning')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      timezone = EXCLUDED.timezone,
      phone_number = EXCLUDED.phone_number,
      transfer_phone_number = EXCLUDED.transfer_phone_number,
      address = EXCLUDED.address,
      suburb = EXCLUDED.suburb,
      state = EXCLUDED.state,
      postcode = EXCLUDED.postcode,
      cuisine_type = EXCLUDED.cuisine_type,
      owner_name = EXCLUDED.owner_name;

-- Real trading hours. Closed Tuesday and Wednesday (empty array = the explicit form).
-- The production backend cannot yet SAY "we're closed" (no reason:'closed'), but these
-- hours still make a Tue/Wed booking impossible, and the prompt answers the question.
-- faq_json is seeded now so it is already correct the day the backend serves venue_faq.
INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes, opening_hours_json, faq_json)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  90,
  '{"monday":    [{"open":"12:00","close":"21:00"}],
    "tuesday":   [],
    "wednesday": [],
    "thursday":  [{"open":"12:00","close":"21:30"}],
    "friday":    [{"open":"12:00","close":"21:30"}],
    "saturday":  [{"open":"12:00","close":"21:30"}],
    "sunday":    [{"open":"12:00","close":"21:00"}]}'::jsonb,
  '{"hours": "Open Thursday to Monday from 12 noon - until 9:30pm Thursday to Saturday, and 9pm Sunday and Monday. Closed Tuesdays and Wednesdays.",
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
    "groups": "The sharing boards suit larger groups. For big bookings the team will confirm the details."}'::jsonb
)
ON CONFLICT (restaurant_id) DO UPDATE
  SET booking_duration_minutes = EXCLUDED.booking_duration_minutes,
      opening_hours_json = EXCLUDED.opening_hours_json,
      faq_json = EXCLUDED.faq_json;

-- The venue's real floor plan: 10 tables, 36 seats, largest seats SIX.
INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active)
VALUES
  ('44444444-4444-4444-8444-444444444444', 'T1',  1, 2, true),
  ('44444444-4444-4444-8444-444444444444', 'T2',  1, 2, true),
  ('44444444-4444-4444-8444-444444444444', 'T3',  1, 2, true),
  ('44444444-4444-4444-8444-444444444444', 'T4',  1, 2, true),
  ('44444444-4444-4444-8444-444444444444', 'T5',  2, 4, true),
  ('44444444-4444-4444-8444-444444444444', 'T6',  2, 4, true),
  ('44444444-4444-4444-8444-444444444444', 'T7',  2, 4, true),
  ('44444444-4444-4444-8444-444444444444', 'T8',  2, 4, true),
  ('44444444-4444-4444-8444-444444444444', 'T9',  4, 6, true),
  ('44444444-4444-4444-8444-444444444444', 'T10', 4, 6, true)
ON CONFLICT (restaurant_id, label) DO UPDATE
  SET min_capacity = EXCLUDED.min_capacity,
      max_capacity = EXCLUDED.max_capacity,
      is_active    = true;

COMMIT;

SELECT r.name, r.onboarding_status,
       coalesce(r.twilio_phone_number,'(unbound)') AS number,
       (SELECT count(*) FROM tables t WHERE t.restaurant_id = r.id AND t.is_active) AS tables,
       s.opening_hours_json->'tuesday' AS tue,
       s.opening_hours_json->'wednesday' AS wed,
       length(s.faq_json::text) AS faq_chars
FROM restaurants r JOIN restaurant_settings s ON s.restaurant_id = r.id
WHERE r.id = '44444444-4444-4444-8444-444444444444';
