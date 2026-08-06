/**
 * Ops-state smoke — the cross-process observability plumbing (migration 028).
 *
 * The api and worker are separate processes, so the KDS heartbeat map and the
 * Retell auth-failure counter used to exist as two module instances: written
 * in one process, read (permanently empty) in the other. The two alerts they
 * feed — "no kitchen tablet heartbeat" and "the agent answers but no booking
 * is written" — were structurally unfirable. This proves the DB-backed
 * replacements carry every behaviour the in-memory versions were tested for,
 * plus the new bits: atomic counter buckets, the Cal.com quota mirror, and
 * prefix purges.
 *
 *   npm run smoke:ops-state
 */
import { pool } from "../src/db/pool";
import {
  getOpsState,
  incrementOpsCounter,
  purgeOpsStateByPrefix,
  setOpsState
} from "../src/repositories/opsState";
import {
  getKdsHeartbeats,
  KDS_HEARTBEAT_TTL_MS,
  recordKdsHeartbeat
} from "../src/services/kdsHeartbeats";
import {
  recordRetellAuthFailure,
  resetRetellAuthFailures,
  retellAuthSnapshot
} from "../src/services/retellAuthHealth";
import {
  getBreakerState,
  hydrateBreakerFromOpsState,
  resetBreakerForTests
} from "../src/services/calcomClient";
import { quotaSnapshotFromDb, recordCalcomRequest } from "../src/services/calcomQuotaTracker";
import { assert, reportAndExit, SMOKE_SUFFIX } from "./lib/smoke-harness";

// ops_state has no FKs, so fake tenant ids are fine — and prefixed with the
// pid so parallel runs can't collide.
const VENUE_A = `smoke-ops-a-${SMOKE_SUFFIX}`;
const VENUE_B = `smoke-ops-b-${SMOKE_SUFFIX}`;

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM ops_state WHERE key LIKE $1 || '%'", [`kds-heartbeat:smoke-ops-`]);
  await pool.query("DELETE FROM ops_state WHERE key LIKE $1 || '%'", [`smoke-ops-state-${SMOKE_SUFFIX}`]);
  await resetRetellAuthFailures();
}

async function main(): Promise<void> {
  await cleanup();
  try {
    // ---- KDS heartbeats (behaviours ported from the old in-memory tests) --
    const now = Date.now();
    await recordKdsHeartbeat(VENUE_A, "kitchen-1", now);
    await recordKdsHeartbeat(VENUE_B, "kitchen-1", now);
    const venueA = await getKdsHeartbeats(VENUE_A, now);
    const venueB = await getKdsHeartbeats(VENUE_B, now);
    assert("two venues can use the same tablet name without shadowing each other",
      venueA.length === 1 && venueB.length === 1 && venueA[0]!.tablet_id === "kitchen-1");
    assert("a venue never sees another venue's tablets",
      (await getKdsHeartbeats(`smoke-ops-c-${SMOKE_SUFFIX}`, now)).length === 0);

    await recordKdsHeartbeat(VENUE_A, "kitchen-1", now + 60_000);
    const rePing = await getKdsHeartbeats(VENUE_A, now + 60_000);
    assert("a re-ping updates the existing entry rather than adding one",
      rePing.length === 1 && rePing[0]!.last_seen_ms_ago === 0);

    const staleAt = now + KDS_HEARTBEAT_TTL_MS - 60_000;
    const withinTtl = await getKdsHeartbeats(VENUE_A, staleAt);
    assert("a silent tablet is still visible (as silent) inside the TTL window",
      withinTtl.length === 1 && withinTtl[0]!.last_seen_ms_ago > 0);
    assert("a tablet that stops pinging ages out after the TTL",
      (await getKdsHeartbeats(VENUE_A, now + KDS_HEARTBEAT_TTL_MS + 120_000)).length === 0);

    // ---- Retell auth-failure window ---------------------------------------
    await recordRetellAuthFailure(now);
    await recordRetellAuthFailure(now);
    await recordRetellAuthFailure(now - 6 * 60_000); // outside the 5-min window
    const snap = await retellAuthSnapshot(now);
    assert("the auth window sums only failures inside 5 minutes (old code: reader always saw 0)",
      snap.failures_last_5min === 2, snap);
    assert("the last failure timestamp is surfaced", snap.last_failure_at !== null);

    // ---- Counter atomicity (the bucket upsert must be race-free) ----------
    const counterKey = `smoke-ops-state-${SMOKE_SUFFIX}:counter`;
    await Promise.all(Array.from({ length: 10 }, () => incrementOpsCounter(counterKey)));
    const counter = await getOpsState(counterKey, pool);
    assert("10 concurrent increments land as exactly 10", Number(counter?.count) === 10, counter);

    // ---- Latch roundtrip (what the alerter saves/loads each tick) ---------
    const latchKey = `smoke-ops-state-${SMOKE_SUFFIX}:latches`;
    await setOpsState(latchKey, { kdsTabletOfflineAlerted: true, funnelSummaryDayKey: "2026-08-03" });
    const latches = await getOpsState(latchKey, pool);
    assert("latches roundtrip intact",
      latches?.kdsTabletOfflineAlerted === true && latches?.funnelSummaryDayKey === "2026-08-03");

    // ---- Prefix purge (the cleanup worker's hook) --------------------------
    await setOpsState(`smoke-ops-state-${SMOKE_SUFFIX}:purge-me`, { at: 1 });
    await pool.query(
      "UPDATE ops_state SET updated_at = now() - interval '2 days' WHERE key = $1",
      [`smoke-ops-state-${SMOKE_SUFFIX}:purge-me`]
    );
    const purged = await purgeOpsStateByPrefix(`smoke-ops-state-${SMOKE_SUFFIX}:purge-me`, "1 day");
    assert("stale rows purge by prefix + age", purged === 1);
    assert("fresh rows survive the purge",
      (await getOpsState(latchKey, pool)) !== null);

    // ---- Cal.com breaker survives a worker restart -------------------------
    // Process A (the dying worker) last mirrored an OPEN breaker; process B
    // (the restarted worker) must adopt it before its first Cal.com call
    // instead of starting from a fresh "closed" and hammering a down Cal.com.
    // resetBreakerForTests() forgets both the module state and the memoized
    // hydration — exactly a process restart, without spawning one.
    const priorBreakerRow = await getOpsState("calcom-breaker", pool);
    const openedAt = Date.now();
    await setOpsState("calcom-breaker", {
      state: "open",
      consecutiveFailures: 10,
      firstFailureAt: openedAt - 5_000,
      openedAt
    });
    resetBreakerForTests();
    await hydrateBreakerFromOpsState();
    const hydrated = getBreakerState();
    assert(
      "a restarted worker adopts the open breaker (old code: reset to closed)",
      hydrated.state === "open" && hydrated.consecutiveFailures === 10,
      hydrated
    );
    resetBreakerForTests();
    if (priorBreakerRow) {
      await setOpsState("calcom-breaker", priorBreakerRow);
    } else {
      await pool.query("DELETE FROM ops_state WHERE key = 'calcom-breaker'");
    }

    // ---- Cal.com quota survives a worker restart ---------------------------
    // The counter's home is the ops_state day bucket, not module memory — the
    // runaway loop that burns quota is exactly the one that crashes workers,
    // and every restart used to reset the "authoritative" count to zero.
    const beforeQuota = await quotaSnapshotFromDb();
    recordCalcomRequest();
    recordCalcomRequest();
    let afterQuota = await quotaSnapshotFromDb();
    for (let waited = 0; afterQuota.count < beforeQuota.count + 2 && waited < 2_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      afterQuota = await quotaSnapshotFromDb();
    }
    assert(
      "quota increments accumulate in the DB, readable by any process",
      afterQuota.count >= beforeQuota.count + 2,
      { before: beforeQuota.count, after: afterQuota.count }
    );
    // Leave the real day counter as we found it.
    await incrementOpsCounter(`calcom-quota:${afterQuota.day_key}`, -2);
  } finally {
    await cleanup();
    await pool.end();
  }

  reportAndExit("ops-state");
}

void main().catch((error) => {
  console.error("smoke-ops-state crashed:", error);
  process.exit(1);
});
