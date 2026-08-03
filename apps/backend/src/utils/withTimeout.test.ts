import assert from "node:assert/strict";
import test from "node:test";

import { withTimeout } from "./withTimeout";

test("resolves with the operation's value when it beats the deadline", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1000, () => new Error("late"));
  assert.equal(result, "ok");
});

test("rejects with the caller's error when the deadline wins", async () => {
  const never = new Promise<string>(() => {
    /* deliberately never settles — the shape of a hung certs fetch */
  });
  await assert.rejects(
    withTimeout(never, 10, () => new Error("deadline")),
    { message: "deadline" }
  );
});

test("the operation's own rejection propagates untouched", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("boom")), 1000, () => new Error("late")),
    { message: "boom" }
  );
});

test("onTimeout is not invoked when the operation settles first", async () => {
  let invoked = false;
  await withTimeout(Promise.resolve(1), 1000, () => {
    invoked = true;
    return new Error("late");
  });
  assert.equal(invoked, false);
});
