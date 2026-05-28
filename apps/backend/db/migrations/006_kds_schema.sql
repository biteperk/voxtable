-- Kitchen Display System (KDS) schema: menu + orders + audit.
--
-- Phase 1 of the KDS plan in /Users/samkalaliya/.claude/plans/now-i-want-to-hidden-quasar.md.
-- The runner (apps/backend/src/db/migrate.ts) wraps this file in a single
-- BEGIN/COMMIT, so no explicit transaction here.
--
-- Notes for future operators:
--   * Migration 003 hit `08P01` from node-pg multi-statement quirks with
--     `GENERATED ALWAYS AS` columns. We deliberately AVOID generated columns
--     here — case-insensitive search uses an expression index on LOWER(name)
--     via pg_trgm instead. If the runner still trips, apply via `psql -f` and
--     INSERT INTO schema_migrations manually (see CLAUDE.md § Database).
--   * order_events is written by the application layer (orderService) inside
--     the same withTransaction as the mutation it audits. We deliberately
--     avoid PL/pgSQL triggers so the actor (firebase UID, or "voice:retell")
--     is captured cleanly without session-set variables.

-- 1) Trigram extension for fuzzy menu-item matching by voice agent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2) New enums (idempotent — existing-type check first).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_source') THEN
    CREATE TYPE order_source AS ENUM ('voice', 'waiter', 'qr', 'dashboard');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM (
      'pending',     -- created, kitchen hasn't picked it up
      'preparing',   -- on the line
      'ready',       -- ready for pickup/serve
      'served',      -- handed to customer (terminal)
      'cancelled'    -- terminal
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_item_status') THEN
    CREATE TYPE order_item_status AS ENUM (
      'queued',
      'preparing',
      'ready',
      'served'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
    CREATE TYPE payment_status AS ENUM ('unpaid', 'paid', 'refunded');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_event_type') THEN
    CREATE TYPE order_event_type AS ENUM (
      'created',
      'status_changed',
      'item_status_changed',
      'payment_changed',
      'cancelled',
      'modified'
    );
  END IF;
END $$;

-- 3) Menu structure: categories → items → (variants | modifiers).
CREATE TABLE IF NOT EXISTS menu_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness — prevents "Drinks" / "drinks" duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_categories_restaurant_name_lower
  ON menu_categories (restaurant_id, LOWER(name));

CREATE TABLE IF NOT EXISTS menu_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: deleting a category that owns items must be blocked.
  -- The dashboard CRUD performs a soft retire (is_active=false) instead.
  category_id       UUID NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  description       TEXT,
  base_price_cents  INTEGER NOT NULL CHECK (base_price_cents >= 0),
  is_available      BOOLEAN NOT NULL DEFAULT true,
  image_url         TEXT,
  image_blurhash    TEXT,
  display_order     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_available
  ON menu_items (restaurant_id, is_available);

CREATE INDEX IF NOT EXISTS idx_menu_items_category
  ON menu_items (category_id, display_order);

-- pg_trgm expression index — voice agent fuzzy-matches "fish and chips" against
-- "Fish & Chips" etc. Expression index avoids the 08P01 risk of a GENERATED
-- column.
CREATE INDEX IF NOT EXISTS idx_menu_items_name_trgm
  ON menu_items USING gin (LOWER(name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS menu_item_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id        UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  -- Signed: "Kids portion" can be negative against the base price.
  price_delta_cents   INTEGER NOT NULL DEFAULT 0,
  display_order       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (menu_item_id, name)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_variants_item
  ON menu_item_variants (menu_item_id, display_order);

-- Modifiers grouped by `group_name` (e.g. "Drink", "Add-ons"). Selection
-- bounds (group_min_select / group_max_select) are enforced by the service
-- layer because Postgres can't express per-group cardinality cleanly with
-- table constraints.
CREATE TABLE IF NOT EXISTS menu_item_modifiers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id        UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_name          TEXT NOT NULL,
  name                TEXT NOT NULL,
  price_delta_cents   INTEGER NOT NULL DEFAULT 0,
  -- Min/max apply to the whole group, so they're denormalised onto every row
  -- of the group. The service validates that they agree across the group.
  group_min_select    INTEGER NOT NULL DEFAULT 0 CHECK (group_min_select >= 0),
  group_max_select    INTEGER NOT NULL DEFAULT 1 CHECK (group_max_select >= 1),
  is_default          BOOLEAN NOT NULL DEFAULT false,
  display_order       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (menu_item_id, group_name, name),
  CHECK (group_min_select <= group_max_select)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_modifiers_item_group
  ON menu_item_modifiers (menu_item_id, group_name, display_order);

-- 4) Orders + order items + order item modifiers.
CREATE TABLE IF NOT EXISTS orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Nullable: walk-in / pickup orders may not have a reservation.
  reservation_id        UUID REFERENCES reservations(id) ON DELETE SET NULL,
  -- Nullable: pickup orders have no table. SET NULL on table delete so we
  -- don't lose order history if a table is removed.
  table_id              UUID REFERENCES tables(id) ON DELETE SET NULL,
  source                order_source NOT NULL,
  status                order_status NOT NULL DEFAULT 'pending',
  payment_status        payment_status NOT NULL DEFAULT 'unpaid',
  subtotal_cents        INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  total_cents           INTEGER NOT NULL CHECK (total_cents >= 0),
  special_instructions  TEXT,
  -- Optimistic-locking version. Status updates require If-Match header.
  version               INTEGER NOT NULL DEFAULT 1,
  -- Caller-supplied idempotency key (Retell call_id, dashboard uuid, etc).
  -- Partial-unique index below dedupes retries.
  idempotency_key       TEXT,
  -- Display-friendly sequential order number per restaurant per day, used by
  -- the KDS card ("#42"). Populated by service layer.
  order_number          INTEGER,
  ordered_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at          TIMESTAMPTZ,
  ready_at              TIMESTAMPTZ,
  served_at             TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT,
  -- Firebase UID for staff-created orders; null for voice/QR.
  created_by            TEXT,
  -- Audit: link the source call when source='voice'.
  created_from_call_log_id UUID REFERENCES call_logs(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency dedup. Partial: NULL keys (rare — shouldn't happen but allowed)
-- are not constrained against each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency
  ON orders (restaurant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Hot-path index for the KDS poll: "give me everything not done".
CREATE INDEX IF NOT EXISTS idx_orders_active
  ON orders (restaurant_id, created_at DESC)
  WHERE status NOT IN ('served', 'cancelled');

-- Per-day order-number lookup; supports the "order #42 today" display logic.
CREATE INDEX IF NOT EXISTS idx_orders_order_number_day
  ON orders (restaurant_id, (ordered_at::date), order_number);

CREATE INDEX IF NOT EXISTS idx_orders_reservation
  ON orders (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: deleting a menu_item with order history is blocked.
  -- Use is_available=false to retire items.
  menu_item_id        UUID NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  variant_id          UUID REFERENCES menu_item_variants(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  -- Price columns are SNAPSHOTS at order time. Menu price changes must not
  -- mutate historical order rows. Same rationale as snapshotting customer_name
  -- on reservations.
  unit_price_cents    INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents    INTEGER NOT NULL CHECK (line_total_cents >= 0),
  name_snapshot       TEXT NOT NULL,
  variant_name_snapshot TEXT,
  special_requests    TEXT,
  status              order_item_status NOT NULL DEFAULT 'queued',
  started_at          TIMESTAMPTZ,
  ready_at            TIMESTAMPTZ,
  served_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id               UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id                 UUID NOT NULL REFERENCES menu_item_modifiers(id) ON DELETE RESTRICT,
  name_snapshot               TEXT NOT NULL,
  group_name_snapshot         TEXT NOT NULL,
  price_delta_cents_snapshot  INTEGER NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_item
  ON order_item_modifiers (order_item_id);

-- 5) order_events — append-only audit log. Written by orderService inside the
--    same withTransaction as the mutation; survives application restart and
--    answers "kitchen says we never got that order" forensics.
CREATE TABLE IF NOT EXISTS order_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type  order_event_type NOT NULL,
  from_value  TEXT,
  to_value    TEXT,
  -- Firebase UID, "voice:retell", "system" (workers), etc.
  actor       TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_created
  ON order_events (order_id, created_at);

-- 6) updated_at triggers — reuse the helper installed in 001_initial_schema.sql.
DROP TRIGGER IF EXISTS set_menu_categories_updated_at ON menu_categories;
CREATE TRIGGER set_menu_categories_updated_at
BEFORE UPDATE ON menu_categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_menu_items_updated_at ON menu_items;
CREATE TRIGGER set_menu_items_updated_at
BEFORE UPDATE ON menu_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_menu_item_variants_updated_at ON menu_item_variants;
CREATE TRIGGER set_menu_item_variants_updated_at
BEFORE UPDATE ON menu_item_variants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_menu_item_modifiers_updated_at ON menu_item_modifiers;
CREATE TRIGGER set_menu_item_modifiers_updated_at
BEFORE UPDATE ON menu_item_modifiers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_orders_updated_at ON orders;
CREATE TRIGGER set_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_order_items_updated_at ON order_items;
CREATE TRIGGER set_order_items_updated_at
BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
