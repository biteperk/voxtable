/**
 * The act-or-explain decision, kept pure so the rule itself is tested.
 *
 * The rule exists because of a real incident: on 7 Sep 2026 an operator bound a
 * live venue's phone line in the admin, saw two greyed-out buttons, and read
 * that as saved. Nothing had been sent — production logs for the whole day
 * contained no such request. A disabled button is indistinguishable from a
 * completed action.
 *
 * So `blocked` is a REASON string, never a boolean, and a blocked control still
 * clicks — it just answers. `busy` is the one honest disable: a request is
 * already in flight and a second click would double-submit.
 */
export function decideAction({ busy = false, blocked = null } = {}) {
  if (busy) return { kind: "busy" };
  if (blocked) return { kind: "explain", reason: blocked };
  return { kind: "act" };
}

/** Whether the rendered button should carry the `disabled` attribute at all. */
export function isTrulyDisabled({ busy = false } = {}) {
  return Boolean(busy);
}
