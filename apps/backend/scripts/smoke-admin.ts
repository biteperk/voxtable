/**
 * Platform-admin surface smoke test (migration 033 + the admin repo functions).
 *
 * Proves the behaviours that make the admin dashboard safe to operate:
 *   1. Re-enqueue resets a FAILED provisioning job IN PLACE — same row id,
 *      payload preserved, attempts back to 0 — and never inserts a second row
 *      (a second row means buying a second Twilio number).
 *   2. Re-enqueue refuses jobs that aren't failed (returns null).
 *   3. clearProvisioningBindings nulls exactly the named fields and no others.
 *   4. listRestaurantsAdmin filters by status and by name query.
 *   5. recordAdminAction lands a row carrying actor + params.
 *   6. Support requests: list reads the inbox, status transitions stamp and
 *      clear resolved_at correctly.
 *   7. discardFailedNotification removes a FAILED notification and refuses any
 *      other state, so the admin's "needs attention" count can reach zero
 *      without a row still in flight being thrown away.
 *   8. Support replies (migration 046): the thread reads oldest-first, an
 *      internal note is never mistaken for a sent reply, the reply count the
 *      inbox shows matches the thread, and deleting a request takes its thread
 *      with it rather than orphaning correspondence.
 *
 * Everything runs inside one transaction and ROLLBACKs at the end — nothing
 * persists. Repo functions that hardcode `pool` are exercised through raw SQL
 * twins inside the txn where necessary; where a function accepts a DbClient,
 * the txn client is passed.
 * Usage:  tsx apps/backend/scripts/smoke-admin.ts   (needs a migrated DB)
 */
import { pool } from "../src/db/pool";
import { discardFailedNotification } from "../src/repositories/notifications";
import { recordAdminAction } from "../src/repositories/adminActions";
import {
  addSupportReply,
  countRepliesByRequest,
  getSupportRequest,
  listSupportReplies,
  listSupportRequests,
  setSupportRequestStatus
} from "../src/repositories/supportRequests";
import { assertSafeSmokeDatabase } from "./lib/smokeTarget";

assertSafeSmokeDatabase();
let failures = 0;
function assert(label: string, ok: boolean, detail?: unknown): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${tag}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Seed a venue to hang everything off.
    const venue = await client.query<{ id: string }>(
      `INSERT INTO restaurants (name, timezone, onboarding_status, twilio_phone_number, retell_phone_number, retell_agent_id)
       VALUES ('Smoke Admin Bistro', 'Australia/Sydney', 'provisioning', '+61468000001', '+61468000002', 'agent_smoke_admin')
       RETURNING id`
    );
    const restaurantId = venue.rows[0]!.id;

    // --- 1 + 2: failed-job reset semantics -----------------------------------
    const job = await client.query<{ id: string }>(
      `INSERT INTO provisioning_jobs (restaurant_id, status, step, attempts, payload, last_error)
       VALUES ($1, 'failed', 'buy_number', 6,
               '{"buy_started_at": "2026-08-17T00:00:00Z", "twilio_sid": "PNsmoke"}'::jsonb,
               'smoke: simulated permanent failure')
       RETURNING id`,
      [restaurantId]
    );
    const jobId = job.rows[0]!.id;

    // resetFailedProvisioningJob uses the module pool, so run its exact SQL
    // through the txn client (same statement, same semantics).
    const reset = await client.query<{
      id: string;
      status: string;
      attempts: number;
      payload: Record<string, unknown>;
      last_error: string | null;
    }>(
      `UPDATE provisioning_jobs
          SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'failed'
        RETURNING *`,
      [jobId]
    );
    const r = reset.rows[0];
    assert("re-enqueue resets the SAME row (id preserved)", r?.id === jobId);
    assert("re-enqueue zeroes attempts and clears last_error", r?.attempts === 0 && r?.last_error === null);
    assert(
      "re-enqueue preserves the payload (twilio_sid survives)",
      r?.payload?.twilio_sid === "PNsmoke" && typeof r?.payload?.buy_started_at === "string"
    );
    const rowCount = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM provisioning_jobs WHERE restaurant_id = $1",
      [restaurantId]
    );
    assert("re-enqueue never inserts a second row", rowCount.rows[0]?.n === "1");

    const resetAgain = await client.query(
      `UPDATE provisioning_jobs
          SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'failed'
        RETURNING id`,
      [jobId]
    );
    assert("re-enqueue of a non-failed job matches nothing", resetAgain.rowCount === 0);

    // --- 3: unbind clears exactly the named fields ---------------------------
    await client.query(
      `UPDATE restaurants SET twilio_phone_number = NULL, retell_agent_id = NULL WHERE id = $1`,
      [restaurantId]
    );
    const afterUnbind = await client.query<{
      twilio_phone_number: string | null;
      retell_phone_number: string | null;
      retell_agent_id: string | null;
    }>(
      "SELECT twilio_phone_number, retell_phone_number, retell_agent_id FROM restaurants WHERE id = $1",
      [restaurantId]
    );
    const u = afterUnbind.rows[0];
    assert(
      "unbind nulls exactly the named fields (retell_phone_number survives)",
      u?.twilio_phone_number === null && u?.retell_agent_id === null && u?.retell_phone_number === "+61468000002"
    );

    // --- 4: admin venue list filters ----------------------------------------
    const byStatus = await client.query<{ id: string }>(
      `SELECT id FROM restaurants WHERE onboarding_status = 'provisioning'::onboarding_status AND name ILIKE '%Smoke Admin%'`
    );
    assert("venue list finds the seeded venue by status + query", byStatus.rows.some((row) => row.id === restaurantId));
    const noMatch = await client.query(
      `SELECT id FROM restaurants WHERE onboarding_status = 'live'::onboarding_status AND name ILIKE '%Smoke Admin%'`
    );
    assert("venue list status filter excludes non-matching status", noMatch.rowCount === 0);

    // --- 5: audit trail row lands -------------------------------------------
    await recordAdminAction(
      {
        actorUid: "smoke-admin-uid",
        actorEmail: "smoke@biteperk.com.au",
        action: "smoke_test",
        restaurantId,
        target: jobId,
        params: { fields: ["twilio_phone_number", "retell_agent_id"] },
        requestId: "smoke-request"
      },
      client
    );
    const auditRow = await client.query<{
      actor_uid: string;
      params: Record<string, unknown>;
      request_id: string | null;
    }>(
      "SELECT actor_uid, params, request_id FROM admin_actions WHERE restaurant_id = $1 AND action = 'smoke_test'",
      [restaurantId]
    );
    const a = auditRow.rows[0];
    assert(
      "admin action recorded with actor, params and request id",
      a?.actor_uid === "smoke-admin-uid" &&
        Array.isArray(a?.params?.fields) &&
        a?.request_id === "smoke-request"
    );

    // --- 6: support inbox lifecycle -----------------------------------------
    const support = await client.query<{ id: string }>(
      `INSERT INTO support_requests (restaurant_id, user_email, category, subject, message)
       VALUES ($1, 'owner@example.com', 'technical', 'Smoke subject', 'Smoke message')
       RETURNING id`,
      [restaurantId]
    );
    const supportId = support.rows[0]!.id;

    const inbox = await listSupportRequests({ status: "open" }, client);
    assert(
      "support inbox lists the open request with the venue name joined",
      inbox.some((row) => row.id === supportId && row.restaurant_name === "Smoke Admin Bistro")
    );

    const resolved = await setSupportRequestStatus(supportId, "resolved", client);
    assert("resolving stamps resolved_at", Boolean(resolved?.resolved_at));
    const reopened = await setSupportRequestStatus(supportId, "open", client);
    assert("reopening clears resolved_at", reopened?.resolved_at === null);
    const missing = await setSupportRequestStatus("00000000-0000-0000-0000-000000000000", "closed", client);
    assert("unknown support request returns null", missing === null);

    // --- 7: discarding a dead notification ----------------------------------
    // discardFailedNotification hardcodes `pool`, so it cannot join this
    // transaction — these two rows are created and removed OUTSIDE it and are
    // cleaned up explicitly below. Everything else here still rolls back.
    const deadRow = await pool.query<{ id: string }>(
      `INSERT INTO notifications_outbox (restaurant_id, channel, recipient, kind, subject, body, status, last_error)
       VALUES (NULL, 'email', 'smoke-discard@example.com', 'smoke_dead', 's', 'b', 'failed', 'ZeptoMail 429: credit exhausted')
       RETURNING id`
    );
    const deadId = deadRow.rows[0]!.id;
    const liveRow = await pool.query<{ id: string }>(
      `INSERT INTO notifications_outbox (restaurant_id, channel, recipient, kind, subject, body, status)
       VALUES (NULL, 'email', 'smoke-live@example.com', 'smoke_live', 's', 'b', 'pending')
       RETURNING id`
    );
    const liveId = liveRow.rows[0]!.id;

    try {
      const discarded = await discardFailedNotification(deadId);
      assert("discarding a failed notification returns the row it removed", discarded?.id === deadId);
      assert(
        "the discarded row carries what was thrown away, for the audit entry",
        discarded?.recipient === "smoke-discard@example.com" && discarded?.kind === "smoke_dead"
      );

      const gone = await pool.query("SELECT 1 FROM notifications_outbox WHERE id = $1", [deadId]);
      assert("the row is really gone, so the failed count can reach zero", gone.rowCount === 0);

      const again = await discardFailedNotification(deadId);
      assert("discarding the same row twice returns null rather than lying", again === null);

      // The guard that matters: a message still queued may yet send, so it must
      // never be removable by this path.
      const refused = await discardFailedNotification(liveId);
      assert("a pending notification is refused", refused === null);
      const stillThere = await pool.query("SELECT status FROM notifications_outbox WHERE id = $1", [liveId]);
      assert("and it is untouched", stillThere.rows[0]?.status === "pending");
    } finally {
      await pool.query("DELETE FROM notifications_outbox WHERE id = ANY($1::uuid[])", [[deadId, liveId]]);
    }

    // --- 8: support replies (migration 046) ---------------------------------
    const emailed = await addSupportReply(
      {
        supportRequestId: supportId,
        channel: "email",
        authorUid: "smoke-admin",
        authorEmail: "admin@example.com",
        body: "  We have had a look and your line is fine.  ",
        notificationId: null
      },
      client
    );
    assert("an emailed reply is stored trimmed", emailed.body === "We have had a look and your line is fine.");

    const note = await addSupportReply(
      {
        supportRequestId: supportId,
        channel: "internal",
        authorUid: "smoke-admin",
        body: "Rang the venue, no answer."
      },
      client
    );

    const thread = await listSupportReplies(supportId, client);
    assert("the thread reads oldest first", thread.map((r) => r.id).join(",") === [emailed.id, note.id].join(","));
    assert(
      "an internal note is distinguishable from a sent reply",
      thread.filter((r) => r.channel === "internal").length === 1 &&
        thread.filter((r) => r.channel === "email").length === 1
    );

    const counts = await countRepliesByRequest([supportId], client);
    assert("the inbox reply count matches the thread", counts.get(supportId) === thread.length);
    const emptyCounts = await countRepliesByRequest([], client);
    assert("counting no requests costs no query and returns empty", emptyCounts.size === 0);

    const withVenue = await getSupportRequest(supportId, client);
    assert("the thread view joins the venue name", withVenue?.restaurant_name === "Smoke Admin Bistro");

    // Correspondence must not outlive the request it belongs to; the FK is ON
    // DELETE CASCADE precisely so a deleted request cannot leave orphan replies
    // that no screen can ever show.
    await client.query("DELETE FROM support_requests WHERE id = $1", [supportId]);
    const orphans = await listSupportReplies(supportId, client);
    assert("deleting a request takes its thread with it", orphans.length === 0);

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[FAIL] smoke-admin crashed:", error);
    failures += 1;
  } finally {
    client.release();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nsmoke-admin: ${failures} failure(s)`);
    process.exit(2);
  }
  console.log("\nsmoke-admin: all checks passed (rolled back — nothing persisted)");
}

void main();
