import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchLegalDocumentsManifest,
  legalDocumentsManifestUrl,
  missingLegalDocumentKeys,
  validateLegalDocumentsManifest
} from "./legalDocuments.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function manifest(overrides = {}) {
  return {
    document_set_version: "CSA-2026-08",
    csa_url: "https://storage.googleapis.com/bp-voxtable-stg-legal-documents/versions/CSA-2026-08/client-services-agreement.pdf",
    schedule_url: "https://storage.googleapis.com/bp-voxtable-stg-legal-documents/versions/CSA-2026-08/privacy-data-handling-schedule.pdf",
    csa_sha256: SHA_A,
    schedule_sha256: SHA_B,
    ...overrides
  };
}

test("legal document manifest URL is derived from the Firebase project", () => {
  assert.equal(
    legalDocumentsManifestUrl({ VITE_FIREBASE_PROJECT_ID: "bp-voxtable-stg" }),
    "https://storage.googleapis.com/bp-voxtable-stg-legal-documents/current/manifest.json"
  );
  assert.equal(
    legalDocumentsManifestUrl({
      VITE_FIREBASE_PROJECT_ID: "bp-voxtable-stg",
      VITE_LEGAL_DOCUMENTS_MANIFEST_URL: "https://storage.googleapis.com/custom/current/manifest.json"
    }),
    "https://storage.googleapis.com/custom/current/manifest.json"
  );
});

test("legal document env check only needs the existing Firebase project id", () => {
  assert.deepEqual(missingLegalDocumentKeys({}), ["VITE_FIREBASE_PROJECT_ID"]);
  assert.deepEqual(
    missingLegalDocumentKeys({
      VITE_FIREBASE_PROJECT_ID: "bp-voxtable-prod"
    }),
    []
  );
});

test("manifest validation preserves publish metadata", () => {
  const parsed = validateLegalDocumentsManifest(manifest({ csa_sha256: SHA_A.toUpperCase() }));

  assert.equal(parsed.document_set_version, "CSA-2026-08");
  assert.equal(parsed.csa_sha256, SHA_A);
  assert.equal(parsed.schedule_sha256, SHA_B);
});

test("manifest validation rejects missing and unsafe fields", () => {
  assert.throws(
    () => validateLegalDocumentsManifest(manifest({ schedule_sha256: undefined })),
    /schedule_sha256/
  );
  assert.throws(
    () => validateLegalDocumentsManifest(manifest({ csa_url: "http://example.test/csa.pdf" })),
    /csa_url/
  );
  assert.throws(
    () => validateLegalDocumentsManifest(manifest({ csa_sha256: "not-a-hash" })),
    /csa_sha256/
  );
});

test("fetches and validates configured manifest URL", async () => {
  const fetched = [];
  const parsed = await fetchLegalDocumentsManifest(
    async (url, options) => {
      fetched.push({ url, options });
      return {
        ok: true,
        json: async () => manifest()
      };
    },
    { VITE_FIREBASE_PROJECT_ID: "bucket" }
  );

  assert.equal(fetched[0].url, "https://storage.googleapis.com/bucket-legal-documents/current/manifest.json");
  assert.equal(fetched[0].options.cache, "no-store");
  assert.equal(parsed.document_set_version, "CSA-2026-08");
});
