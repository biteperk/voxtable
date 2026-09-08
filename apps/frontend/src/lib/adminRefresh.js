/**
 * The decisions behind an admin screen's data fetch, kept pure so they can be
 * tested without a DOM — the same split as lib/adminAction.js and
 * lib/adminTable.js.
 *
 * Two of these exist because of real defects in the hand-rolled version every
 * admin screen used to carry:
 *
 *   1. Nothing tracked which request was newest. Five endpoints per batch, a
 *      30-second poll, and a manual Refresh button that never disabled — so a
 *      click at t=29.5s raced the tick and whichever batch finished LAST won,
 *      which could leave the screen showing the older snapshot.
 *   2. A failed refresh replaced the whole loaded page with an error card. One
 *      flaky endpoint out of five, or one timeout, and an operator lost
 *      everything they were reading.
 */

/**
 * Is this response older than one we have already applied?
 *
 * Callers stamp each request with an incrementing sequence number and ask this
 * before writing state. `>=` rather than `>` on purpose: a response carrying
 * the sequence we last applied is a duplicate, not news.
 */
export function isStale(seq, appliedSeq) {
  return seq <= appliedSeq;
}

/**
 * Fold a settled request into the previous state.
 *
 * The rule that matters: **failure never clears data.** An error is additional
 * information about the freshness of what is on screen, not a reason to remove
 * it. `lastUpdatedAt` therefore only advances on success — it means "when the
 * data below was last known good", which is the only reading that stays true
 * after a failed refresh.
 */
export function applyResult(state, result) {
  if (result.ok) {
    return {
      ...state,
      data: result.data,
      error: null,
      lastUpdatedAt: result.at
    };
  }
  return {
    ...state,
    error: result.error ?? "Something went wrong",
    // data and lastUpdatedAt deliberately untouched
    data: state.data,
    lastUpdatedAt: state.lastUpdatedAt
  };
}

/**
 * Should the screen be replaced by a full-page error, rather than showing the
 * error alongside the data?
 *
 * Only when there is nothing to show. With data present the page stays and the
 * failure is reported next to it.
 */
export function shouldBlockPage(state) {
  return Boolean(state.error) && state.data === null;
}

/**
 * Has a hidden tab been away long enough that its data is worth re-fetching on
 * return? Polling is skipped while `document.hidden`, so a tab left in the
 * background shows whatever it had when it was hidden.
 *
 * Returns false when the screen does not poll at all (no interval), because
 * then no promise about freshness was made in the first place.
 */
export function shouldRefetchOnVisible(lastUpdatedAt, intervalMs, now = Date.now()) {
  if (!intervalMs || !lastUpdatedAt) return false;
  return now - lastUpdatedAt >= intervalMs;
}
