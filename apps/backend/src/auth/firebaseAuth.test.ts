import assert from "node:assert/strict";
import test from "node:test";

// The allowlist Set is built from env at module load, so the env var must be
// in place before firebaseAuth is imported — hence the dynamic import (static
// imports are hoisted above this assignment).
process.env.DASHBOARD_ALLOWED_EMAILS = "sam@example.com, Mixed.Case@Example.COM ,";

const firebaseAuth = import("./firebaseAuth");

test("isAllowlistedEmail matches a listed email", async () => {
  const { isAllowlistedEmail } = await firebaseAuth;
  assert.equal(isAllowlistedEmail("sam@example.com"), true);
});

test("isAllowlistedEmail is case-insensitive on both sides", async () => {
  const { isAllowlistedEmail } = await firebaseAuth;
  assert.equal(isAllowlistedEmail("SAM@EXAMPLE.COM"), true);
  assert.equal(isAllowlistedEmail("mixed.case@example.com"), true);
});

test("isAllowlistedEmail rejects unlisted, empty, and missing emails", async () => {
  const { isAllowlistedEmail } = await firebaseAuth;
  assert.equal(isAllowlistedEmail("stranger@example.com"), false);
  assert.equal(isAllowlistedEmail(""), false);
  assert.equal(isAllowlistedEmail(null), false);
  assert.equal(isAllowlistedEmail(undefined), false);
});
