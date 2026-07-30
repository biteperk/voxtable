/**
 * Verify-email code flow smoke test (send → confirm lifecycle).
 *
 * Exercises the REAL HTTP endpoints against a locally running backend, then
 * reads the notifications outbox to recover the emailed code (dev mode: the
 * outbox row is written but never sent when NOTIFICATIONS_ENABLED=false).
 *
 * Target backend must run with:
 *   DASHBOARD_VERIFY_AUTH=false          (dev identity "dev-local-user")
 *   EMAIL_VERIFICATION_CODE_ENABLED=true
 *
 * Covers: send → outbox row with body_html + 6-digit code; wrong code (400,
 * attempts_remaining decremented); right code (verified — dev shortcut skips
 * the Firebase Admin write); replayed confirm (NO_ACTIVE_CODE); immediate
 * resend (429 RESEND_COOLDOWN with retry_after_seconds).
 *
 * Usage:  npm run smoke:verify-email
 */
import { pool } from "../src/db/pool";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
const DEV_UID = "dev-local-user";

let failures = 0;
function assert(label: string, ok: boolean, detail?: unknown): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${tag}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

async function call(
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> & ErrorBody }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown> & ErrorBody;
  return { status: response.status, json };
}

async function main(): Promise<void> {
  // Clean slate for the dev identity so cooldowns from a previous run don't 429.
  await pool.query("DELETE FROM email_verification_codes WHERE uid = $1", [DEV_UID]);
  await pool.query(
    "DELETE FROM notifications_outbox WHERE kind = 'email_verification_code' AND recipient = 'dev@local.test'"
  );

  // 1) Send → 200 with cooldown metadata.
  const send = await call("/api/auth/verify-email/send");
  if (send.status === 404) {
    console.error(
      "Backend has EMAIL_VERIFICATION_CODE_ENABLED=false (or predates the feature). " +
        "Restart it with the flag on, then re-run."
    );
    process.exit(2);
  }
  assert("send → 200 ok", send.status === 200 && send.json.ok === true, send.json);
  assert("send → cooldown_seconds present", typeof send.json.cooldown_seconds === "number");

  // 2) Outbox row exists, carries HTML, and the code is recoverable from text.
  const outbox = await pool.query<{ body: string; body_html: string | null; subject: string }>(
    `SELECT body, body_html, subject FROM notifications_outbox
      WHERE kind = 'email_verification_code' AND recipient = 'dev@local.test'
      ORDER BY created_at DESC LIMIT 1`
  );
  const row = outbox.rows[0];
  assert("outbox row enqueued", Boolean(row));
  assert("outbox row has body_html", Boolean(row?.body_html));
  const code = row?.body.match(/\b(\d{6})\b/)?.[1];
  assert("6-digit code present in text body", Boolean(code), { subject: row?.subject });
  assert("subject leads with the code", Boolean(code && row?.subject.startsWith(code)));
  if (!code) process.exit(1);

  // 3) Wrong code → 400 INVALID_CODE with attempts_remaining.
  const wrongCode = code === "000000" ? "000001" : "000000";
  const wrong = await call("/api/auth/verify-email/confirm", { code: wrongCode });
  assert("wrong code → 400 INVALID_CODE", wrong.status === 400 && wrong.json.error?.code === "INVALID_CODE", wrong.json);
  assert(
    "wrong code → attempts_remaining = 4",
    wrong.json.error?.details?.attempts_remaining === 4,
    wrong.json.error?.details
  );

  // 4) Right code → verified.
  const right = await call("/api/auth/verify-email/confirm", { code });
  assert("right code → 200 verified", right.status === 200 && right.json.verified === true, right.json);

  // 5) Replay → the code was consumed.
  const replay = await call("/api/auth/verify-email/confirm", { code });
  assert(
    "replayed confirm → 400 NO_ACTIVE_CODE",
    replay.status === 400 && replay.json.error?.code === "NO_ACTIVE_CODE",
    replay.json
  );

  // 6) Immediate resend → 429 cooldown with retry_after_seconds.
  const resend = await call("/api/auth/verify-email/send");
  assert(
    "immediate resend → 429 RESEND_COOLDOWN",
    resend.status === 429 && resend.json.error?.code === "RESEND_COOLDOWN",
    resend.json
  );
  assert(
    "cooldown carries retry_after_seconds",
    typeof resend.json.error?.details?.retry_after_seconds === "number",
    resend.json.error?.details
  );

  console.log(failures === 0 ? "\nAll verify-email smoke checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error("smoke-verify-email crashed:", error);
    process.exit(1);
  })
  .finally(() => {
    void pool.end();
  });
