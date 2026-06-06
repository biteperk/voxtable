// Shared display constants used across multiple dashboard pages and by the
// formatting helpers in ./format. Page-specific constants live with their page.

export const INTENT_LABEL = {
  book: "New booking",
  modify: "Modify booking",
  cancel: "Cancellation",
  info: "Info / FAQ",
  other: "Other"
};

export const OUTCOME_LABEL = {
  confirmed: "Confirmed",
  no_availability: "No availability",
  declined: "Caller declined",
  transferred: "Transferred to staff",
  none: "No booking attempted"
};

// Calls without an ended_at older than this are treated as stale (Retell
// end-of-call webhook never landed) rather than "live forever".
export const LIVE_THRESHOLD_MS = 10 * 60 * 1000;
