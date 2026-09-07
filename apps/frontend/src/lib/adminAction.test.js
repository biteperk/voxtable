/**
 * The act-or-explain rule. A blocked control must still click and answer —
 * never sit greyed out, which an operator reads as "already done". That
 * misreading cost a live venue's phone line a bind that was never sent.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decideAction, isTrulyDisabled } from "./adminAction";

test("with nothing in the way, the control acts", () => {
  assert.deepEqual(decideAction({}), { kind: "act" });
  assert.deepEqual(decideAction({ busy: false, blocked: null }), { kind: "act" });
});

test("a blocked control explains instead of acting, and carries the reason", () => {
  const decision = decideAction({ blocked: "Add the Retell agent id as well." });
  assert.equal(decision.kind, "explain");
  assert.equal(decision.reason, "Add the Retell agent id as well.");
});

test("blocked never means disabled — that is the whole rule", () => {
  assert.equal(isTrulyDisabled({ busy: false, blocked: "some reason" }), false);
});

test("busy is the one honest disable, and it beats a block", () => {
  assert.deepEqual(decideAction({ busy: true }), { kind: "busy" });
  assert.deepEqual(decideAction({ busy: true, blocked: "a reason" }), { kind: "busy" });
  assert.equal(isTrulyDisabled({ busy: true }), true);
});

test("an empty-string reason is not a block", () => {
  // Guards against `blocked={someCondition && ""}` silently swallowing a click.
  assert.deepEqual(decideAction({ blocked: "" }), { kind: "act" });
});
