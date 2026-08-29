-- 039_phone_number_single_owner.sql
--
-- A phone number may belong to exactly one venue, across BOTH number columns.
--
-- Migration 007 gave twilio_phone_number and retell_phone_number each their own
-- partial unique index, but they are per-column: venue B's retell_phone_number
-- could legally equal venue A's twilio_phone_number. The dialled-number lookup
-- ORs the two columns, so calls to that number would reach whichever venue the
-- ORDER BY happens to put first — a caller booked into the wrong restaurant
-- with no error anywhere (#221).
--
-- The admin bind route refuses this state with a readable 409. This trigger is
-- the database-level backstop for every other writer: direct SQL from the
-- runbooks, seed scripts, and future provisioning automation.
--
-- A trigger rather than an index because no single index can span two columns
-- with OR semantics. The advisory lock serialises concurrent binds of the same
-- number so two simultaneous writers cannot both pass the check.

CREATE OR REPLACE FUNCTION assert_phone_number_single_owner()
RETURNS trigger AS $$
DECLARE
  n text;
  holder record;
BEGIN
  FOREACH n IN ARRAY ARRAY[NEW.twilio_phone_number, NEW.retell_phone_number] LOOP
    CONTINUE WHEN n IS NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended('phone-number-owner:' || n, 0));
    SELECT id, name INTO holder
      FROM restaurants
     WHERE (twilio_phone_number = n OR retell_phone_number = n)
       AND id <> NEW.id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'phone number % is already bound to restaurant % (%)',
        n, holder.id, holder.name
        USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS restaurants_phone_number_single_owner ON restaurants;
CREATE TRIGGER restaurants_phone_number_single_owner
  BEFORE INSERT OR UPDATE OF twilio_phone_number, retell_phone_number
  ON restaurants
  FOR EACH ROW
  EXECUTE FUNCTION assert_phone_number_single_owner();
