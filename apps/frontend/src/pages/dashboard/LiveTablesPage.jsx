import { useCallback, useEffect, useMemo, useState } from "react";
import {
  completeReservation,
  createReservation,
  listReservations,
  listTables,
  seatReservation,
} from "../../api";
import { formatRefreshedAgo, formatVoiceTime12h, zoneIcon } from "../../lib/format";
import { useAuth } from "../../auth";
import { Icon } from "../../components/Icon";
import { TableMetaModal } from "../../components/dashboard/TableMetaModal";
import { NewBookingModal } from "../../components/dashboard/NewBookingModal";
import { DashboardShell } from "./DashboardShell";

const DEFAULT_BOOKING_DURATION_MINUTES = 90;
const DEFAULT_CALENDAR_START_MINUTES = 17 * 60;
const DEFAULT_CALENDAR_END_MINUTES = 23 * 60;
const SLOT_MINUTES = 30;
const REFRESH_INTERVAL_MS = 30_000;

// ----------------------------------------------------------------------------
// Live Tables — GET /api/tables joins today's active reservation per table.
// Status derives from seated_at / completed_at on the joined reservation;
// the partial unique index on reservations (migration 005) is the source of
// truth for "occupies this slot".
// ----------------------------------------------------------------------------

export function LiveTablesPage({ navigate }) {
  const { activeRestaurantId, hasMinRole, memberships } = useAuth();
  const canEdit = hasMinRole("manager");
  const [tables, setTables] = useState([]);
  const [refreshedAt, setRefreshedAt] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionBusyId, setActionBusyId] = useState(null);
  const [editingTable, setEditingTable] = useState(null);
  const [bookingDraft, setBookingDraft] = useState(null);
  // The venue's clock, as reported by the API — never the browser's. A
  // manager checking from another timezone would otherwise see the "Now"
  // marker hours out and the date picker default to the wrong day.
  const [venueClock, setVenueClock] = useState({ today: "", now: "", timezone: null });
  const [calendarWindow, setCalendarWindow] = useState(null);
  // "" means "the venue's today" — the API resolves it on every poll, so the
  // view rolls over at the venue's midnight without a reload.
  const [selectedDate, setSelectedDate] = useState("");
  const [hoursWarning, setHoursWarning] = useState(null);

  const load = useCallback(async (options = {}) => {
    const background = Boolean(options.background);
    if (!background) setLoading(true);
    try {
      const data = await listTables({ date: selectedDate || undefined });
      const reservationsData = await listReservations({ date: data.date, limit: 200 });
      setVenueClock({ today: data.today, now: data.now, timezone: data.timezone });
      const defaultDuration =
        Number(data.booking_duration_minutes) || DEFAULT_BOOKING_DURATION_MINUTES;
      setCalendarWindow(openingWindowForDate(data.date, data.opening_hours));
      setHoursWarning(
        data.opening_hours
          ? null
          : "Opening hours are not set for this venue — showing a default evening window."
      );
      const reservationsByTable = new Map();
      for (const reservation of reservationsData.reservations ?? []) {
        if (
          !reservation.table_id ||
          ["cancelled", "no_show", "completed"].includes(reservation.status)
        ) {
          continue;
        }
        const rows = reservationsByTable.get(reservation.table_id) ?? [];
        rows.push({
          id: reservation.id,
          startTime: reservation.start_time,
          durationMinutes: Number(reservation.duration_minutes) || defaultDuration,
          partySize: reservation.party_size,
          seatedAt: reservation.seated_at,
          guestName: reservation.customer_name,
          status: reservation.seated_at ? "seated" : "reserved",
        });
        reservationsByTable.set(reservation.table_id, rows);
      }
      for (const rows of reservationsByTable.values()) {
        rows.sort(
          (a, b) =>
            (minutesFromTime(a.startTime) ?? 0) - (minutesFromTime(b.startTime) ?? 0)
        );
      }

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
          zone: t.zone || null,
          description: t.description || null,
          attributes: t.attributes ?? [],
          minCapacity: t.min_capacity,
          maxCapacity: t.max_capacity,
          status,
          reservation: hasReservation
            ? {
                id: t.reservation_id,
                startTime: t.reservation_start_time,
                durationMinutes: Number(t.reservation_duration_minutes) || defaultDuration,
                partySize: t.reservation_party_size,
                seatedAt: t.reservation_seated_at,
                guestName: t.customer_name
              }
            : null,
          bookings: reservationsByTable.get(t.id) ?? []
        };
      });
      setTables(mapped);
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      if (!background) setLoading(false);
    }
  }, [selectedDate]);

  // One fetch per date change, then a background poll so bookings Bella takes
  // mid-service appear without anyone pressing Refresh. The poll also moves
  // the "Now" marker, since `now` comes from the API.
  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ background: true }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
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

  const handleCreateBooking = useCallback(
    async (form) => {
      await createReservation({
        customer_name: form.name,
        customer_phone: form.phone,
        party_size: Number(form.partySize),
        date: form.date,
        time: form.time,
        table_id: form.tableId,
        source: "dashboard",
        notes: form.notes || undefined,
      });
      setBookingDraft(null);
      await load();
    },
    [load]
  );

  const counts = useMemo(() => {
    const total = tables.length;
    const seated = tables.filter((t) => t.status === "seated").length;
    const reserved = tables.filter((t) => t.status === "reserved").length;
    return { total, seated, reserved };
  }, [tables]);

  const selectedDateValue = selectedDate || venueClock.today;
  const isViewingToday = Boolean(selectedDateValue) && selectedDateValue === venueClock.today;
  const refreshedAgo = formatRefreshedAgo(refreshedAt);
  const activeRestaurant = memberships.find((m) => m.restaurant_id === activeRestaurantId);
  const restaurantName = activeRestaurant?.name || "Your restaurant";

  return (
    <DashboardShell active="Live Tables" navigate={navigate}>
      <header className="operational-header live-tables-header">
        <div>
          <h1>Live Tables</h1>
          <p>{restaurantName} · Real-time floor and reservation status.</p>
        </div>
        <div className="live-tables-meta">
          <div className="today-pill live-date-picker">
            <Icon name="calendar_today" />
            <input
              type="date"
              value={selectedDateValue}
              onChange={(event) => setSelectedDate(event.target.value)}
              aria-label="Show bookings for date"
            />
          </div>
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
            <span className="feed-stat-label">Upcoming</span>
            <i className="kpi-status-dot reserved" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{counts.reserved}</span>
            <span className="feed-stat-sub">Reserved this date</span>
          </div>
        </article>
      </section>

      <section className="feed-activity-card">
        <div className="feed-activity-header">
          <h2>Table Bookings</h2>
        </div>

        {loading && tables.length === 0 && (
          <div className="live-tables-state">Loading tables…</div>
        )}
        {error && (
          <div className="live-tables-state">Failed to load tables: {error}</div>
        )}
        {hoursWarning && !error && (
          <div className="live-tables-state">{hoursWarning}</div>
        )}
        {!loading && !error && tables.length === 0 && (
          <div className="live-tables-state">No tables configured.</div>
        )}
        {tables.length > 0 && (
          <LiveTablesCalendar
            tables={tables}
            nowMinutes={isViewingToday ? minutesFromTime(venueClock.now) : null}
            calendarWindow={calendarWindow}
            selectedDate={selectedDateValue}
            onSeat={handleSeat}
            onComplete={handleComplete}
            onOpenDetails={(tbl) => navigate(`/live-tables/${encodeURIComponent(tbl.label)}`)}
            onEdit={canEdit ? setEditingTable : null}
            onCreateBooking={setBookingDraft}
            actionBusyId={actionBusyId}
          />
        )}
      </section>

      {editingTable && (
        <TableMetaModal
          table={editingTable}
          onClose={() => setEditingTable(null)}
          onSaved={() => {
            setEditingTable(null);
            load();
          }}
        />
      )}
      {bookingDraft && (
        <NewBookingModal
          initialForm={bookingDraft}
          today={venueClock.today || undefined}
          onClose={() => setBookingDraft(null)}
          onCreate={handleCreateBooking}
        />
      )}
    </DashboardShell>
  );
}

function LiveTablesCalendar({
  tables,
  nowMinutes,
  calendarWindow,
  selectedDate,
  onSeat,
  onComplete,
  onOpenDetails,
  onEdit,
  onCreateBooking,
  actionBusyId,
}) {
  const reservations = tables.flatMap((table) =>
    (table.bookings ?? []).map((reservation) => {
      const startMinutes =
        minutesFromTime(reservation.startTime) ?? DEFAULT_CALENDAR_START_MINUTES;
      const durationMinutes =
        Number(reservation.durationMinutes) || DEFAULT_BOOKING_DURATION_MINUTES;
      return {
        table,
        reservation,
        startMinutes,
        endMinutes: startMinutes + durationMinutes,
      };
    })
  );

  const windowStart = calendarWindow?.start ?? DEFAULT_CALENDAR_START_MINUTES;
  const windowEnd = calendarWindow?.end ?? DEFAULT_CALENDAR_END_MINUTES;
  const rawStart = Math.min(
    windowStart,
    ...reservations.map((booking) => booking.startMinutes)
  );
  const rawEnd = Math.max(
    windowEnd,
    ...reservations.map((booking) => booking.endMinutes)
  );
  const startMinutes = Math.max(0, Math.floor(rawStart / 60) * 60);
  const endMinutes = Math.ceil(rawEnd / 60) * 60;
  const totalMinutes = Math.max(SLOT_MINUTES, endMinutes - startMinutes);
  const slotCount = Math.ceil(totalMinutes / SLOT_MINUTES);
  const timeSlots = Array.from({ length: slotCount + 1 }, (_, idx) =>
    startMinutes + idx * SLOT_MINUTES
  );
  // Only draw the marker on the venue's current day and inside the window —
  // paging to next Saturday must not show a "Now" line.
  const showNow =
    nowMinutes != null && nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  const nowLeft = showNow ? `${((nowMinutes - startMinutes) / totalMinutes) * 100}%` : "0%";

  return (
    <div className="lt-calendar-shell">
      <div
        className="lt-calendar-scroll"
        style={{ "--lt-slots": slotCount, "--lt-now-left": nowLeft }}
      >
        <div className="lt-calendar-header">
          <div className="lt-table-axis">Table</div>
          <div className="lt-time-axis">
            {timeSlots.map((minutes, index) => (
              <span key={`${minutes}-${index}`} style={{ left: `${(index / slotCount) * 100}%` }}>
                {formatMinutes(minutes)}
              </span>
            ))}
            {showNow && (
              <span className="lt-now-label" style={{ left: nowLeft }}>
                Now
              </span>
            )}
          </div>
        </div>

        <div className="lt-calendar-body">
          {tables.map((table) => (
            <CalendarTableLane
              key={table.id ?? table.label}
              table={table}
              startMinutes={startMinutes}
              totalMinutes={totalMinutes}
              slotCount={slotCount}
              showNow={showNow}
              selectedDate={selectedDate}
              onSeat={onSeat}
              onComplete={onComplete}
              onOpenDetails={onOpenDetails}
              onEdit={onEdit}
              onCreateBooking={onCreateBooking}
              actionBusyId={actionBusyId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CalendarTableLane({
  table,
  startMinutes,
  totalMinutes,
  slotCount,
  showNow,
  selectedDate,
  onSeat,
  onComplete,
  onOpenDetails,
  onEdit,
  onCreateBooking,
  actionBusyId,
}) {
  const bookings = table.bookings ?? [];

  return (
    <div className={`lt-calendar-row status-${table.status}`} style={{ "--lt-slots": slotCount }}>
      <div className="lt-table-label">
        <span className="table-label-main">
          {table.label}
          {table.zone && (
            <span className={`zone-badge zone-${table.zone}`}>
              <Icon name={zoneIcon(table.zone)} />
              {table.zone}
            </span>
          )}
        </span>
        <span className="lt-table-capacity">
          <Icon name="group" />
          {table.minCapacity}-{table.maxCapacity}
        </span>
      </div>

      <div
        className="lt-calendar-track"
        role="button"
        tabIndex={0}
        aria-label={`Create booking for table ${table.label}`}
        onClick={(event) => {
          if (event.target.closest("button, .lt-booking")) return;
          onCreateBooking?.({
            name: "",
            phone: "",
            partySize: table.minCapacity || 2,
            date: selectedDate,
            time: timeFromTrackClick(event, startMinutes, totalMinutes),
            tableId: table.id,
            tableLabel: table.label,
            notes: "",
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onCreateBooking?.({
            name: "",
            phone: "",
            partySize: table.minCapacity || 2,
            date: selectedDate,
            time: formatTimeForInput(startMinutes),
            tableId: table.id,
            tableLabel: table.label,
            notes: "",
          });
        }}
      >
        {showNow && <span className="lt-now-line" />}
        {bookings.length === 0 && (
          <span className="lt-empty-lane">
            Click a time to book
            {onEdit && (
              <button
                type="button"
                className="row-action ghost icon-only"
                onClick={() => onEdit(table)}
                aria-label={`Edit table ${table.label}`}
                title="Edit zone & description"
              >
                <Icon name="edit" />
              </button>
            )}
          </span>
        )}
        {bookings.map((booking) => (
          <CalendarBooking
            key={booking.id}
            table={table}
            booking={booking}
            startMinutes={startMinutes}
            totalMinutes={totalMinutes}
            onSeat={onSeat}
            onComplete={onComplete}
            onOpenDetails={onOpenDetails}
            onEdit={onEdit}
            busy={actionBusyId === booking.id}
          />
        ))}
      </div>
    </div>
  );
}

function CalendarBooking({
  table,
  booking,
  startMinutes,
  totalMinutes,
  onSeat,
  onComplete,
  onOpenDetails,
  onEdit,
  busy,
}) {
  const isReserved = booking.status === "reserved";
  const isSeated = booking.status === "seated";
  const timeLabel = formatVoiceTime12h(booking.startTime);
  const guest = booking.guestName ?? "Guest";
  const party = booking.partySize ?? "";
  const start = minutesFromTime(booking.startTime);
  const duration = Number(booking.durationMinutes) || DEFAULT_BOOKING_DURATION_MINUTES;
  const left = start == null ? 0 : ((start - startMinutes) / totalMinutes) * 100;
  const width = (duration / totalMinutes) * 100;
  const blockStyle = {
    left: `${Math.max(0, left)}%`,
    width: `${Math.max(8, Math.min(100 - Math.max(0, left), width))}%`,
  };

  return (
    <article
      className={`lt-booking status-${booking.status}`}
      style={blockStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="lt-booking-main">
        <span className="lt-booking-time">{timeLabel}</span>
        <strong>{guest}</strong>
        <span>{party}pp · {duration} min</span>
      </div>
      <div className="lt-booking-actions">
        {isReserved && (
          <button
            className="row-action primary"
            onClick={() => onSeat?.(booking.id)}
            disabled={busy}
          >
            <Icon name="chair_alt" /> {busy ? "Seating…" : "Seat"}
          </button>
        )}
        {isSeated && (
          <button
            className="row-action primary"
            onClick={() => onComplete?.(booking.id)}
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
          View
        </button>
        {onEdit && (
          <button
            type="button"
            className="row-action ghost icon-only"
            onClick={() => onEdit(table)}
            aria-label={`Edit table ${table.label}`}
            title="Edit zone & description"
          >
            <Icon name="edit" />
          </button>
        )}
      </div>
    </article>
  );
}

function minutesFromTime(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).split(":").map((part) => Number(part));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function openingWindowForDate(date, openingHours) {
  const dayKey = dayKeyForDate(date);
  const windows = openingWindowsForDay(openingHours?.[dayKey]);
  if (windows.length === 0) {
    return {
      start: DEFAULT_CALENDAR_START_MINUTES,
      end: DEFAULT_CALENDAR_END_MINUTES,
    };
  }

  const ranges = windows
    .map((window) => {
      const open = minutesFromTime(window.open);
      const close = minutesFromTime(window.close);
      if (open == null || close == null || open === close) return null;
      return {
        start: open,
        end: close > open ? close : close + 24 * 60,
      };
    })
    .filter(Boolean);

  if (ranges.length === 0) {
    return {
      start: DEFAULT_CALENDAR_START_MINUTES,
      end: DEFAULT_CALENDAR_END_MINUTES,
    };
  }

  return {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
}

function openingWindowsForDay(day) {
  if (Array.isArray(day)) return day;
  if (!day || day.closed) return [];
  if (day.open && day.close) {
    return [{ open: day.open, close: day.close }];
  }
  return [];
}

function dayKeyForDate(date) {
  const parsed = new Date(`${date}T12:00:00`);
  return parsed
    .toLocaleDateString("en-AU", { weekday: "long" })
    .toLowerCase();
}

function formatMinutes(minutes) {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function formatTimeForInput(minutes) {
  const normalized = ((Math.round(minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function timeFromTrackClick(event, startMinutes, totalMinutes) {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const rawMinutes = startMinutes + ratio * totalMinutes;
  const roundedMinutes = Math.round(rawMinutes / SLOT_MINUTES) * SLOT_MINUTES;
  return formatTimeForInput(roundedMinutes);
}
