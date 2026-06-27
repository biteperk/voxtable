import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth";
import { getAnalytics, listCallLogs } from "../../api";
import { mapCallLogToRow } from "../../lib/format";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

// Live Feed polls every 5 s for fresh call activity. Plan: "Live Feed: 3-5
// second interval during soft launch." Keep the loading flag for the very
// first fetch only — subsequent refreshes update silently in the background.
const LIVE_FEED_POLL_MS = 5000;

export function LiveFeedOverviewPage({ navigate, path }) {
  const { hasMinRole } = useAuth();
  const canViewAnalytics = hasMinRole("manager");
  const [callLogs, setCallLogs] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const isPhone = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    if (!filterOpen) return;
    const onClick = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) {
        setFilterOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const toggleStatus = (key) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearFilters = () => setStatusFilter(new Set());

  useEffect(() => {
    let cancelled = false;

    const fetchAll = (isInitial) =>
      Promise.all([
        listCallLogs({ limit: 25 }),
        canViewAnalytics ? getAnalytics({ days: 1 }) : Promise.resolve({ analytics: null })
      ])
        .then(([calls, stats]) => {
          if (cancelled) return;
          setCallLogs(calls.call_logs ?? []);
          setAnalytics(stats.analytics ?? null);
          if (error) setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          // Only surface errors during the first fetch — silent retries
          // shouldn't replace a working list with an error banner.
          if (isInitial) setError(e.message);
        })
        .finally(() => {
          if (cancelled || !isInitial) return;
          setLoading(false);
        });

    fetchAll(true);
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchAll(false);
    }, LIVE_FEED_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewAnalytics]);

  const allCallRows = useMemo(() => {
    const rows = callLogs.map((row, i) => mapCallLogToRow(row, i));
    // Live calls float to the top, then most recent first.
    return rows.sort((a, b) => {
      if (a.status === "live" && b.status !== "live") return -1;
      if (b.status === "live" && a.status !== "live") return 1;
      return 0;
    });
  }, [callLogs]);
  const callRows = useMemo(() => {
    if (statusFilter.size === 0) return allCallRows;
    return allCallRows.filter((r) => statusFilter.has(r.status));
  }, [allCallRows, statusFilter]);
  const totalCalls = analytics?.total_calls ?? allCallRows.length;
  const activeCalls = allCallRows.filter((r) => r.status === "live").length;
  const isFiltered = statusFilter.size > 0;
  const successRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.handled / analytics.total_calls) * 100)}%`
      : "—";

  return (
    <DashboardShell active="Live Feed" navigate={navigate} path={path}>

      <header className="operational-header">
        <div>
          <h1>Live Feed</h1>
          <p>Real-time overview of all AI call activity.</p>
        </div>
      </header>

      {/* Summary Cards */}
      <section className="feed-summary-cards">
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Total Calls Today</span>
            <Icon name="phone_in_talk" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{loading ? "…" : totalCalls}</span>
            <span className="feed-stat-sub">Last 24h</span>
          </div>
        </article>

        <article className="feed-stat-card feed-stat-active">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Active Calls</span>
            <div className="feed-stat-live-dot">
              <span className="live-ping" />
              <span className="live-core" />
            </div>
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value accent">{loading ? "…" : activeCalls}</span>
            <span className="feed-stat-sub">Live Now</span>
          </div>
        </article>

        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">AI Success Rate</span>
            <Icon name="auto_awesome" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{loading ? "…" : successRate}</span>
            <span className="feed-stat-sub">Handled w/o transfer</span>
          </div>
        </article>
      </section>

      {/* Recent Activity Table */}
      <section className="feed-activity-card">
        <div className="feed-activity-header">
          <h2>Recent Activity</h2>
          <div className="feed-activity-actions">
            <div className="feed-filter-wrap" ref={filterRef}>
              <button
                type="button"
                className={`feed-action-btn ${filterOpen ? "is-open" : ""}`}
                onClick={() => setFilterOpen((v) => !v)}
                aria-expanded={filterOpen}
              >
                <Icon name="filter_list" /> Filter
                {statusFilter.size > 0 && (
                  <span className="filter-badge">{statusFilter.size}</span>
                )}
              </button>
              {filterOpen && (
                <div className="booking-filter-popover" role="menu">
                  <div className="booking-filter-head">
                    <span>Filter by status</span>
                    {statusFilter.size > 0 && (
                      <button type="button" onClick={clearFilters}>
                        Clear
                      </button>
                    )}
                  </div>
                  {[
                    { key: "live", label: "Live" },
                    { key: "handled", label: "Handled" },
                    { key: "transferred", label: "Transferred" },
                  ].map((opt) => {
                    const checked = statusFilter.has(opt.key);
                    return (
                      <label key={opt.key} className="booking-filter-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleStatus(opt.key)}
                        />
                        <span className={`status-pill ${opt.key}`}>{opt.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <button className="feed-action-btn">
              <Icon name="download" /> Export
            </button>
          </div>
        </div>

        {isPhone ? (
          <ul className="feed-card-list" aria-label="Recent calls">
            {callRows.length === 0 && !loading && (
              <li className="feed-card-empty">
                {isFiltered ? "No calls match your filters." : "No calls yet."}
              </li>
            )}
            {callRows.map((row) => (
              <FeedCardItem
                key={row.id}
                row={row}
                onClick={() => navigate(`/live-feed/${row.id}`)}
              />
            ))}
          </ul>
        ) : (
          <div className="feed-table-wrap">
            <table className="feed-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Intent</th>
                  <th>Duration</th>
                  <th>Time Snapshot</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {callRows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="booking-table-empty">
                      {isFiltered ? "No calls match your filters." : "No calls yet."}
                    </td>
                  </tr>
                )}
                {callRows.map((row) => (
                  <FeedCallRow
                    key={row.id}
                    row={row}
                    onClick={() => navigate(`/live-feed/${row.id}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="feed-table-footer">
          <span>
            {loading
              ? "Loading…"
              : error
              ? `Error: ${error}`
              : isFiltered
              ? `${callRows.length} of ${allCallRows.length} call${allCallRows.length === 1 ? "" : "s"}`
              : `${callRows.length} call${callRows.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </section>
    </DashboardShell>
  );
}


function FeedCallRow({ row, onClick }) {
  const isLive = row.status === "live";

  return (
    <tr
      className={`feed-row ${isLive ? "feed-row-live" : ""}`}
      onClick={onClick}
    >
      <td>
        <div className="feed-customer">
          <div className={`feed-avatar ${row.avatarTone}`}>
            {row.initials ? (
              row.initials
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
              </svg>
            )}
          </div>
          <div>
            <strong>{row.name}</strong>
            <span className={isLive ? "phone-live" : ""}>{row.phone}</span>
          </div>
        </div>
      </td>
      <td>
        {isLive && (
          <span className="feed-badge feed-badge-live">
            <span className="feed-badge-ping" />
            <span className="feed-badge-core" />
            LIVE NOW
          </span>
        )}
        {row.status === "handled" && (
          <span className="feed-badge feed-badge-handled">
            <Icon name="check_circle" /> Handled by AI
          </span>
        )}
        {row.status === "transferred" && (
          <span className="feed-badge feed-badge-transferred">
            <Icon name="call_split" /> Transferred
          </span>
        )}
      </td>
      <td className="feed-intent">{row.intent}</td>
      <td className={`feed-duration ${isLive ? "accent" : ""}`}>{row.duration}</td>
      <td>
        <div className="feed-time">
          <strong>{row.time}</strong>
          <span className={isLive ? "time-note-live" : ""}>{row.timeNote}</span>
        </div>
      </td>
      <td className="text-right">
        {isLive ? (
          <button className="feed-listen-btn" aria-label="Listen in">
            <Icon name="headset_mic" />
          </button>
        ) : (
          <button className="feed-chevron-btn" aria-label="View details">
            <Icon name="chevron_right" />
          </button>
        )}
      </td>
    </tr>
  );
}

function FeedCardItem({ row, onClick }) {
  const isLive = row.status === "live";
  return (
    <li className={`feed-card ${isLive ? "feed-card-live" : ""}`}>
      <button type="button" className="feed-card-button" onClick={onClick}>
        <div className="feed-card-row feed-card-row-top">
          <div className="feed-card-identity">
            <div className={`feed-avatar ${row.avatarTone}`} aria-hidden="true">
              {row.initials || (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                </svg>
              )}
            </div>
            <div className="feed-card-name">
              <strong>{row.name}</strong>
              <span>{row.phone}</span>
            </div>
          </div>
          <div className="feed-card-time">
            <strong>{row.time}</strong>
            <span>{row.timeNote}</span>
          </div>
        </div>
        <div className="feed-card-row feed-card-row-meta">
          {isLive ? (
            <span className="feed-badge feed-badge-live">
              <span className="feed-badge-ping" />
              <span className="feed-badge-core" />
              LIVE
            </span>
          ) : row.status === "handled" ? (
            <span className="feed-badge feed-badge-handled">
              <Icon name="check_circle" /> Handled
            </span>
          ) : row.status === "transferred" ? (
            <span className="feed-badge feed-badge-transferred">
              <Icon name="call_split" /> Transferred
            </span>
          ) : null}
          <span className="feed-card-intent">{row.intent}</span>
          <span className={`feed-card-duration ${isLive ? "accent" : ""}`}>
            <Icon name="timer" />
            {row.duration}
          </span>
        </div>
      </button>
    </li>
  );
}
