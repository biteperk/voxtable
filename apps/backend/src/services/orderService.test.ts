import assert from "node:assert/strict";
import test from "node:test";

import { orderContentFingerprint } from "./orderService";

const fishAndChips = {
  menuItemId: "11111111-1111-4111-8111-aaaaaaaaaaaa",
  variantId: "22222222-2222-4222-8222-bbbbbbbbbbbb",
  quantity: 1,
  modifierIds: ["mod-a", "mod-b"],
  specialRequests: "no salt"
};
const coke = {
  menuItemId: "33333333-3333-4333-8333-cccccccccccc",
  quantity: 1
};

test("identical content produces an identical fingerprint", () => {
  assert.equal(
    orderContentFingerprint([fishAndChips, coke], "rush"),
    orderContentFingerprint([fishAndChips, coke], "rush")
  );
});

test("item order does not change the fingerprint", () => {
  assert.equal(
    orderContentFingerprint([fishAndChips, coke]),
    orderContentFingerprint([coke, fishAndChips])
  );
});

test("modifier order does not change the fingerprint", () => {
  const reordered = { ...fishAndChips, modifierIds: ["mod-b", "mod-a"] };
  assert.equal(
    orderContentFingerprint([fishAndChips]),
    orderContentFingerprint([reordered])
  );
});

test("quantity changes the fingerprint — a second Coke is a new order", () => {
  const doubleCoke = { ...coke, quantity: 2 };
  assert.notEqual(orderContentFingerprint([coke]), orderContentFingerprint([doubleCoke]));
});

test("an added item changes the fingerprint", () => {
  assert.notEqual(
    orderContentFingerprint([fishAndChips]),
    orderContentFingerprint([fishAndChips, coke])
  );
});

test("special instructions change the fingerprint", () => {
  assert.notEqual(
    orderContentFingerprint([coke], "allergy: nuts"),
    orderContentFingerprint([coke])
  );
});

test("variant changes the fingerprint", () => {
  const smallFish = { ...fishAndChips, variantId: "44444444-4444-4444-8444-dddddddddddd" };
  assert.notEqual(
    orderContentFingerprint([fishAndChips]),
    orderContentFingerprint([smallFish])
  );
});
