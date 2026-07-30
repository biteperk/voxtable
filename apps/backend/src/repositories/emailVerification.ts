import { DbClient, pool } from "../db/pool";

export interface VerificationCodeRow {
  uid: string;
  email: string;
  code_hash: string;
  salt: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
  last_sent_at: string;
  sends_in_window: number;
  window_started_at: string;
  created_at: string;
}

export async function getVerificationCode(
  uid: string,
  db: DbClient = pool
): Promise<VerificationCodeRow | null> {
  const result = await db.query<VerificationCodeRow>(
    "SELECT * FROM email_verification_codes WHERE uid = $1",
    [uid]
  );
  return result.rows[0] ?? null;
}

/**
 * Issue (or re-issue) the single active code for a user. Replaces any prior
 * row: attempts and consumption reset, the send-rate window carries over via
 * the values the service computed.
 */
export async function upsertVerificationCode(
  input: {
    uid: string;
    email: string;
    codeHash: string;
    salt: string;
    expiresAt: Date;
    sendsInWindow: number;
    windowStartedAt: Date;
  },
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `INSERT INTO email_verification_codes
       (uid, email, code_hash, salt, expires_at, attempts, consumed_at,
        last_sent_at, sends_in_window, window_started_at)
     VALUES ($1, $2, $3, $4, $5, 0, NULL, now(), $6, $7)
     ON CONFLICT (uid) DO UPDATE SET
       email = EXCLUDED.email,
       code_hash = EXCLUDED.code_hash,
       salt = EXCLUDED.salt,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       consumed_at = NULL,
       last_sent_at = now(),
       sends_in_window = EXCLUDED.sends_in_window,
       window_started_at = EXCLUDED.window_started_at`,
    [
      input.uid,
      input.email,
      input.codeHash,
      input.salt,
      input.expiresAt.toISOString(),
      input.sendsInWindow,
      input.windowStartedAt.toISOString()
    ]
  );
}

/** Atomically bump the guess counter; returns the new attempt count. */
export async function incrementVerificationAttempts(
  uid: string,
  db: DbClient = pool
): Promise<number> {
  const result = await db.query<{ attempts: number }>(
    "UPDATE email_verification_codes SET attempts = attempts + 1 WHERE uid = $1 RETURNING attempts",
    [uid]
  );
  return result.rows[0]?.attempts ?? 0;
}

export async function consumeVerificationCode(uid: string, db: DbClient = pool): Promise<void> {
  await db.query("UPDATE email_verification_codes SET consumed_at = now() WHERE uid = $1", [uid]);
}
