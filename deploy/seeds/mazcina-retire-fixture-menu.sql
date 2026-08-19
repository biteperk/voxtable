-- Retire the synthetic fixture menu from the staging venue, ahead of importing
-- Mazcina's real one.
--
-- Run this AFTER the rename and BEFORE (or after — it is independent) the menu
-- import. `import-menu.ts` is purely additive: it will never remove the five
-- fixture items, so without this the venue ends up with Mazcina's menu AND
-- "Fish & Chips" and "House Lager" sitting in it, and Bella will happily read
-- them out to a real caller.
--
-- WHY THIS IS NOT JUST A DELETE
-- order_items.menu_item_id references menu_items with ON DELETE RESTRICT
-- (migration 006). Staging has taken real smoke orders, so a plain DELETE fails
-- on exactly the rows that have been ordered — and an order's history must keep
-- resolving to the item it was placed against, so forcing it would be wrong
-- even if it worked.
--
-- So: deactivate everything, then delete only what nothing references.
-- Deactivation is what the caller actually experiences (is_available = false
-- removes an item from /api/menu and from the voice path); deletion is only
-- tidiness. Getting the first right matters, the second does not.
--
-- Idempotent: re-running deactivates nothing new and deletes nothing new.

BEGIN;

-- The five fixture items, by name. They were created by staging-venue.sql with
-- fixed ids, but matching on name keeps this correct even if the row was
-- rebuilt by hand at some point.
CREATE TEMP TABLE fixture_items ON COMMIT DROP AS
SELECT id, name
  FROM menu_items
 WHERE restaurant_id = '33333333-3333-4333-8333-333333333333'
   AND name IN ('Fish & Chips', 'Garden Salad', 'Big Breakfast', 'Coke', 'House Lager');

-- 1) Take them off the menu immediately. This is the step that matters, and it
--    is reversible.
UPDATE menu_items
   SET is_available = false
 WHERE id IN (SELECT id FROM fixture_items);

-- 2) Delete children, then items, but ONLY where no order references the item.
CREATE TEMP TABLE deletable_items ON COMMIT DROP AS
SELECT f.id
  FROM fixture_items f
 WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.menu_item_id = f.id);

DELETE FROM menu_item_modifiers WHERE menu_item_id IN (SELECT id FROM deletable_items);
DELETE FROM menu_item_variants  WHERE menu_item_id IN (SELECT id FROM deletable_items);
DELETE FROM menu_items          WHERE id           IN (SELECT id FROM deletable_items);

-- 3) Drop categories that are now empty. menu_items.category_id is
--    ON DELETE RESTRICT, so this must come after the items and must skip any
--    category still holding a retained (deactivated) row.
DELETE FROM menu_categories mc
 WHERE mc.restaurant_id = '33333333-3333-4333-8333-333333333333'
   AND mc.name IN ('Mains', 'Breakfast', 'Drinks')
   AND NOT EXISTS (SELECT 1 FROM menu_items mi WHERE mi.category_id = mc.id);

COMMIT;

-- VERIFY — expect zero rows. Anything returned is still orderable by a caller.
--
--   SELECT name, is_available FROM menu_items
--    WHERE restaurant_id = '33333333-3333-4333-8333-333333333333'
--      AND name IN ('Fish & Chips','Garden Salad','Big Breakfast','Coke','House Lager')
--      AND is_available;
--
-- Retained-but-deactivated rows are expected and fine — they are pinned by an
-- order. Confirm the real check against the API, not the table:
--   GET /api/menu must contain no fixture item.
