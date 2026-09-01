-- Where to reach the venue's owner.
--
-- The venue's owner asked to be told the moment a booking lands, and for
-- anything above a small party to come to him rather than be auto-booked. Both
-- need a number to reach him on, and there wasn't one: restaurants has
-- owner_name (008) but its phone counterpart was never added.
--
-- Deliberately NOT reusing transfer_phone_number — that is the live warm-
-- transfer target for callers, so borrowing it would start routing guests to
-- the owner's personal mobile mid-call.

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS owner_phone TEXT;

COMMENT ON COLUMN restaurants.owner_phone IS
  'E.164 mobile for owner notifications (new bookings, large-party handoffs). NOT a caller-facing transfer target — that is transfer_phone_number.';
