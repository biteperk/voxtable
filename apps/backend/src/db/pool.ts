import { Pool, QueryResult, QueryResultRow } from "pg";

import { env } from "../config/env";

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
