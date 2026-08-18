import assert from "node:assert/strict";
import test from "node:test";

import { isAppError } from "../domain/errors";
import {
  assertAcceptanceMatchesPublished,
  assertPublishedVersionAllowed,
  legalDocumentsManifestSchema,
  type LegalDocumentsManifest
} from "./legalDocuments";

/**
 * The verification rules that make agreement_acceptances evidence rather than
 * whatever the browser felt like sending (#196/#198). DB-free and network-free
 * — the fetch/cache half is exercised by smoke:legal against a live server.
 */

const MANIFEST: LegalDocumentsManifest = {
  document_set_version: "CSA-2026-08",
  csa_url: "https://storage.googleapis.com/x-legal-documents/versions/CSA-2026-08/client-services-agreement.pdf",
  schedule_url: "https://storage.googleapis.com/x-legal-documents/versions/CSA-2026-08/privacy-data-handling-schedule.pdf",
  csa_sha256: "a".repeat(64),
  schedule_sha256: "b".repeat(64)
};

const MATCHING_CLAIMS = {
  document_set_version: MANIFEST.document_set_version,
  csa_url: MANIFEST.csa_url,
  schedule_url: MANIFEST.schedule_url,
  csa_sha256: MANIFEST.csa_sha256,
  schedule_sha256: MANIFEST.schedule_sha256
};

test("matching claims pass", () => {
  assertAcceptanceMatchesPublished(MATCHING_CLAIMS, MANIFEST);
});

test("hash comparison is case-insensitive (GCS metadata vs frontend lowercasing)", () => {
  assertAcceptanceMatchesPublished(
    { ...MATCHING_CLAIMS, csa_sha256: MATCHING_CLAIMS.csa_sha256.toUpperCase() },
    MANIFEST
  );
});

for (const [field, value] of [
  ["document_set_version", "CSA-2026-09"],
  ["csa_url", "https://storage.googleapis.com/x-legal-documents/versions/OTHER/csa.pdf"],
  ["schedule_url", "https://storage.googleapis.com/x-legal-documents/versions/OTHER/schedule.pdf"],
  ["csa_sha256", "f".repeat(64)],
  ["schedule_sha256", "f".repeat(64)]
] as const) {
  test(`mismatched ${field} throws 409 TERMS_VERSION_MISMATCH naming the field`, () => {
    try {
      assertAcceptanceMatchesPublished({ ...MATCHING_CLAIMS, [field]: value }, MANIFEST);
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(isAppError(error));
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "TERMS_VERSION_MISMATCH");
      assert.deepEqual((error.details as { mismatched_fields: string[] }).mismatched_fields, [field]);
    }
  });
}

test("SAMPLE-* and DRAFT-* versions are refused while the flag is off", () => {
  // TERMS_ALLOW_UNPUBLISHED_DOCS defaults false (boolFlag) and the test env
  // doesn't set it, so this exercises the shipped default.
  for (const version of ["SAMPLE-2026-08", "DRAFT", "draft-1", "sample"]) {
    try {
      assertPublishedVersionAllowed({ ...MANIFEST, document_set_version: version });
      assert.fail(`expected a throw for ${version}`);
    } catch (error) {
      assert.ok(isAppError(error));
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "TERMS_NOT_PUBLISHED");
    }
  }
  assertPublishedVersionAllowed(MANIFEST);
});

test("manifest schema refuses http URLs, short hashes, and missing fields", () => {
  assert.equal(
    legalDocumentsManifestSchema.safeParse({ ...MANIFEST, csa_url: "http://insecure.example/csa.pdf" }).success,
    false
  );
  assert.equal(
    legalDocumentsManifestSchema.safeParse({ ...MANIFEST, csa_sha256: "abc123" }).success,
    false
  );
  const { csa_sha256: _dropped, ...partial } = MANIFEST;
  assert.equal(legalDocumentsManifestSchema.safeParse(partial).success, false);
  const parsed = legalDocumentsManifestSchema.parse({
    ...MANIFEST,
    csa_sha256: MANIFEST.csa_sha256.toUpperCase()
  });
  assert.equal(parsed.csa_sha256, MANIFEST.csa_sha256);
});
