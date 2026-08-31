-- What the owner wants Bella to recommend, and in what order.
--
-- Mazcina's owner supplied a ranked list per section plus the reasoning: the
-- empanadas and sopaipillas go out first because they are quick to make and
-- keep a full-house table happy while the mains cook. None of that could be
-- expressed before — the menu had only display_order, which is presentation
-- order for the dashboard, so Bella could look a dish up by name but could not
-- answer "what do you recommend?".
--
-- recommend_rank is deliberately NOT display_order. Menu layout and what the
-- agent pushes are different editorial decisions; sharing one column means a
-- drag-to-reorder in the dashboard silently rewrites the owner's sales
-- priorities.
--
-- is_quick_bite crosses sections on purpose (empanadas are a Starter,
-- sopaipillas a Side), so no per-category ranking can express the pairing.
--
-- Dietary tags are deliberately NOT added here. The owner's list covers 10 of
-- 97 items, and a NOT NULL DEFAULT '{}' column makes "no tags" indistinguishable
-- from "never assessed" — which is how an agent ends up implying a dish is not
-- gluten free, or asserting that it is, to someone who may be coeliac. That
-- needs every item tagged and the owner's sign-off first.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS recommend_rank INTEGER,
  ADD COLUMN IF NOT EXISTS is_signature   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_quick_bite  BOOLEAN NOT NULL DEFAULT false;

-- Two rank-1s in one section is a silent authoring error: the agent would pick
-- whichever sorted first and the owner would never learn his order was not
-- being followed. Make it impossible to store instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_rank_unique
  ON menu_items (restaurant_id, category_id, recommend_rank)
  WHERE recommend_rank IS NOT NULL;

-- The read path: recommended items for one venue, cheapest first by section.
CREATE INDEX IF NOT EXISTS idx_menu_items_recommended
  ON menu_items (restaurant_id, category_id, recommend_rank)
  WHERE recommend_rank IS NOT NULL AND is_available;
