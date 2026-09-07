/**
 * Where a venue has got to on its way to answering a phone.
 *
 * The Provisioning tab showed two tables and, when a venue was waiting, the
 * sentence "Bind their number and agent from the Venues tab" — with no link and
 * no indication of which of the several things involved was actually missing.
 * This turns the same row into a rail with one pending step, so the next action
 * is the thing that is highlighted.
 *
 * Kept pure and separate so the ordering can be tested: getting these steps in
 * the wrong order would tell an operator to do something that cannot be done
 * yet, which is worse than saying nothing.
 */
export const PIPELINE_STEPS = [
  { key: "number", label: "Twilio number" },
  { key: "agent", label: "Retell agent" },
  { key: "bound", label: "Bound to the venue" },
  { key: "live", label: "Live" }
];

export function pipelineFor(venue) {
  const hasNumber = Boolean(venue?.twilio_phone_number);
  const hasAgent = Boolean(venue?.retell_agent_id);
  const isLive = venue?.onboarding_status === "live";
  const done = {
    number: hasNumber,
    agent: hasAgent,
    // "Bound" is both halves stored — the state the API enforces and the wizard
    // waits on. Either half alone is not progress towards a working line.
    bound: hasNumber && hasAgent,
    live: isLive
  };
  const pending = PIPELINE_STEPS.find((step) => !done[step.key])?.key ?? null;
  return PIPELINE_STEPS.map((step) => ({
    ...step,
    state: done[step.key] ? "done" : step.key === pending ? "pending" : "waiting"
  }));
}

/** The one thing to do next, in the words of the person who has to do it. */
export function nextAction(venue) {
  const pending = pipelineFor(venue).find((s) => s.state === "pending");
  if (!pending) return null;
  switch (pending.key) {
    case "number":
      return "Buy or choose a Twilio number for this venue";
    case "agent":
      return "Create this venue's Retell agent";
    case "bound":
      return "Save the number and the agent together";
    default:
      return "Take this venue live";
  }
}

/** How long it has been waiting, in whole hours — the SLA figure. */
export function waitingHours(since, now = Date.now()) {
  if (!since) return null;
  const ms = now - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 3_600_000);
}
