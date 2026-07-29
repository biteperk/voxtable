# Backend Migrations

This app is still in development, so the migration history is a clean baseline
instead of a production-compatible append-only chain.

Rules:

- Root files are only for global database setup: extensions, schemas, shared
  enum types, and shared functions.
- Domain folders map to Postgres schemas: `core`, `reservations`, `voice`,
  `menu_orders`, `billing`, `integrations`, and `operations`.
- Each table has its own migration file.
- A table file may include that table's indexes and triggers.
- Cross-table constraints that cannot be created inline because of dependency
  cycles get their own small migration file.
- File numbers define execution order globally, regardless of folder.

Examples:

```text
core/010_restaurants.sql
reservations/020_tables.sql
voice/030_call_logs.sql
reservations/040_reservations.sql
voice/041_call_logs_reservation_fk.sql
```

The app sets this Postgres search path for runtime queries:

```text
core,reservations,voice,menu_orders,billing,integrations,operations,public
```

That lets repository SQL continue using simple table names while the actual
tables live in domain schemas.

## ⚠️ Parked: fresh-database baseline for the Iowa→Sydney cutover

This tree is NOT applied by the migration runner and is NOT compatible with the
live database's append-only chain (`db/migrations/001–0NN`, tracked in
`schema_migrations`). It is the from-scratch schema for the planned migration
to `australia-southeast1`: apply it only to a NEW, EMPTY database at cutover,
together with a data migration from the old shape.

Before using it, fold in everything added to the numbered chain after 016 —
at minimum the legal layer (017 agreement enum, 018 elections + append-only
`agreement_acceptances` + `legal_notices`, 019 `onboarding_events`) — and
re-add the `search_path` wiring in `db/pool.ts` that was reverted when this
tree was parked (see the merge commit for the exact lines).
