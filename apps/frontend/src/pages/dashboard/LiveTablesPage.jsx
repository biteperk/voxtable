import { useCallback, useEffect, useMemo, useState } from "react";
import {
  completeReservation,
  createReservation,
  getRestaurantProfile,
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
  const [now, setNow] = useState(new Date());
  const [calendarWindow, setCalendarWindow] = useState(null);
  const [selectedDate, setSelectedDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listTables({ date: selectedDate || undefined });
      const [reservationsData, profileData] = await Promise.all([
        listReservations({ date: data.date, limit: 200 }),
        getRestaurantProfile().catch(() => ({ profile: null })),
      ]);
      if (!selectedDate) setSelectedDate(data.date);
      setCalendarWindow(
        openingWindowForDate(data.date, profileData.profile?.opening_hours)
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
          durationMinutes:
            Number(reservation.duration_minutes) || DEFAULT_BOOKING_DURATION_MINUTES,
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
                durationMinutes:
                  Number(t.reservation_duration_minutes) ||
                  DEFAULT_BOOKING_DURATION_MINUTES,
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
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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

  const selectedDateValue = selectedDate || dateInputValue(now);
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
        {!loading && !error && tables.length === 0 && (
          <div className="live-tables-state">No tables configured.</div>
        )}
        {tables.length > 0 && (
          <LiveTablesCalendar
            tables={tables}
            now={now}
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
          onClose={() => setBookingDraft(null)}
          onCreate={handleCreateBooking}
        />
      )}
    </DashboardShell>
  );
}

function LiveTablesCalendar({
  tables,
  now,
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

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
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
  const showNow = nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  const nowLeft = `${((nowMinutes - startMinutes) / totalMinutes) * 100}%`;

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
              busy={table.reservation && actionBusyId === table.reservation.id}
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
  busy,
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
            notes: "",
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          onCreateBooking?.({
            name: "",
            phone: "",
            partySize: table.minCapacity || 2,
            date: selectedDate,
            time: formatTimeForInput(startMinutes),
            tableId: table.id,
            notes: "",
          });
        }}
      >
        {Array.from({ length: slotCount }).map((_, idx) => (
          <span key={idx} className="lt-slot-line" />
        ))}
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
            busy={busy && table.reservation?.id === booking.id}
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

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
