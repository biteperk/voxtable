import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelReservation,
  createReservation,
  getAnalytics,
  listReservations,
  updateReservationStatus
} from "../../api";
import { formatReservationDate, formatVoiceTime12h, mapReservationToRow } from "../../lib/format";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";
import { NewBookingModal } from "../../components/dashboard/NewBookingModal";

export function BookingLogPage({ navigate, path }) {
  const [reservations, setReservations] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mutationError, setMutationError] = useState(null);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [confirmState, setConfirmState] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [newBookingOpen, setNewBookingOpen] = useState(false);
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

  const refreshReservations = useCallback(async () => {
    const res = await listReservations({ limit: 100 });
    setReservations(res.reservations ?? []);
  }, []);

  const handleCreateBooking = async (form) => {
    // POST to /bookings → bookingService.createBooking does the real work
    // (advisory lock, availability check, Cal.com outbox enqueue). Returns
    // a real UUID we then use as row.id so every subsequent action
    // (no-show, cancel, restore) works without a special case.
    //
    // Side effect: when CALCOM_SYNC_ENABLED=true (prod default), this also
    // mirrors the booking to Cal.com via the outbox worker. Manual entries
    // therefore show up on the restaurant's Cal.com calendar. If a "local
    // only" mode is needed later, plumb a `sync_calcom: false` flag through
    // createBookingRequestSchema → createBooking → enqueueCreateForReservation.
    //
    // Timezone assumption: form.date and form.time are read from <input
    // type=date>/<input type=time> in the host's browser local TZ. The
    // backend stores them as TZ-naive DATE+TIME at the restaurant's TZ
    // (`restaurants.timezone`). Works only because the dashboard is used
    // from the same TZ as the restaurant — breaks for cross-TZ multi-venue
    // hosts (v2 concern: add a TZ picker or display the restaurant TZ).
    await createReservation({
      customer_name: form.name,
      customer_phone: form.phone,
      party_size: Number(form.partySize),
      date: form.date,
      time: form.time,
      source: "dashboard",
      notes: form.notes || undefined,
    });
    await refreshReservations();
    setNewBookingOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([listReservations({ limit: 100 }), getAnalytics({ days: 30 })])
      .then(([res, stats]) => {
        if (cancelled) return;
        setReservations(res.reservations ?? []);
        setAnalytics(stats.analytics ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const markPending = (id, on) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const applyStatusLocally = (id, status) => {
    setReservations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status } : r))
    );
  };

  const requestConfirm = (action, id) => {
    const reservation = reservations.find((r) => r.id === id);
    setConfirmState({ action, id, reservation });
  };

  const dismissConfirm = () => {
    if (confirmBusy) return;
    setConfirmState(null);
  };

  const runMutation = async (action, id) => {
    markPending(id, true);
    setMutationError(null);
    setConfirmBusy(true);
    try {
      if (action === "no-show") {
        await updateReservationStatus(id, "no_show");
        applyStatusLocally(id, "no_show");
      } else if (action === "cancel") {
        await cancelReservation(id);
        applyStatusLocally(id, "cancelled");
      } else if (action === "restore") {
        await updateReservationStatus(id, "confirmed");
        applyStatusLocally(id, "confirmed");
      }
      setConfirmState(null);
    } catch (e) {
      setMutationError(e.message ?? String(e));
      setConfirmState(null);
    } finally {
      setConfirmBusy(false);
      markPending(id, false);
    }
  };

  const handleMarkNoShow = (id) => requestConfirm("no-show", id);
  const handleCancel = (id) => requestConfirm("cancel", id);
  const handleRestore = (id) => runMutation("restore", id);

  const q = searchQuery.trim().toLowerCase();
  const filteredReservations = reservations.filter((r) => {
    if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false;
    if (q.length === 0) return true;
    const hay = [
      r.customer_name,
      r.customer_phone,
      r.notes,
      r.source,
      String(r.party_size ?? ""),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
  const rows = filteredReservations.map((r) => ({
    ...mapReservationToRow(r),
    pending: pendingIds.has(r.id)
  }));
  const totalBookings = reservations.length;
  const confirmed = reservations.filter((r) => r.status === "confirmed").length;
  const cancelled = reservations.filter((r) => r.status === "cancelled").length;
  const isFiltered = statusFilter.size > 0 || q.length > 0;
  const successRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.bookings_created / analytics.total_calls) * 100)}%`
      : "—";

  return (
    <DashboardShell active="Booking Log" navigate={navigate} path={path}>

      <header className="booking-log-header">
        <div>
          <h1>Booking Log</h1>
          <p>Manage reservations and AI interactions.</p>
        </div>
        <div className="booking-actions">
          <label className="booking-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Search bookings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search bookings"
            />
            {searchQuery && (
              <button
                type="button"
                className="booking-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <Icon name="close" />
              </button>
            )}
          </label>
          <div className="booking-filter-wrap" ref={filterRef}>
            <button
              type="button"
              className={`square-action ${filterOpen ? "is-open" : ""}`}
              onClick={() => setFilterOpen((v) => !v)}
              aria-label="Filter bookings"
              aria-expanded={filterOpen}
            >
              <Icon name="filter_list" />
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
                  { key: "confirmed", label: "Confirmed" },
                  { key: "seated", label: "Seated" },
                  { key: "completed", label: "Completed" },
                  { key: "cancelled", label: "Cancelled" },
                  { key: "no_show", label: "No-show" },
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
          <button
            type="button"
            className="new-booking-button"
            onClick={() => setNewBookingOpen(true)}
          >
            <Icon name="add" />
            New
          </button>
        </div>
      </header>

      <section className="booking-stats">
        <BookingStat title="Total Bookings" value={loading ? "…" : String(totalBookings)} note="Last 100 records" icon="book_online" />
        <BookingStat title="Confirmed" value={loading ? "…" : String(confirmed)} note="Via AI & Web" icon="check_circle" />
        <BookingStat title="Cancelled" value={loading ? "…" : String(cancelled)} note="Customer or staff" icon="warning" tone="warning" />
        <BookingStat title="Booking Rate" value={loading ? "…" : successRate} note="Bookings per call (30d)" icon="smart_toy" tone="primary" />
      </section>

      <section className="reservations-panel">
        <div className="reservations-head">
          <div>
            <h2>Recent Reservations</h2>
            <span>{new Date().toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}</span>
          </div>
          <button>Export</button>
        </div>

        {mutationError && (
          <div className="booking-mutation-error" role="alert">
            <Icon name="error" />
            <span>{mutationError}</span>
            <button type="button" onClick={() => setMutationError(null)} aria-label="Dismiss">
              <Icon name="close" />
            </button>
          </div>
        )}

        {isPhone ? (
          <ul className="booking-card-list" aria-label="Reservations">
            {rows.length === 0 && !loading && (
              <li className="booking-card-empty">
                {isFiltered ? "No bookings match your filters." : "No reservations yet."}
              </li>
            )}
            {rows.map((row) => (
              <BookingCardItem key={row.id} row={row} />
            ))}
          </ul>
        ) : (
          <div className="booking-table-wrap">
            <table className="booking-table">
              <thead>
                <tr>
                  <th>Date / Time</th>
                  <th>Guest</th>
                  <th>Party</th>
                  <th>Table</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7} className="booking-table-empty">
                      {isFiltered ? "No bookings match your filters." : "No reservations yet."}
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <BookingRow
                    key={row.id}
                    row={row}
                    onMarkNoShow={handleMarkNoShow}
                    onCancel={handleCancel}
                    onRestore={handleRestore}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <footer className="booking-table-footer">
          <span>
            {loading
              ? "Loading…"
              : error
              ? `Error: ${error}`
              : isFiltered
              ? `${rows.length} of ${totalBookings} reservation${totalBookings === 1 ? "" : "s"}`
              : `${rows.length} reservation${rows.length === 1 ? "" : "s"}`}
          </span>
        </footer>
      </section>

      <ConfirmModal
        state={confirmState}
        busy={confirmBusy}
        onCancel={dismissConfirm}
        onConfirm={() => confirmState && runMutation(confirmState.action, confirmState.id)}
      />

      {newBookingOpen && (
        <NewBookingModal
          onClose={() => setNewBookingOpen(false)}
          onCreate={handleCreateBooking}
        />
      )}
    </DashboardShell>
  );
}

const CONFIRM_COPY = {
  "no-show": {
    title: "Mark as no-show?",
    description:
      "The guest didn't arrive. Marking as no-show frees the table for walk-ins and shows the booking as struck through on this list. You can restore it later if they call.",
    confirmLabel: "Mark no-show",
    confirmTone: "warning",
    icon: "person_off"
  },
  cancel: {
    title: "Cancel this reservation?",
    description:
      "This will set the booking to Cancelled and free the slot. The caller will not be notified automatically — please follow up with them if needed.",
    confirmLabel: "Cancel reservation",
    confirmTone: "danger",
    icon: "block"
  }
};

function ConfirmModal({ state, busy, onConfirm, onCancel }) {
  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onCancel();
      if (e.key === "Enter" && !busy) onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, busy, onCancel, onConfirm]);

  if (!state) return null;
  const copy = CONFIRM_COPY[state.action];
  if (!copy) return null;

  const r = state.reservation;
  const dateLabel = r ? formatReservationDate(r.reservation_date) : "";
  const timeLabel = r ? formatVoiceTime12h(r.start_time) : "";

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal-card">
        <div className={`modal-icon tone-${copy.confirmTone}`}>
          <Icon name={copy.icon} />
        </div>
        <h2 id="confirm-modal-title" className="modal-title">{copy.title}</h2>
        <p className="modal-description">{copy.description}</p>

        {r && (
          <div className="modal-context">
            <div className="modal-context-row">
              <span className="modal-context-label">Guest</span>
              <strong>{r.customer_name || "Unknown"}</strong>
            </div>
            <div className="modal-context-row">
              <span className="modal-context-label">When</span>
              <strong>
                {dateLabel} · {timeLabel}
              </strong>
            </div>
            <div className="modal-context-row">
              <span className="modal-context-label">Party</span>
              <strong>{r.party_size}</strong>
            </div>
            {r.table_label && (
              <div className="modal-context-row">
                <span className="modal-context-label">Table</span>
                <strong>
                  {r.table_label}
                  {r.table_description ? ` · ${r.table_description}` : ""}
                </strong>
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-button ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`modal-button ${copy.confirmTone}`}
            disabled={busy}
            onClick={onConfirm}
            autoFocus
          >
            {busy ? (
              <>
                <span className="modal-spinner" aria-hidden="true" />
                Working…
              </>
            ) : (
              copy.confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingStat({ title, value, note, icon, tone = "" }) {
  return (
    <article className={`booking-stat ${tone}`}>
      <div>
        <span>{title}</span>
        <Icon name={icon} />
      </div>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function BookingRow({ row, onMarkNoShow, onCancel, onRestore }) {
  const tone = row.statusTone;
  const isClosed = tone === "cancelled" || tone === "no_show";
  const canMarkNoShow = !isClosed && tone !== "seated";
  const canCancel = !isClosed;
  const canRestore = isClosed;

  return (
    <tr className={`${row.muted ? "muted" : ""} ${row.pending ? "pending" : ""}`}>
      <td className="booking-time">
        <strong>{row.dateLabel}</strong>
        <span>{row.timeLabel}</span>
        {row.ref && <span className="booking-ref">{row.ref}</span>}
      </td>
      <td>
        <strong>{row.guest}</strong>
        <span>{row.phone}</span>
      </td>
      <td>{row.party}</td>
      <td>
        {row.tableLabel ? (
          <div className="booking-table-cell">
            <span className="booking-table-name">
              <Icon name="table_restaurant" />
              {row.tableLabel}
              {row.tableZone && (
                <span className={`zone-badge zone-${row.tableZone}`}>{row.tableZone}</span>
              )}
            </span>
            {row.tableDescription && (
              <span className="booking-table-desc" title={row.tableDescription}>
                {row.tableDescription}
              </span>
            )}
          </div>
        ) : (
          <span className="booking-table-unassigned">Unassigned</span>
        )}
      </td>
      <td>
        <span className={`status-pill ${row.statusTone}`}>
          {row.statusTone === "cancelled" && <Icon name="cancel" />}
          {row.statusTone === "no_show" && <Icon name="person_off" />}
          {row.statusTone === "seated" && <Icon name="directions_walk" />}
          {row.statusTone !== "cancelled" && row.statusTone !== "no_show" && row.statusTone !== "seated" && <i />}
          <span className="status-pill-label">{row.status}</span>
        </span>
      </td>
      <td>
        <div className="booking-note">
          {row.icon && <Icon name={row.icon} />}
          {row.tag && <em>{row.tag}</em>}
          <span>{row.note}</span>
        </div>
      </td>
      <td>
        <div className="row-actions">
          {canMarkNoShow && (
            <button
              type="button"
              aria-label={`Mark ${row.guest} as no-show`}
              title="Mark as no-show"
              disabled={row.pending}
              onClick={() => onMarkNoShow?.(row.id)}
            >
              <Icon name="person_off" />
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              aria-label={`Cancel ${row.guest}`}
              title="Cancel reservation"
              disabled={row.pending}
              onClick={() => onCancel?.(row.id)}
            >
              <Icon name="block" />
            </button>
          )}
          {canRestore && (
            <button
              type="button"
              aria-label={`Restore ${row.guest}`}
              title="Restore to confirmed"
              disabled={row.pending}
              onClick={() => onRestore?.(row.id)}
            >
              <Icon name="restore" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function BookingCardItem({ row }) {
  return (
    <li className={`booking-card ${row.muted ? "muted" : ""}`}>
      <div className="booking-card-row booking-card-row-top">
        <div className="booking-card-when">
          <strong>{row.dateLabel}</strong>
          <span>{row.timeLabel}</span>
          {row.ref && <span className="booking-card-ref">{row.ref}</span>}
        </div>
        <span className={`status-pill ${row.statusTone}`}>
          {row.statusTone === "cancelled" && <Icon name="cancel" />}
          {row.statusTone === "seated" && <Icon name="directions_walk" />}
          {row.statusTone !== "cancelled" && row.statusTone !== "seated" && <i />}
          {row.status}
        </span>
      </div>
      <div className="booking-card-row booking-card-guest">
        <strong>{row.guest}</strong>
        <span>{row.phone}</span>
      </div>
      <div className="booking-card-row booking-card-meta">
        <span className="booking-card-party">
          <Icon name="group" />
          Party of {row.party}
        </span>
        {row.tableLabel && (
          <span className="booking-card-table">
            <Icon name="table_restaurant" />
            {row.tableLabel}
            {row.tableZone && <em className={`zone-badge zone-${row.tableZone}`}>{row.tableZone}</em>}
          </span>
        )}
        {row.note && <span className="booking-card-note">{row.note}</span>}
      </div>
    </li>
  );
}
