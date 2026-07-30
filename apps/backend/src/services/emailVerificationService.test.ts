import assert from "node:assert/strict";
import test from "node:test";

import { codeMatches, generateCode, hashCode } from "./emailVerificationService";

test("generateCode returns a 6-digit, zero-padded numeric string", () => {
  for (let i = 0; i < 500; i += 1) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
  }
});

test("hashCode round-trips through codeMatches", () => {
  const salt = "a1b2c3d4e5f60718";
  const hash = hashCode("042519", salt);
  assert.equal(codeMatches("042519", salt, hash), true);
});

test("codeMatches rejects a wrong code, wrong salt, and malformed hash", () => {
  const salt = "a1b2c3d4e5f60718";
  const hash = hashCode("042519", salt);
  assert.equal(codeMatches("042518", salt, hash), false);
  assert.equal(codeMatches("042519", "ffffffffffffffff", hash), false);
  assert.equal(codeMatches("042519", salt, "not-hex"), false);
});
