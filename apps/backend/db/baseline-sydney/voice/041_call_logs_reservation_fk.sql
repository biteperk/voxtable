DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'call_logs_reservation_id_fkey'
  ) THEN
    ALTER TABLE voice.call_logs
      ADD CONSTRAINT call_logs_reservation_id_fkey
      FOREIGN KEY (reservation_id)
      REFERENCES reservations.reservations(id)
      ON DELETE SET NULL;
  END IF;
END $$;
