/**
 * Identity-collision smoke test — proves a changed Firebase identity gets an
 * actionable error instead of a dead end.
 *
 * The bug this exists for (found 26 Aug 2026): `upsertUser` conflicts on (id),
 * but migration 007 also puts a UNIQUE index on lower(email). A single-arbiter
 * ON CONFLICT does not absorb a violation of a DIFFERENT index, so a new uid
 * presenting an email some other row already holds raised a bare 23505. Nothing
 * in the backend inspected Postgres error codes, so it fell through to the
 * generic handler and reached the user as HTTP 500 "Something went wrong." —
 * on the first step of the onboarding wizard, which cannot be skipped, and
 * identically on accept-invite.
 *
 * It is not a staging-only fault. It fires whenever a person's Firebase identity
 * changes while their email does not: account deleted and recreated, or an
 * email/password identity replaced by Google sign-in. The user is then locked
 * out of signup with no way forward and no message worth reading.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials.
 *
 *   npm run smoke:identity-collision
 */
import { pool } from "../src/db/pool";
import { upsertUser } from "../src/repositories/members";
import { isAppError } from "../src/domain/errors";
import { assert, reportAndExit, SMOKE_SUFFIX as SUFFIX } from "./lib/smoke-harness";

const EMAIL = `collision-${SUFFIX}@example.test`;
const FIRST_UID = `uid-first-${SUFFIX}`;
const SECOND_UID = `uid-second-${SUFFIX}`;

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[FIRST_UID, SECOND_UID]]);
}

async function main(): Promise<void> {
  await cleanup();

  try {
    // ---- The original identity signs in ----
    await upsertUser({ id: FIRST_UID, email: EMAIL, name: "Collision Smoke", emailVerified: true });
    const first = await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [EMAIL]);
    assert("the first identity is stored", first.rowCount === 1 && first.rows[0]!.id === FIRST_UID, {
      rows: first.rows
    });

    // ---- The same identity signs in again — the happy path must stay happy ----
    await upsertUser({ id: FIRST_UID, email: EMAIL, name: "Collision Smoke", emailVerified: true });
    assert(
      "re-login by the same uid is still a no-op upsert",
      (await pool.query("SELECT count(*)::int AS c FROM users WHERE lower(email) = lower($1)", [EMAIL]))
        .rows[0]!.c === 1,
      {}
    );

    // ---- A NEW uid arrives with the SAME email: the reported bug ----
    let raised: unknown;
    try {
      await upsertUser({ id: SECOND_UID, email: EMAIL, name: "Collision Smoke", emailVerified: true });
    } catch (error) {
      raised = error;
    }

    assert("a second uid with the same email is rejected", raised !== undefined, {});
    assert(
      "it is an AppError, not a raw database error",
      isAppError(raised),
      { type: raised?.constructor?.name, message: (raised as Error)?.message }
    );
    if (isAppError(raised)) {
      assert("it is a 409, not a 500", raised.statusCode === 409, { status: raised.statusCode });
      assert("it carries an actionable code", raised.code === "EMAIL_ALREADY_REGISTERED", {
        code: raised.code
      });
      // The whole point: the user must not be told "Something went wrong."
      assert(
        "the message tells the user what to do",
        !/something went wrong/i.test(raised.message) && /support/i.test(raised.message),
        { message: raised.message }
      );
    }

    // ---- The collision must not have half-written anything ----
    const after = await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [EMAIL]);
    assert("the original row is untouched and no second row exists", after.rowCount === 1 && after.rows[0]!.id === FIRST_UID, {
      rows: after.rows
    });
  } finally {
    await cleanup();
    await pool.end();
  }

  reportAndExit("smoke-identity-collision");
}

main().catch((error) => {
  console.error("identity-collision smoke crashed:", error);
  process.exit(1);
});
