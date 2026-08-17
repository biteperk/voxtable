/**
 * Legal-layer smoke test (agreement step, migrations 017+018).
 *
 * Proves the four controls that make the acceptance ledger evidence rather
 * than decoration:
 *   1. State machine: the agreement step CANNOT be skipped (profile → menu
 *      throws 409), and agreement_completed lands where it should.
 *   2. Zod: a missing/false consent, a voxdrive service, or a bad-checksum ABN
 *      all refuse to parse. Each is the fault-injection twin of a happy-path
 *      assert — if the schema stops enforcing, this fails, not production.
 *   3. DB: agreement_acceptances is append-only — UPDATE and DELETE raise.
 *   4. DB: restaurants.retention_days rejects values outside {30, 90}.
 *   5. Manifest verification: an acceptance whose hashes/version differ from
 *      the published manifest is refused (409), and SAMPLE/DRAFT document
 *      sets are refused outright while TERMS_ALLOW_UNPUBLISHED_DOCS is off.
 *   6. DB: migration 032's csa_url/schedule_url columns exist and are written.
 *
 * DB checks run inside one transaction with savepoints (a raised exception
 * aborts the txn state) and ROLLBACK at the end — nothing persists.
 * Usage:  tsx apps/backend/scripts/smoke-legal.ts   (needs a migrated DB)
 */
import { pool } from "../src/db/pool";
import { isAppError } from "../src/domain/errors";
import { nextOnboardingStatus } from "../src/services/onboardingService";
import {
  assertAcceptanceMatchesPublished,
  assertPublishedVersionAllowed,
  type LegalDocumentsManifest
} from "../src/services/legalDocuments";
import { agreementSchema } from "../src/http/schemas";
import { isValidAbn } from "../src/utils/abn";

let failures = 0;
function assert(label: string, ok: boolean, detail?: unknown): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${tag}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

function throws(fn: () => unknown): { threw: boolean; message: string } {
  try {
    fn();
    return { threw: false, message: "" };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

// The ATO's published example ABN (valid checksum).
const VALID_ABN = "51 824 753 556";

const VALID_PAYLOAD = {
  document_set_version: "SMOKE-2026-08",
  csa_url: "https://storage.googleapis.com/smoke-legal-documents/versions/SMOKE-2026-08/client-services-agreement.pdf",
  schedule_url: "https://storage.googleapis.com/smoke-legal-documents/versions/SMOKE-2026-08/privacy-data-handling-schedule.pdf",
  csa_sha256: "a".repeat(64),
  schedule_sha256: "b".repeat(64),
  client_legal_name: "Smoke Test Trattoria Pty Ltd",
  client_abn: VALID_ABN,
  services: ["voxtable"],
  phone_mode: "forward_existing",
  delivery_targets: { emails: [], dashboard: true },
  retention_days: 30,
  storage_tier: "everything",
  pii_redaction: false,
  consent_terms: true,
  consent_overseas: true,
  consent_disclosure: true
};

async function main(): Promise<void> {
  // --- 1. State machine ------------------------------------------------------
  assert(
    "profile + agreement_completed → agreement",
    nextOnboardingStatus("profile", "agreement_completed") === "agreement"
  );
  const skip = throws(() => nextOnboardingStatus("profile", "menu_completed"));
  assert("profile + menu_completed THROWS (agreement not skippable)", skip.threw, {
    message: skip.message
  });
  assert(
    "agreement + menu_completed → menu",
    nextOnboardingStatus("agreement", "menu_completed") === "menu"
  );
  assert(
    "re-fire agreement_completed past agreement is a no-op",
    nextOnboardingStatus("menu", "agreement_completed") === "menu"
  );

  // --- 2. Schema enforcement -------------------------------------------------
  assert("valid payload parses", agreementSchema.safeParse(VALID_PAYLOAD).success);
  assert(
    "missing consent_disclosure REFUSED",
    !agreementSchema.safeParse({ ...VALID_PAYLOAD, consent_disclosure: undefined }).success
  );
  assert(
    "consent_overseas=false REFUSED",
    !agreementSchema.safeParse({ ...VALID_PAYLOAD, consent_overseas: false }).success
  );
  assert(
    "voxdrive service REFUSED (concept product, never sellable)",
    !agreementSchema.safeParse({ ...VALID_PAYLOAD, services: ["voxdrive"] }).success
  );
  assert(
    "retention_days=60 REFUSED (only 30/90 exist)",
    !agreementSchema.safeParse({ ...VALID_PAYLOAD, retention_days: 60 }).success
  );
  assert(
    "bad-checksum ABN REFUSED",
    !agreementSchema.safeParse({ ...VALID_PAYLOAD, client_abn: "51824753557" }).success
  );
  assert("ABN util: ATO example valid", isValidAbn("51824753556"));
  assert("ABN util: transposed digits invalid", !isValidAbn("51824753565"));

  // --- 5. Manifest verification ---------------------------------------------
  const publishedManifest: LegalDocumentsManifest = {
    document_set_version: VALID_PAYLOAD.document_set_version,
    csa_url: VALID_PAYLOAD.csa_url,
    schedule_url: VALID_PAYLOAD.schedule_url,
    csa_sha256: VALID_PAYLOAD.csa_sha256,
    schedule_sha256: VALID_PAYLOAD.schedule_sha256
  };
  const matching = { ...VALID_PAYLOAD };
  let matchOk = true;
  try {
    assertAcceptanceMatchesPublished(matching, publishedManifest);
  } catch {
    matchOk = false;
  }
  assert("acceptance matching the manifest passes verification", matchOk);

  let mismatchRefused = false;
  try {
    assertAcceptanceMatchesPublished(
      { ...matching, csa_sha256: "f".repeat(64) },
      publishedManifest
    );
  } catch (e) {
    mismatchRefused = isAppError(e) && e.statusCode === 409 && e.code === "TERMS_VERSION_MISMATCH";
  }
  assert("acceptance with a different CSA hash REFUSED (409 TERMS_VERSION_MISMATCH)", mismatchRefused);

  let sampleRefused = false;
  try {
    assertPublishedVersionAllowed({
      ...publishedManifest,
      document_set_version: "SAMPLE-2026-08"
    });
  } catch (e) {
    sampleRefused = isAppError(e) && e.code === "TERMS_NOT_PUBLISHED";
  }
  assert(
    "SAMPLE document set REFUSED while TERMS_ALLOW_UNPUBLISHED_DOCS is off",
    process.env.TERMS_ALLOW_UNPUBLISHED_DOCS === "true" ? !sampleRefused : sampleRefused
  );

  // --- 3 & 4. DB: append-only ledger + retention CHECK -----------------------
  const client = await pool.connect();
  try {
    const applied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = '018_legal_layer.sql'"
    );
    if (applied.rows.length === 0) {
      console.error("Migration 018_legal_layer.sql not applied — run npm run db:migrate first.");
      process.exit(2);
    }

    await client.query("BEGIN");
    const r = await client.query<{ id: string }>(
      `INSERT INTO restaurants (name, timezone) VALUES ('SMOKE-legal', 'Australia/Sydney') RETURNING id`
    );
    const rid = r.rows[0]!.id;
    // Writes the 032 URL columns too — fails loudly if the migration is
    // missing, and proves the provenance actually lands in the row.
    const a = await client.query<{ id: string; csa_url: string | null }>(
      `INSERT INTO agreement_acceptances (
         restaurant_id, user_id, channel, document_set_version, csa_url, schedule_url,
         csa_sha256, schedule_sha256,
         consent_terms, consent_overseas, consent_disclosure, order_form_json
       ) VALUES ($1, 'smoke-user', 'online', 'SMOKE', $2, $3, 'x', 'x', true, true, true, '{}'::jsonb)
       RETURNING id, csa_url`,
      [rid, VALID_PAYLOAD.csa_url, VALID_PAYLOAD.schedule_url]
    );
    const aid = a.rows[0]!.id;
    assert("ledger row stores csa_url (migration 032)", a.rows[0]!.csa_url === VALID_PAYLOAD.csa_url);

    await client.query("SAVEPOINT s1");
    let updateBlocked = false;
    try {
      await client.query("UPDATE agreement_acceptances SET consent_terms = false WHERE id = $1", [aid]);
    } catch (e) {
      updateBlocked = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT s1");
    assert("ledger UPDATE raises (append-only trigger)", updateBlocked);

    await client.query("SAVEPOINT s2");
    let deleteBlocked = false;
    try {
      await client.query("DELETE FROM agreement_acceptances WHERE id = $1", [aid]);
    } catch (e) {
      deleteBlocked = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT s2");
    assert("ledger DELETE raises (append-only trigger)", deleteBlocked);

    await client.query("SAVEPOINT s3");
    let checkBlocked = false;
    try {
      await client.query("UPDATE restaurants SET retention_days = 60 WHERE id = $1", [rid]);
    } catch (e) {
      checkBlocked = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT s3");
    assert("retention_days=60 rejected by DB CHECK", checkBlocked);

    // Positive twin: a legal value succeeds, proving the CHECK isn't refusing
    // everything (the vacuous-guard test).
    await client.query("SAVEPOINT s4");
    let legalOk = true;
    try {
      await client.query("UPDATE restaurants SET retention_days = 90 WHERE id = $1", [rid]);
    } catch (e) {
      legalOk = false;
    }
    await client.query("ROLLBACK TO SAVEPOINT s4");
    assert("retention_days=90 accepted by DB CHECK", legalOk);

    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  console.log(failures === 0 ? "\nAll legal-layer checks passed." : `\n${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-legal crashed:", e);
  process.exit(2);
});
