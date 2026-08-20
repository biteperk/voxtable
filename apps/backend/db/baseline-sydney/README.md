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

### Keeping it level with the numbered chain

**This tree is folded up to migration 036.** Nothing enforces that — the runner
never walks it, so drift is silent and only an audit finds it. It has happened:
between the parking commit and Aug 2026 only the three feature PRs that
happened to touch this tree folded anything in, so thirteen standalone
migrations (017, 018, 021, 022, 023, 024, 025, 028, 029, 032, 033, 034, 036)
went missing, including the reservation overlap guard and the whole legal
layer.

**So: every migration you add to `db/migrations/` gets a matching edit here, in
the same PR.** Mirrored changes carry a `Migration 0NN.` comment; grep for one
to check whether a given migration landed. When you fold one in, bump the
number in the first line of this section.

Still outstanding before this tree is usable: re-add the `search_path` wiring in
`db/pool.ts` that was reverted when the tree was parked (see the merge commit
for the exact lines).
