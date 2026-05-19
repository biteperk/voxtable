import { Pool, QueryResult, QueryResultRow } from "pg";

import { env } from "../config/env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined
});

export interface DbClient {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
