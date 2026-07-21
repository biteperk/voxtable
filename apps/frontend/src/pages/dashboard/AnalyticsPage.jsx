import { useEffect, useMemo, useRef, useState } from "react";
import { getAnalytics, getAnalyticsDailySeries, getAnalyticsMonthlySeries } from "../../api";
import {
  decorateDailySeries,
  decorateMonthlySeries,
  formatDuration,
  monthLabel,
  monthRangeFromKey,
  recentMonthKeys
} from "../../lib/format";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

const MONTHS_IN_PICKER = 12;

export function AnalyticsPage({ navigate }) {
  // Selected calendar month, "YYYY-MM". Defaults to the current month. The
  // backend resolves the month boundaries in the restaurant's local timezone.
  const [monthKey, setMonthKey] = useState(() => recentMonthKeys(new Date(), 1)[0]);
  const [analytics, setAnalytics] = useState(null);
  const [dailySeries, setDailySeries] = useState([]);
  const [monthlySeries, setMonthlySeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const periodRef = useRef(null);

  // Month options for the picker — derived from the trend series so the list
  // only ever spans months the restaurant has actually existed for (no empty
  // pre-launch months). Newest first; current/previous month labelled. Before
  // the series loads, offer at least the current month so the picker isn't empty.
  const monthOptions = useMemo(() => {
    if (!monthlySeries.length) {
      const cur = recentMonthKeys(new Date(), 1)[0];
      return [{ key: cur, label: monthLabel(cur), relative: "This month" }];
    }
    return [...monthlySeries].reverse().map((m, i) => ({
      key: m.key,
      label: m.longLabel,
      relative: i === 0 ? "This month" : i === 1 ? "Last month" : null
    }));
  }, [monthlySeries]);

  // Selected-month stats + per-day breakdown (refetched when the month changes).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { from, to } = monthRangeFromKey(monthKey);
    Promise.all([getAnalytics({ from, to }), getAnalyticsDailySeries({ from, to })])
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
  }, [monthKey]);

  // 12-month trend — fetched once; drives the trend chart and MoM deltas.
  useEffect(() => {
    let cancelled = false;
    getAnalyticsMonthlySeries({ months: MONTHS_IN_PICKER })
      .then((res) => !cancelled && setMonthlySeries(decorateMonthlySeries(res.series ?? [])))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

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
  // Prefer the analyzer-driven `bookings_confirmed`; fall back to the legacy
  // `bookings_created` count of call_logs linked to a reservation.
  const bookingsCount = analytics?.bookings_confirmed ?? analytics?.bookings_created ?? 0;
  const bookingRate =
    totalCalls > 0 ? `${Math.round((bookingsCount / totalCalls) * 100)}%` : "—";
  const monthlyRevenue = `$${(bookingsCount * 80).toLocaleString("en-AU")}`;
  const avgLatency = analytics?.avg_latency_ms
    ? `${(analytics.avg_latency_ms / 1000).toFixed(1)}s`
    : "—";
  const avgDuration =
    analytics?.avg_duration_seconds != null
      ? formatDuration(analytics.avg_duration_seconds)
      : "—";

  // Month-over-month: locate the selected month in the ascending trend series
  // and compare against the immediately preceding month.
  const selIdx = monthlySeries.findIndex((m) => m.key === monthKey);
  const prevMonth = selIdx > 0 ? monthlySeries[selIdx - 1] : null;
  const callsDelta = pctDelta(totalCalls, prevMonth?.total, prevMonth?.label);
  const bookingsDelta = pctDelta(bookingsCount, prevMonth?.confirmed, prevMonth?.label);

  const selectedOption =
    monthOptions.find((o) => o.key === monthKey) ?? { key: monthKey, label: monthLabel(monthKey), relative: null };
  const periodLabel = selectedOption.label;

  const handleExport = async () => {
    if (exporting || loading) return;
    setExporting(true);
    try {
      const { exportAnalyticsPdf } = await import("../../pdfExport.js");
      exportAnalyticsPdf({
        periodLabel,
        fileSlug: monthKey,
        metrics: {
          totalCalls,
          bookingsCount,
          bookingRate,
          monthlyRevenue,
          avgLatency,
          avgDuration
        },
        dailySeries,
        analytics
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
          <p>{error ? `Error: ${error}` : `${periodLabel} of PerkTable AI activity.`}</p>
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
                {monthOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={monthKey === opt.key}
                    className={`period-menu-item${monthKey === opt.key ? " is-active" : ""}`}
                    onClick={() => {
                      setMonthKey(opt.key);
                      setPeriodOpen(false);
                    }}
                  >
                    <span>
                      {opt.label}
                      {opt.relative ? <em className="period-relative">{opt.relative}</em> : null}
                    </span>
                    {monthKey === opt.key ? <Icon name="check" /> : null}
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
        <Metric
          icon="call"
          label="Total Calls"
          value={loading ? "…" : String(totalCalls)}
          change={callsDelta ? callsDelta.text : "no prior month"}
          down={callsDelta?.down ?? false}
        />
        <Metric
          icon="event_available"
          label="Booking Conversion"
          value={loading ? "…" : bookingRate}
          change={bookingsDelta ? bookingsDelta.text : `${bookingsCount} bookings`}
          down={bookingsDelta?.down ?? false}
          tone="secondary"
        />
        <Metric
          icon="payments"
          label="Est. Revenue"
          value={loading ? "…" : monthlyRevenue}
          change={bookingsDelta ? bookingsDelta.text : "$80 / booking"}
          down={bookingsDelta?.down ?? false}
          tone="tertiary"
        />
        <Metric
          icon="timer"
          label="Avg Call Duration"
          value={loading ? "…" : avgDuration}
          change={analytics?.avg_latency_ms ? `${avgLatency} latency` : ""}
        />
      </section>

      <section className="analytics-trend">
        <MonthlyTrendChart
          series={monthlySeries}
          loading={loading}
          selectedKey={monthKey}
          onSelectMonth={setMonthKey}
        />
      </section>

      <section className="analytics-lower-grid">
        <CallVolumeChart series={dailySeries} loading={loading} periodLabel={periodLabel} />
        <OutcomeBreakdown analytics={analytics} />
      </section>
    </DashboardShell>
  );
}

// Month-over-month percent change of `cur` vs `prev`. Returns null when there
// is no prior month, or when both months are empty (nothing meaningful to say).
function pctDelta(cur, prev, prevLabel) {
  if (prev == null || prevLabel == null) return null;
  if (prev === 0) return cur > 0 ? { text: `new vs ${prevLabel}`, down: false } : null;
  const d = Math.round(((cur - prev) / prev) * 100);
  return { text: `${d >= 0 ? "+" : ""}${d}% vs ${prevLabel}`, down: d < 0 };
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

// Per-calendar-month bars across the trend window. Each bar is clickable and
// jumps the rest of the page to that month; the selected month is highlighted.
function MonthlyTrendChart({ series, loading, selectedKey, onSelectMonth }) {
  const maxTotal = Math.max(1, ...series.map((d) => d.total));
  // Round up to the next multiple of 4 STRICTLY above maxTotal so the tallest
  // bar never reaches 100% — leaves room for the value label above each bar.
  const niceMax = Math.max(4, (Math.floor(maxTotal / 4) + 1) * 4);
  const ticks = [niceMax, Math.round(niceMax * 0.75), Math.round(niceMax * 0.5), Math.round(niceMax * 0.25), 0];
  const gridCols = `repeat(${Math.max(series.length, 1)}, minmax(0, 1fr))`;
  const hasSelection = series.some((d) => d.key === selectedKey);

  return (
    <article className="chart-card">
      <div className="chart-head">
        <h2>Monthly Trend</h2>
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
        <div className="bars" style={{ gridTemplateColumns: gridCols, gap: 10 }}>
          {series.map((d) => {
            const totalPct = niceMax > 0 ? (d.total / niceMax) * 100 : 0;
            const confirmedPct = d.total > 0 ? (d.confirmed / d.total) * 100 : 0;
            const isSelected = d.key === selectedKey;
            return (
              <button
                type="button"
                className={`bar-column trend-bar${isSelected ? " is-selected" : ""}${
                  hasSelection && !isSelected ? " is-dimmed" : ""
                }`}
                key={d.key}
                onClick={() => onSelectMonth(d.key)}
                title={`${d.longLabel}: ${d.total} calls, ${d.confirmed} confirmed`}
              >
                <span className="trend-bar-value">{d.total}</span>
                <div className="bar total" style={{ height: `${totalPct}%` }}>
                  <div className="confirmed" style={{ height: `${confirmedPct}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="x-axis" style={{ gridTemplateColumns: gridCols, gap: 10 }}>
        {series.map((d) => (
          <span key={d.key} className={d.key === selectedKey ? "is-selected" : ""}>
            {d.label}
          </span>
        ))}
      </div>
      {!loading && series.length > 0 && series.every((d) => d.total === 0) && (
        <p style={{ color: "var(--outline)", fontSize: 12, marginTop: 8, textAlign: "center" }}>
          No calls yet.
        </p>
      )}
    </article>
  );
}

function CallVolumeChart({ series, loading, periodLabel }) {
  const maxTotal = Math.max(1, ...series.map((d) => d.total));
  const niceMax = Math.max(4, Math.ceil(maxTotal / 4) * 4);
  const ticks = [niceMax, Math.round(niceMax * 0.75), Math.round(niceMax * 0.5), Math.round(niceMax * 0.25), 0];

  // The selected month is up to 31 days — sample x-axis labels so they don't
  // overlap, and use a short date since weekdays repeat across the month.
  const useShortDate = series.length > 7;
  const labelStride = series.length <= 14 ? 1 : Math.ceil(series.length / 10);

  const gridCols = `repeat(${Math.max(series.length, 1)}, minmax(0, 1fr))`;
  const gap = series.length > 14 ? 4 : 18;

  return (
    <article className="chart-card">
      <div className="chart-head">
        <h2>Daily Calls — {periodLabel}</h2>
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
          No calls in {periodLabel}.
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
