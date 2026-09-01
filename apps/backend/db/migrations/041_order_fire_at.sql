-- When a pre-ordered dish should actually reach the pass.
--
-- Bella can already take a pre-order against a booking (orders.reservation_id
-- has existed since 006), but nothing recorded WHEN it was wanted. Every order
-- is treated as due now: listActiveOrders returns anything not served or
-- cancelled, and the KDS ages a ticket from ordered_at. So a pre-order taken at
-- 11am for a 7pm booking hit the pass immediately, dinged the kitchen, went red
-- within 15 minutes, and — because healthAlerter reads the same clock — paged
-- ops with a stale-ticket alert that then masked real ones for the rest of
-- service. The tray was ready eight hours early.
--
-- NULL means "fire now", which is every order that exists today: walk-in,
-- pickup, dashboard. Nothing changes for them.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS fire_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.fire_at IS
  'When the kitchen should start this order. NULL = immediately. Derived from the reservation time minus the venue lead, and kept in step when the booking moves.';

-- The KDS must FILTER on this, not merely display it, which is why it is a
-- real column and not a line inside special_instructions the way pickup name
-- and time were done (0ce5e83) — those only ever had to be shown.
CREATE INDEX IF NOT EXISTS idx_orders_fire_at
  ON orders (restaurant_id, fire_at)
  WHERE fire_at IS NOT NULL AND status NOT IN ('served', 'cancelled');
