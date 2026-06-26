-- 013_table_metadata.sql
-- Descriptive metadata for tables, so a booking can show *what kind* of table
-- a party is mapped to (e.g. "window-facing"), not just the bare label.
--
-- Two nullable columns, both DISPLAY-ONLY for v1. The voice availability path
-- is deliberately untouched — table selection in repositories/availability.ts
-- stays capacity-only; these columns are surfaced in the dashboard booking log
-- and the live-tables floor view.
--
--   zone        coarse categorical area for badges/grouping
--               (window, patio, bar, booth, main, private). Free TEXT, not an
--               enum, so adding an area never needs a migration in v1.
--   description free-text human label ("Window two-top overlooking the street").
--
-- DDL discipline (CLAUDE.md 08P01 gotcha): plain ADD COLUMN only, no GENERATED
-- expressions, so this runs fine through the single-query migrate.ts runner.

ALTER TABLE tables ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS description TEXT;

