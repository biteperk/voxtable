import { useCallback, useEffect, useMemo, useState } from "react";
import { completeReservation, listTables, seatReservation } from "../../api";
import { formatRefreshedAgo, formatVoiceTime12h } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

// ----------------------------------------------------------------------------
// Live Tables — GET /api/tables joins today's active reservation per table.
// Status derives from seated_at / completed_at on the joined reservation;
// the partial unique index on reservations (migration 005) is the source of
// truth for "occupies this slot".
// ----------------------------------------------------------------------------

export function LiveTablesPage({ navigate }) {
  const [tables, setTables] = useState([]);
  const [refreshedAt, setRefreshedAt] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionBusyId, setActionBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listTables();
      const mapped = (data.tables ?? []).map((t) => {
        const hasReservation = Boolean(t.reservation_id);
        const status = !hasReservation
          ? "available"
          : t.reservation_seated_at
            ? "seated"
            : "reserved";
        return {
          id: t.id,
          label: t.label,
          minCapacity: t.min_capacity,
          maxCapacity: t.max_capacity,
          status,
          reservation: hasReservation
            ? {
                id: t.reservation_id,
                startTime: t.reservation_start_time,
                partySize: t.reservation_party_size,
                seatedAt: t.reservation_seated_at,
                guestName: t.customer_name
              }
            : null
        };
      });
      setTables(mapped);
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = () => {
    load();
  };

  const handleSeat = useCallback(
    async (reservationId) => {
      setActionBusyId(reservationId);
      setError(null);
      try {
        await seatReservation(reservationId);
        await load();
      } catch (err) {
        setError(err.message ?? String(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [load]
  );

  const handleComplete = useCallback(
    async (reservationId) => {
      setActionBusyId(reservationId);
      setError(null);
      try {
        await completeReservation(reservationId);
        await load();
      } catch (err) {
        setError(err.message ?? String(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [load]
  );

  const counts = useMemo(() => {
    const total = tables.length;
    const seated = tables.filter((t) => t.status === "seated").length;
    const reserved = tables.filter((t) => t.status === "reserved").length;
    return { total, seated, reserved };
  }, [tables]);

  const todayLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  const refreshedAgo = formatRefreshedAgo(refreshedAt);

  return (
    <DashboardShell active="Live Tables" navigate={navigate}>
      <header className="operational-header live-tables-header">
        <div>
          <h1>Live Tables</h1>
          <p>Real-time floor and reservation status.</p>
        </div>
        <div className="live-tables-meta">
          <span className="today-pill">
            <Icon name="calendar_today" />
            {todayLabel}
          </span>
          <button className="feed-action-btn" onClick={refresh} aria-label="Refresh">
            <Icon name="refresh" />
            {refreshedAgo}
          </button>
        </div>
      </header>

      <section className="feed-summary-cards">
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Total Tables</span>
            <Icon name="table_restaurant" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{counts.total}</span>
            <span className="feed-stat-sub">Active in floor</span>
          </div>
        </article>

        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Occupied</span>
            <i className="kpi-status-dot seated" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">
              {counts.seated}
              <em className="feed-stat-denominator">/ {counts.total}</em>
            </span>
            <span className="feed-stat-sub">Seated now</span>
          </div>
        </article>

        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Upcoming Today</span>
            <i className="kpi-status-dot reserved" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{counts.reserved}</span>
            <span className="feed-stat-sub">Reserved tonight</span>
          </div>
        </article>
      </section>

      <section className="feed-activity-card">
        <div className="feed-activity-header">
          <h2>Tonight's Tables</h2>
        </div>

        <div className="live-tables-list">
          <div className="live-tables-row live-tables-row-head">
            <span>Table</span>
            <span>Capacity</span>
            <span>Status</span>
            <span className="live-tables-action-col">Action</span>
          </div>
          {loading && tables.length === 0 && (
            <div className="live-tables-row"><span>Loading tables…</span></div>
          )}
          {error && (
            <div className="live-tables-row"><span>Failed to load tables: {error}</span></div>
          )}
          {!loading && !error && tables.length === 0 && (
            <div className="live-tables-row"><span>No tables configured.</span></div>
          )}
          {tables.map((t) => (
            <TableRow
              key={t.id ?? t.label}
              table={t}
              onSeat={handleSeat}
              onComplete={handleComplete}
              onOpenDetails={(tbl) => navigate(`/live-tables/${encodeURIComponent(tbl.label)}`)}
              busy={t.reservation && actionBusyId === t.reservation.id}
            />
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}

function TableRow({ table, onSeat, onComplete, onOpenDetails, busy }) {
  const isReserved = table.status === "reserved";
  const isSeated = table.status === "seated";
  const r = table.reservation;
  const timeLabel = r ? formatVoiceTime12h(r.startTime) : "";
  const guest = r?.guestName ?? "Guest";
  const party = r?.partySize ?? "";

  return (
    <div className={`live-tables-row status-${table.status}`}>
      <span className="table-label">{table.label}</span>
      <span className="table-capacity">
        <Icon name="group" />
        {table.minCapacity}-{table.maxCapacity}
      </span>
      <span className="table-status">
        <i className={`status-dot ${table.status}`} />
        {table.status === "available" && "Available"}
        {isReserved && (
          <>
            Reserved {timeLabel} — {guest} ({party}pp)
          </>
        )}
        {isSeated && (
          <>
            Seated — {guest} ({party}pp)
          </>
        )}
      </span>
      <span className="live-tables-action-col">
        {isReserved && (
          <button
            className="row-action primary"
            onClick={() => onSeat?.(r.id)}
            disabled={busy}
          >
            <Icon name="chair_alt" /> {busy ? "Seating…" : "Seat"}
          </button>
        )}
        {isSeated && (
          <button
            className="row-action primary"
            onClick={() => onComplete?.(r.id)}
            disabled={busy}
          >
            <Icon name="check" /> {busy ? "Marking…" : "Mark Done"}
          </button>
        )}
        <button
          type="button"
          className="row-action ghost"
          onClick={() => onOpenDetails?.(table)}
          aria-label={`View details for ${table.label}`}
        >
          <Icon name="receipt_long" />
          View Order
        </button>
      </span>
    </div>
  );
}
