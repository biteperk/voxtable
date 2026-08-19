import { logger } from "../utils/logger";

/**
 * Turn a venue's `restaurant_settings.faq_json` into one speakable string for
 * the `venue_faq` dynamic variable.
 *
 * The column has existed since migration 001 and has been seeded since day one
 * (address, parking, dietary, groups) — and until now nothing read it. Mazcina's
 * public listing advertises fourteen such facts (street parking, wheelchair
 * access, dog friendly, outdoor seating, BYO wine, gluten-free, takeaway…), all
 * of which a booking line gets asked and none of which Bella could answer.
 *
 * WHY THE HARD BOUNDS
 * The result is substituted into the agent's prompt on EVERY call, including the
 * ones that never ask a venue question, so it is paid for in latency and tokens
 * whether or not it is used. A dozen short lines is a good trade; an unbounded
 * blob pasted in by a venue is not. Entries are dropped WHOLE rather than
 * truncated — a half sentence is worse than a missing one, because the agent
 * will read it out.
 *
 * ⚠️ Which entry gets dropped is NOT a priority decision. Postgres normalises
 * `jsonb` key order (by key length, then bytewise), so the iteration order here
 * is its ordering, not the order the FAQ was authored in. A venue that overflows
 * the budget therefore loses an arbitrary answer — which is why the drop is
 * logged at `error` with the key names rather than passed over quietly.
 *
 * WHY THE SANITISING
 * `faq_json` is venue-authored `Record<string, unknown>` with no schema — the
 * same unvalidated shape that let an invalid `timezone` and a mis-cased
 * `opening_hours` key take a phone line down (PR #213). Two defences:
 *   - non-string values are skipped rather than coerced, so `{"parking": {…}}`
 *     cannot reach a caller as "[object Object]";
 *   - braces and control characters are stripped, because this text lands inside
 *     Retell's own `{{variable}}` templating. That also marks the trust
 *     boundary: the day an edit API exists this becomes prompt-injection
 *     surface, and sanitising is far cheaper to add now than to retrofit.
 */

/** Bounds are deliberately small — see the note above about per-call cost. */
export const FAQ_MAX_ENTRIES = 16;
export const FAQ_MAX_VALUE_CHARS = 200;
export const FAQ_MAX_TOTAL_CHARS = 1200;

/** "wheelchair_access" / "wheelchairAccess" -> "Wheelchair access". */
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function sanitise(value: string): string {
  return (
    value
      // Retell substitutes {{name}} in the prompt, so braces from venue text
      // must never be able to look like a variable.
      .replace(/[{}]/g, "")
      // Control characters — dynamic variables are single-line strings.
      // no-control-regex is disabled deliberately: matching control characters
      // is the entire purpose of this line.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Returns "" for an empty or unusable FAQ. That is the safe outcome: the prompt
 * instructs the agent to offer to take a message when `venue_faq` does not cover
 * the question, which is exactly today's behaviour.
 */
export function formatVenueFaq(
  faq: Record<string, unknown> | null | undefined,
  restaurantId?: string
): string {
  if (!faq || typeof faq !== "object") return "";

  const parts: string[] = [];
  const dropped: string[] = [];
  let total = 0;

  // Sorted, so the drop order is OURS rather than Postgres'. jsonb normalises
  // key order (by key length, then bytewise), which meant an over-budget FAQ lost
  // an arbitrary answer and lost a DIFFERENT one depending on how the row
  // happened to be stored. Alphabetical is not a priority ranking, but it is
  // reproducible — the same FAQ always yields the same string, which is what
  // makes the behaviour testable and the dropped-keys log actionable.
  for (const [key, rawValue] of Object.entries(faq).sort(([a], [b]) => a.localeCompare(b))) {
    if (parts.length >= FAQ_MAX_ENTRIES || typeof rawValue !== "string") {
      dropped.push(key);
      continue;
    }

    const value = sanitise(rawValue);
    const label = sanitise(humanizeKey(key));
    if (!value || !label || value.length > FAQ_MAX_VALUE_CHARS) {
      dropped.push(key);
      continue;
    }

    const entry = `${label}: ${value}`;
    // +1 for the space this entry adds when joined.
    const cost = entry.length + (parts.length > 0 ? 1 : 0);
    if (total + cost > FAQ_MAX_TOTAL_CHARS) {
      dropped.push(key);
      continue;
    }

    parts.push(entry);
    total += cost;
  }

  if (dropped.length > 0) {
    // Name the keys. "3 entries dropped" sends someone reading the FAQ by hand
    // to work out which; the keys make it a one-line fix.
    logger.error({
      evt: "venue_faq_entries_dropped",
      restaurant_id: restaurantId ?? null,
      kept: parts.length,
      dropped_keys: dropped,
      detail: "faq_json entries were unusable or over budget; the venue cannot answer them"
    });
  }

  return parts.join(" ");
}
