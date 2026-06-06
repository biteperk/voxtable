import { useEffect, useRef, useState } from "react";
import { getAnalytics, getAnalyticsDailySeries } from "../../api";
import { decorateDailySeries, formatDuration } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

const ANALYTICS_PERIODS = [
  { days: 7,  label: "Last 7 days" },
  { days: 15, label: "Last 15 days" },
  { days: 30, label: "Last 30 days" },
  { days: 60, label: "Last 60 days" },
  { days: 90, label: "Last 90 days" },
];

export function AnalyticsPage({ navigate }) {
  const [days, setDays] = useState(7);
  const [analytics, setAnalytics] = useState(null);
  const [dailySeries, setDailySeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const periodRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getAnalytics({ days }), getAnalyticsDailySeries({ days })])
      .then(([statsRes, seriesRes]) => {
        if (cancelled) return;
        setAnalytics(statsRes.analytics);
        setDailySeries(decorateDailySeries(seriesRes.series ?? []));
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  useEffect(() => {
    if (!periodOpen) return;
    const onClick = (event) => {
      if (periodRef.current && !periodRef.current.contains(event.target)) {
        setPeriodOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setPeriodOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [periodOpen]);

  const totalCalls = analytics?.total_calls ?? 0;
  // Prefer the new analyzer-driven `bookings_confirmed`; fall back to the
  // legacy `bookings_created` count of call_logs linked to a reservation.
  const bookingsCount = analytics?.bookings_confirmed ?? analytics?.bookings_created ?? 0;
  const bookingRate =
    totalCalls > 0 ? `${Math.round((bookingsCount / totalCalls) * 100)}%` : "—";
  const dailyRevenue = `$${((bookingsCount * 80) / days).toFixed(0)}`;
  const avgLatency = analytics?.avg_latency_ms
    ? `${(analytics.avg_latency_ms / 1000).toFixed(1)}s`
    : "—";
  const avgDuration =
    analytics?.avg_duration_seconds != null
      ? formatDuration(analytics.avg_duration_seconds)
      : "—";

  const periodLabel = ANALYTICS_PERIODS.find((p) => p.days === days)?.label ?? `Last ${days} days`;

  const handleExport = async () => {
    if (exporting || loading) return;
    setExporting(true);
    try {
      const { exportAnalyticsPdf } = await import("../../pdfExport.js");
      exportAnalyticsPdf({
        days,
        periodLabel,
        metrics: {
          totalCalls,
          bookingsCount,
          bookingRate,
          dailyRevenue,
          avgLatency,
          avgDuration,
        },
        dailySeries,
        analytics,
      });
    } catch (e) {
      setError(`Export failed: ${e.message ?? e}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <DashboardShell active="Analytics" navigate={navigate}>
      <header className="analytics-header">
        <div>
          <h1>Performance Analytics</h1>
          <p>{error ? `Error: ${error}` : `${periodLabel} of VocoTable AI activity.`}</p>
        </div>
        <div className="analytics-actions">
          <div className="period-dropdown" ref={periodRef}>
            <button
              type="button"
              className="period-trigger"
              onClick={() => setPeriodOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={periodOpen}
            >
              {periodLabel}
              <Icon name={periodOpen ? "expand_less" : "expand_more"} />
            </button>
            {periodOpen ? (
              <div className="period-menu" role="menu">
                {ANALYTICS_PERIODS.map((p) => (
                  <button
                    key={p.days}
                    type="button"
                    role="menuitemradio"
                    aria-checked={days === p.days}
                    className={`period-menu-item${days === p.days ? " is-active" : ""}`}
                    onClick={() => {
                      setDays(p.days);
                      setPeriodOpen(false);
                    }}
                  >
                    {p.label}
                    {days === p.days ? <Icon name="check" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" onClick={handleExport} disabled={exporting || loading}>
            <Icon name={exporting ? "hourglass_top" : "download"} />
            {exporting ? "Generating…" : "Export"}
          </button>
        </div>
      </header>

      <section className="metric-grid">
        <Metric icon="call" label="Total Calls" value={loading ? "…" : String(totalCalls)} change={`last ${days}d`} />
        <Metric icon="event_available" label="Booking Conversion" value={loading ? "…" : bookingRate} change={`${bookingsCount} bookings`} tone="secondary" />
        <Metric icon="payments" label="Daily Avg Revenue" value={loading ? "…" : dailyRevenue} change="$80 / booking" tone="tertiary" />
        <Metric icon="timer" label="Avg Call Duration" value={loading ? "…" : avgDuration} change={analytics?.avg_latency_ms ? `${avgLatency} latency` : ""} />
      </section>

      <section className="analytics-lower-grid">
        <CallVolumeChart series={dailySeries} loading={loading} days={days} />
        <OutcomeBreakdown analytics={analytics} />
      </section>
    </DashboardShell>
  );
}

function Metric({ icon, label, value, change, tone = "primary", down = false }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-top">
        <div className="metric-icon">
          <Icon name={icon} fill />
        </div>
        <span className={down ? "metric-change down" : "metric-change"}>
          <Icon name={down ? "trending_down" : "trending_up"} />
          {change}
        </span>
      </div>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}


function CallVolumeChart({ series, loading, days = 7 }) {
  const maxTotal = Math.max(1, ...series.map((d) => d.total));
  const niceMax = Math.max(4, Math.ceil(maxTotal / 4) * 4);
  const ticks = [niceMax, Math.round(niceMax * 0.75), Math.round(niceMax * 0.5), Math.round(niceMax * 0.25), 0];

  // For wide ranges (>14 days) sample x-axis labels so they don't overlap, and
  // use a short date instead of weekday since weekdays repeat.
  const useShortDate = series.length > 7;
  const labelStride = series.length <= 14 ? 1 : Math.ceil(series.length / 10);

  const gridCols = `repeat(${Math.max(series.length, 1)}, minmax(0, 1fr))`;
  const gap = series.length > 14 ? 4 : 18;

  return (
    <article className="chart-card">
      <div className="chart-head">
        <h2>Call Volume & Outcomes</h2>
        <div className="legend">
          <span>
            <i className="legend-primary" />
            Total Calls
          </span>
          <span>
            <i className="legend-secondary" />
            Confirmed Bookings
          </span>
        </div>
      </div>
      <div className="chart-area">
        <div className="y-axis">
          {ticks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        <div className="bars" style={{ gridTemplateColumns: gridCols, gap: `${gap}px` }}>
          {series.map((d) => {
            const totalPct = niceMax > 0 ? (d.total / niceMax) * 100 : 0;
            const confirmedPct = d.total > 0 ? (d.confirmed / d.total) * 100 : 0;
            return (
              <div
                className="bar-column"
                key={d.key}
                title={`${useShortDate ? d.shortDate : d.label}: ${d.total} calls, ${d.confirmed} confirmed`}
              >
                <div className="bar total" style={{ height: `${totalPct}%` }}>
                  <div className="confirmed" style={{ height: `${confirmedPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="x-axis" style={{ gridTemplateColumns: gridCols, gap: `${gap}px` }}>
        {series.map((d, i) => (
          <span key={d.key}>{i % labelStride === 0 ? (useShortDate ? d.shortDate : d.label) : ""}</span>
        ))}
      </div>
      {!loading && series.every((d) => d.total === 0) && (
        <p style={{ color: "var(--outline)", fontSize: 12, marginTop: 8, textAlign: "center" }}>
          No calls in the last {days} days.
        </p>
      )}
    </article>
  );
}

function OutcomeBreakdown({ analytics }) {
  const total = analytics?.total_calls ?? 0;
  const bookings = analytics?.bookings_created ?? 0;
  const transferred = analytics?.transferred ?? 0;
  const other = Math.max(0, total - bookings - transferred);
  const pct = (n) => (total ? `${Math.round((n / total) * 100)}%` : "—");

  return (
    <article className="outcome-card">
      <h2>Outcome Breakdown</h2>
      <div className="outcome-art">
        <div className="diamond diamond-primary" />
        <div className="diamond diamond-secondary" />
        <div className="diamond diamond-tertiary" />
        <div className="outcome-center">
          <strong>{total}</strong>
          <span>Total</span>
        </div>
      </div>
      <div className="outcome-list">
        <OutcomeItem color="primary" label="Confirmed Bookings" value={pct(bookings)} />
        <OutcomeItem color="secondary" label="FAQ / Other" value={pct(other)} />
        <OutcomeItem color="tertiary" label="Transferred to Staff" value={pct(transferred)} />
      </div>
    </article>
  );
}

function OutcomeItem({ color, label, value }) {
  return (
    <div className="outcome-item">
      <span>
        <i className={color} />
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}
