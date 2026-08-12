-- 031_menu_windows_restricted.sql
-- Menu items gain a daily availability window and a licensing restriction
-- flag, both needed for real multi-menu venues (breakfast 07:00–12:00, a
-- $20 lunch special, licensed drinks Bella must not sell over the phone).
--
--   available_from / available_until: wall-clock TIME in the restaurant's
--   timezone, NULL = no bound on that side (both NULL = all day). Overnight
--   windows (from > until, e.g. happy hour 16:00–02:00) are legal and
--   handled in code.
--
--   is_restricted: the item stays visible on menus and orderable by staff,
--   but the VOICE path refuses it (responsible-service-of-alcohol posture:
--   Bella takes a message instead). Deliberately NOT is_available=false —
--   that hides the item everywhere.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS available_from TIME;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS available_until TIME;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_restricted BOOLEAN NOT NULL DEFAULT false;
