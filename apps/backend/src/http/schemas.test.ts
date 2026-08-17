import assert from "node:assert/strict";
import test from "node:test";

import {
  adminReenqueueSchema,
  adminSupportStatusSchema,
  adminUnbindSchema,
  agreementSchema
} from "./schemas";

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);

function validAgreementPayload() {
  return {
    document_set_version: "CSA-2026-08",
    csa_url: "https://storage.googleapis.com/bucket/versions/CSA-2026-08/client-services-agreement.pdf",
    schedule_url: "https://storage.googleapis.com/bucket/versions/CSA-2026-08/privacy-data-handling-schedule.pdf",
    csa_sha256: SHA256_A,
    schedule_sha256: SHA256_B,
    client_legal_name: "Natalia's Bistro Pty Ltd",
    client_abn: "12 004 044 937",
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
}

test("agreement payload requires caller-supplied document metadata", () => {
  const payload = validAgreementPayload();
  delete (payload as Partial<typeof payload>).document_set_version;
  delete (payload as Partial<typeof payload>).csa_sha256;
  delete (payload as Partial<typeof payload>).schedule_sha256;

  assert.equal(agreementSchema.safeParse(payload).success, false);
});

test("agreement payload preserves supplied document metadata", () => {
  const parsed = agreementSchema.parse(validAgreementPayload());

  assert.equal(parsed.document_set_version, "CSA-2026-08");
  assert.equal(parsed.csa_url, "https://storage.googleapis.com/bucket/versions/CSA-2026-08/client-services-agreement.pdf");
  assert.equal(parsed.schedule_url, "https://storage.googleapis.com/bucket/versions/CSA-2026-08/privacy-data-handling-schedule.pdf");
  assert.equal(parsed.csa_sha256, SHA256_A);
  assert.equal(parsed.schedule_sha256, SHA256_B);
});

test("admin unbind requires at least one known field and a typed name", () => {
  assert.equal(
    adminUnbindSchema.safeParse({ fields: [], confirm_name: "Cuban Corner" }).success,
    false
  );
  assert.equal(
    adminUnbindSchema.safeParse({ fields: ["stripe_customer_id"], confirm_name: "Cuban Corner" })
      .success,
    false
  );
  assert.equal(
    adminUnbindSchema.safeParse({ fields: ["twilio_phone_number"], confirm_name: "" }).success,
    false
  );
  const parsed = adminUnbindSchema.parse({
    fields: ["twilio_phone_number", "retell_agent_id"],
    confirm_name: "Cuban Corner"
  });
  assert.equal(parsed.acknowledge_live, false);
});

test("admin re-enqueue defaults the buy-marker flag to false", () => {
  assert.equal(adminReenqueueSchema.parse({}).clear_buy_marker, false);
  assert.equal(adminReenqueueSchema.parse({ clear_buy_marker: true }).clear_buy_marker, true);
});

test("admin support status accepts only the four lifecycle states", () => {
  assert.equal(adminSupportStatusSchema.safeParse({ status: "open" }).success, true);
  assert.equal(adminSupportStatusSchema.safeParse({ status: "escalated" }).success, false);
});
