/**
 * What state is a venue's phone line actually in?
 *
 * This exists because the admin used to answer that question in two different
 * places and get it wrong in one of them: the Voice panel read `voice_paused_at`
 * alone, so a venue with NO Twilio number and NO Retell agent was shown a green
 * "Live" pill saying "Bella is answering and taking bookings" — and was offered
 * a "Pause voice" button for a line that cannot ring. The rule is that a line
 * is only live if something can answer it.
 *
 * Order matters: bindings are checked before the pause flag, because an unbound
 * venue is unbound whether or not someone also paused it.
 */
export function lineState(venue) {
  const hasNumber = Boolean(venue?.twilio_phone_number);
  const hasAgent = Boolean(venue?.retell_agent_id);

  if (!hasNumber && !hasAgent) return "no_line";
  // A half-bind is its own state, not "bound". The API refuses to create one,
  // but rows predating that guard exist, and a number with no agent rings out
  // to nothing.
  if (!hasNumber || !hasAgent) return "half_bound";
  if (venue?.voice_paused_at) return "paused";
  return "live";
}

export const LINE_LABEL = {
  live: "Live",
  paused: "Paused",
  half_bound: "Half bound",
  no_line: "No phone line"
};

/** Badge tone per state — `live` is the only good news here. */
export const LINE_TONE = {
  live: "ok",
  paused: "warn",
  half_bound: "danger",
  no_line: "neutral"
};

export function lineExplanation(venue) {
  switch (lineState(venue)) {
    case "live":
      return "Bella answers this number and can take bookings.";
    case "paused":
      return "Callers are told the venue isn't taking phone bookings right now, and bookings are refused server-side.";
    case "half_bound":
      return "Only one half of the binding is set, so the line cannot work — save the number and the agent together.";
    default:
      return "No Twilio number and no Retell agent are bound, so nothing answers a call here.";
  }
}

/**
 * Everything a venue needs before it can honour a booking taken by phone.
 * Returned as a list so the drawer can show what is missing rather than a
 * single pass/fail — a venue with a menu but no tables looked completely ready.
 */
export function readinessChecks(detail) {
  const r = detail?.readiness ?? {};
  const prov = detail?.provisioning ?? {};
  return [
    { key: "line", label: "Phone line bound", ok: lineState(prov) === "live" || lineState(prov) === "paused" },
    { key: "hours", label: "Opening hours set", ok: Boolean(r.hours_set) },
    { key: "tables", label: "Tables set up", ok: Number(r.tables ?? 0) > 0, note: `${Number(r.tables ?? 0)} active` },
    { key: "menu", label: "Menu loaded", ok: Number(r.menu_items ?? 0) > 0, note: `${Number(r.menu_items ?? 0)} items` },
    { key: "faq", label: "Venue FAQ answered", ok: Boolean(r.faq_set) }
  ];
}
