import assert from "node:assert/strict";
import test from "node:test";

import { isAppError } from "../domain/errors";
import { assertAllowedMenuSourceUrl } from "./menuOcrClient";

/**
 * `source_url` is client-supplied and fetched by our server, so it is an SSRF
 * hole unless the host is pinned. These cases are the ones that matter — cloud
 * metadata, loopback, private ranges, and lookalike hostnames.
 */

test("a real Firebase Storage download URL is accepted", () => {
  assert.doesNotThrow(() =>
    assertAllowedMenuSourceUrl(
      "https://firebasestorage.googleapis.com/v0/b/vocotable.appspot.com/o/menu-imports%2Fabc%2F1-menu.jpg?alt=media&token=x"
    )
  );
});

test("cloud metadata and loopback are refused", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://localhost:3050/api/me",
    "http://127.0.0.1:5432/",
    "http://[::1]:3050/",
    "http://10.0.0.5/admin",
    "http://192.168.1.1/"
  ];
  for (const url of blocked) {
    assert.throws(() => assertAllowedMenuSourceUrl(url), /MENU_SOURCE_URL_INVALID|isn't valid|uploaded here/, url);
  }
});

test("lookalike hostnames do not sneak past the check", () => {
  // A suffix or substring match would let all of these through.
  const lookalikes = [
    "https://firebasestorage.googleapis.com.attacker.test/x",
    "https://evil-firebasestorage.googleapis.com/x",
    "https://attacker.test/firebasestorage.googleapis.com",
    "https://attacker.test/?x=firebasestorage.googleapis.com"
  ];
  for (const url of lookalikes) {
    assert.throws(() => assertAllowedMenuSourceUrl(url), /uploaded here|isn't valid/, url);
  }
});

test("plain http is refused even on the allowed host", () => {
  assert.throws(
    () => assertAllowedMenuSourceUrl("http://firebasestorage.googleapis.com/v0/b/x/o/y"),
    /isn't valid/
  );
});

test("non-http schemes are refused", () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "data:text/plain,hi", "ftp://x/y"]) {
    assert.throws(() => assertAllowedMenuSourceUrl(url), /isn't valid|uploaded here/, url);
  }
});

test("garbage input is a 400, never a crash", () => {
  for (const url of ["", "not a url", "///", "http://"]) {
    try {
      assertAllowedMenuSourceUrl(url);
      assert.fail(`expected ${JSON.stringify(url)} to be rejected`);
    } catch (error) {
      assert.ok(isAppError(error), `${JSON.stringify(url)} threw a non-AppError`);
      assert.equal(error.statusCode, 400);
    }
  }
});

test("the rejection message never echoes the address back", () => {
  // The old code put the upstream status in the error, which is what turned
  // this into an internal port scanner. Don't reintroduce that shape.
  try {
    assertAllowedMenuSourceUrl("http://169.254.169.254/latest/meta-data/");
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(isAppError(error));
    assert.ok(
      !error.message.includes("169.254.169.254"),
      "the error message must not reflect the attacker's address back to them"
    );
  }
});
