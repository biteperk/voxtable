import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFirebaseConfig,
  missingFirebaseKeys,
  OPTIONAL_FIREBASE_KEYS,
  REQUIRED_FIREBASE_KEYS
} from "./firebaseConfig.js";

/**
 * The failure this guards against is specific and nasty: Vite inlines
 * `undefined` for a missing env var without complaining, so a CI build with the
 * variables absent produces a green build and a deployed app where nobody can
 * sign in — and nothing anywhere says why.
 *
 * CI builds the artifact that gets deployed, so that mistake reaches customers.
 */

const complete = {
  VITE_FIREBASE_API_KEY: "AIzaTest",
  VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "example",
  VITE_FIREBASE_STORAGE_BUCKET: "example.firebasestorage.app",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "1234567890",
  VITE_FIREBASE_APP_ID: "1:123:web:abc"
};

test("a complete environment produces a usable config", () => {
  const config = buildFirebaseConfig(complete);
  assert.equal(config.apiKey, "AIzaTest");
  assert.equal(config.projectId, "example");
  assert.equal(config.storageBucket, "example.firebasestorage.app");
  assert.equal(missingFirebaseKeys(complete).length, 0);
});

test("every required key is genuinely required", () => {
  // Drop one at a time — each must be caught. Guards against someone adding a
  // key to the list but forgetting to read it, or vice versa.
  for (const key of REQUIRED_FIREBASE_KEYS) {
    const partial = { ...complete };
    delete partial[key];
    assert.deepEqual(missingFirebaseKeys(partial), [key]);
    assert.throws(() => buildFirebaseConfig(partial), new RegExp(key), `${key} was not enforced`);
  }
});

test("an empty string counts as missing", () => {
  // The likelier CI mistake than omitting the variable: declaring it blank.
  // `VITE_GOOGLE_MAPS_KEY: ""` already appears in ci.yml, so this is a real shape.
  assert.deepEqual(missingFirebaseKeys({ ...complete, VITE_FIREBASE_APP_ID: "" }), [
    "VITE_FIREBASE_APP_ID"
  ]);
  assert.deepEqual(missingFirebaseKeys({ ...complete, VITE_FIREBASE_PROJECT_ID: "   " }), [
    "VITE_FIREBASE_PROJECT_ID"
  ]);
});

test("an empty environment reports every missing key at once", () => {
  // One build, one complete list — not a fix-one-rerun-discover-another loop.
  assert.deepEqual(missingFirebaseKeys({}), REQUIRED_FIREBASE_KEYS);
  assert.deepEqual(missingFirebaseKeys(undefined), REQUIRED_FIREBASE_KEYS);
});

test("the error says what is missing and where to set it", () => {
  try {
    buildFirebaseConfig({});
    assert.fail("expected a throw");
  } catch (error) {
    for (const key of REQUIRED_FIREBASE_KEYS) {
      assert.match(error.message, new RegExp(key), `error should name ${key}`);
    }
    assert.match(error.message, /repo variables|ci\.yml|\.env/, "should say where to fix it");
  }
});

test("analytics is optional — its absence must not break a build", () => {
  const config = buildFirebaseConfig(complete);
  assert.equal("measurementId" in config, false);
  assert.deepEqual(OPTIONAL_FIREBASE_KEYS, ["VITE_FIREBASE_MEASUREMENT_ID"]);

  const withAnalytics = buildFirebaseConfig({
    ...complete,
    VITE_FIREBASE_MEASUREMENT_ID: "G-TEST"
  });
  assert.equal(withAnalytics.measurementId, "G-TEST");
});

test("no real project values are baked into the source any more", async () => {
  // The point of the change. If someone reinstates a literal, this fails.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../firebase.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /AIzaSy[A-Za-z0-9_-]{10,}/, "an API key literal is back in firebase.js");
  assert.doesNotMatch(source, /firebaseapp\.com"/, "an authDomain literal is back in firebase.js");
});
