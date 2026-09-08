import { useCallback, useEffect, useRef, useState } from "react";

import { applyResult, isStale, shouldRefetchOnVisible } from "../lib/adminRefresh";

/**
 * The data half of an admin screen: fetch, poll, refresh, and report.
 *
 * Every screen used to hand-roll `{data, error, refresh, useEffect +
 * setInterval}`, and each hand-roll omitted something different — one lost the
 * page on a failed refresh, one had no Refresh button at all, none of them
 * tracked which response was newest, and not one reported that a refresh was
 * in progress. Those were five bugs from one missing abstraction.
 *
 * The decisions live in lib/adminRefresh.js, where they are tested. This hook
 * is the wiring.
 *
 * @param fetcher  async () => data. Does NOT need to be memoised — see below.
 * @param intervalMs  poll period; omit for screens that should not poll.
 * @param deps  re-fetch when these change (a filter, a page offset).
 */
export function useAdminData(fetcher, { intervalMs, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, lastUpdatedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by the clock tick below purely to re-render the "Updated …" stamp.
  const [, setTick] = useState(0);
  // What the screen-reader status region says. Written only when a request
  // settles, never by the clock, so it announces once rather than every tick.
  const [announcement, setAnnouncement] = useState("");

  /**
   * The fetcher lives in a ref and the effect below never depends on it.
   *
   * This is load-bearing. AdminVenues memoises its fetcher on [filter, offset]
   * so it can refetch when the filter changes; if this hook keyed its effect on
   * the fetcher's identity, then an unmemoised inline fetcher at any call site
   * would be an infinite fetch loop, and even a memoised one would tear down
   * and re-arm the poll timer on every keystroke in the venue search box.
   * Keeping it in a ref makes forgetting useCallback harmless.
   */
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const mountedRef = useRef(true);
  const timerRef = useRef(null);
  const lastUpdatedRef = useRef(null);

  const load = useCallback(async ({ manual } = {}) => {
    const seq = (seqRef.current += 1);
    if (manual) setRefreshing(true);
    let result;
    try {
      const data = await fetcherRef.current();
      result = { ok: true, data, at: Date.now() };
    } catch (e) {
      result = { ok: false, error: e?.message ?? "Something went wrong" };
    }
    if (!mountedRef.current) return result;
    // A response older than one already applied is dropped rather than
    // written — the fix for the manual-click-meets-poll race.
    if (isStale(seq, appliedRef.current)) {
      if (manual) setRefreshing(false);
      return result;
    }
    appliedRef.current = seq;
    setState((prev) => {
      const next = applyResult(prev, result);
      lastUpdatedRef.current = next.lastUpdatedAt;
      return next;
    });
    setAnnouncement(result.ok ? "Refreshed just now." : `Refresh failed: ${result.error}`);
    if (manual) setRefreshing(false);
    return result;
  }, []);

  /** Manual refresh: reports, and re-arms the poll so the two cannot collide. */
  const refresh = useCallback(async () => {
    const result = await load({ manual: true });
    if (intervalMs && mountedRef.current) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        if (!document.hidden) load({ manual: false });
      }, intervalMs);
    }
    return result;
  }, [load, intervalMs]);

  useEffect(() => {
    mountedRef.current = true;
    load({ manual: false });
    if (intervalMs) {
      timerRef.current = setInterval(() => {
        if (!document.hidden) load({ manual: false });
      }, intervalMs);
    }
    const onVisible = () => {
      if (document.hidden) return;
      if (shouldRefetchOnVisible(lastUpdatedRef.current, intervalMs)) load({ manual: false });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `deps` is the caller's "re-fetch when these change" contract, spread on
    // purpose; `load` is stable and the fetcher is deliberately a ref (above),
    // so neither belongs here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  // A relative stamp with nothing re-rendering it would freeze at "Just now"
  // on the screens that do not poll — a timestamp that lies is worse than
  // none. This tick re-renders and fetches nothing.
  useEffect(() => {
    const clock = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(clock);
  }, []);

  return {
    data: state.data,
    error: state.error,
    lastUpdatedAt: state.lastUpdatedAt,
    refreshing,
    announcement,
    refresh,
    setData: (updater) => setState((prev) => ({ ...prev, data: updater(prev.data) }))
  };
}
