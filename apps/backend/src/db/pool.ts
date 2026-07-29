import { Pool, QueryResult, QueryResultRow, types } from "pg";

import { env } from "../config/env";

// node-pg's default DATE (oid 1082) parser returns a JS Date object set to
// LOCAL-time midnight. That makes a reservation_date of "2026-05-30" become
// a Date that — once .toISOString() runs in any non-UTC tz — flips to the
// previous day. Our calcomService.zonedWallClockToUtcISO also calls .split()
// on it and throws TypeError.
//
// Keep DATE columns as YYYY-MM-DD strings to match every type annotation in
// the codebase (e.g. ReservationRow.reservation_date: string) and avoid the
// silent date-shifting hazard.
types.setTypeParser(1082, (value) => value);

// NOTE: the domain-schema search_path ("core,reservations,…,public") that
// shipped with the split-services branch was deliberately reverted here — all
// live tables are in `public`, and pointing the search path at not-yet-existing
// schemas is a trap for the day someone creates one. Reinstate it together
// with db/baseline-sydney/ at the Sydney cutover (see that folder's README).

// Primary write pool — used by the booking path, Retell webhook handlers, and
// anything that mutates state. Larger max because each booking holds a client
// for the duration of the per-slot advisory-lock transaction; under 20+
// concurrent voice calls the old `max: 20` was the exact bottleneck.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 40,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
  application_name: "vocotable-api-write"
});

// Read pool — analytics, dashboard list endpoints, /api/ops/* — so dashboard
// reads can never starve the voice booking path of write connections.
// Smaller because read-only queries are quick and don't hold clients long.
export const readPool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 10_000,
  application_name: "vocotable-api-read"
});

export interface DbClient {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export async function closePool(): Promise<void> {
  // End both pools in parallel; either failure shouldn't block the other.
  await Promise.allSettled([pool.end(), readPool.end()]);
}

/**
 * Run `fn` inside a single transaction with guaranteed connection release.
 *
 *   * BEGIN before fn(), COMMIT after if fn resolves, ROLLBACK if fn throws.
 *   * Client always released to the pool in the finally — no leak even if
 *     ROLLBACK itself fails (which it can if the connection is already
 *     terminated; we swallow that secondary error so the original error
 *     propagates to the caller).
 *   * Pass the txn client through to repository functions that accept a
 *     DbClient argument. Reads + writes in the same fn share the same
 *     snapshot (PG's default isolation is READ COMMITTED, sufficient for our
 *     advisory-lock pattern).
 *
 * Use this for ANY multi-step state mutation. The audit's confirmed
 * `modifyBooking` race window (UPDATE reservations + UPDATE customers on two
 * separate pool connections) is the canonical anti-pattern this prevents.
 */
export async function withTransaction<T>(
  fn: (db: DbClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Already in an error path; suppress the secondary so the original
      // error reaches the caller untouched.
    }
    throw error;
  } finally {
    client.release();
  }
}
