-- 020_table_attributes.sql
-- Table attribute tags (window, booth, outdoor, quiet, …) powering the
-- seating-preference matching in repositories/availability.ts and the Manage
-- Tables page. The split-services branch introduced the COLUMN only in its
-- parked fresh-install baseline (db/baseline-sydney/reservations/020_tables.sql)
-- and shipped code that reads it — this is the additive equivalent for the
-- live append-only chain. Caught by the two-container smoke run:
-- "column t.attributes does not exist" on /availability/check.
--
-- DDL discipline (per CLAUDE.md 08P01 gotcha): plain ADD COLUMN + index, no
-- GENERATED columns.

ALTER TABLE tables ADD COLUMN IF NOT EXISTS attributes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tables_restaurant_attributes
  ON tables USING GIN (attributes);
