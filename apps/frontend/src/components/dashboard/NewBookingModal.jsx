import { useEffect, useRef, useState } from "react";
import { listAvailableTables } from "../../api";
import { Icon } from "../Icon";

// `today` is the VENUE's calendar day (YYYY-MM-DD) as reported by the API.
// The previous default, `new Date().toISOString().slice(0, 10)`, was the UTC
// date — before 10am in Sydney it opened the modal on yesterday.
function localYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function NewBookingModal({ onClose, onCreate, initialForm = null, today = null }) {
  const now = new Date();
  const todayYmd = today || localYmd(now);
  const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
  nextHour.setMinutes(0, 0, 0);
  const defaultTime = `${String(nextHour.getHours()).padStart(2, "0")}:${String(nextHour.getMinutes()).padStart(2, "0")}`;

  const [form, setForm] = useState({
    name: "",
    phone: "",
    partySize: 2,
    date: todayYmd,
    time: defaultTime,
    tableId: "",
    notes: "",
    ...(initialForm ?? {}),
  });
  // The table the host clicked on the floor plan. If it turns out not to be
  // free at this time we say so rather than silently booking a different one.
  const requestedTableId = initialForm?.tableId || null;
  const [requestedTableUnavailable, setRequestedTableUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [suggestedTimes, setSuggestedTimes] = useState([]);
  const [availableTables, setAvailableTables] = useState([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableError, setTableError] = useState(null);
  const availabilityRequestId = useRef(0);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  useEffect(() => {
    const partySize = Number(form.partySize);
    const canLoadTables =
      form.date &&
      form.time &&
      Number.isInteger(partySize) &&
      partySize >= 1 &&
      partySize <= 20;

    if (!canLoadTables) {
      setAvailableTables([]);
      setForm((prev) => (prev.tableId ? { ...prev, tableId: "" } : prev));
      return undefined;
    }

    const requestId = availabilityRequestId.current + 1;
    availabilityRequestId.current = requestId;
    setTablesLoading(true);
    setTableError(null);

    const timer = window.setTimeout(() => {
      listAvailableTables({
        date: form.date,
        time: form.time,
        partySize
      })
        .then((data) => {
          if (availabilityRequestId.current !== requestId) return;
          const tables = data.tables ?? [];
          setAvailableTables(tables);
          setForm((prev) => {
            if (tables.some((table) => table.id === prev.tableId)) {
              setRequestedTableUnavailable(false);
              return prev;
            }
            if (requestedTableId && prev.tableId === requestedTableId) {
              // Keep the host's choice visible but unselectable; they decide
              // whether to move the guest or change the time.
              setRequestedTableUnavailable(true);
              return { ...prev, tableId: "" };
            }
            return { ...prev, tableId: tables[0]?.id ?? "" };
          });
        })
        .catch((e) => {
          if (availabilityRequestId.current !== requestId) return;
          setAvailableTables([]);
          setTableError(e.message ?? "Could not load available tables.");
          setForm((prev) => (prev.tableId ? { ...prev, tableId: "" } : prev));
        })
        .finally(() => {
          if (availabilityRequestId.current === requestId) setTablesLoading(false);
        });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [form.date, form.time, form.partySize, requestedTableId]);

  const update = (field) => (event) => {
    if (typeof event.target.setCustomValidity === "function") {
      event.target.setCustomValidity("");
    }
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const englishValidity = (event) => {
    const el = event.target;
    if (el.validity.valueMissing) {
      el.setCustomValidity("Please fill out this field.");
    } else if (
      el.validity.typeMismatch ||
      el.validity.patternMismatch ||
      el.validity.rangeUnderflow ||
      el.validity.rangeOverflow
    ) {
      el.setCustomValidity("Please enter a valid value.");
    } else {
      el.setCustomValidity("");
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!form.tableId) {
      setError("Please choose an available table for this reservation.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuggestedTimes([]);
    try {
      await onCreate(form);
    } catch (e) {
      setError(e.message ?? "Could not save the booking. Please try again.");
      // Backend BOOKING_NOT_AVAILABLE attaches alternative slots — surface
      // them as one-click chips so the host doesn't have to guess.
      const alts = Array.isArray(e?.details?.suggestedTimes)
        ? e.details.suggestedTimes.filter((t) => t && t !== form.time)
        : [];
      setSuggestedTimes(alts);
      setSubmitting(false);
    }
  };

  const applySuggestedTime = (time) => {
    setForm((prev) => ({ ...prev, time, tableId: "" }));
    setError(null);
    setSuggestedTimes([]);
  };

  const selectedTable = availableTables.find((table) => table.id === form.tableId);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-booking-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="modal-card new-booking-modal">
        <header className="new-booking-head">
          <div>
            <h2 id="new-booking-title" className="modal-title">New booking</h2>
            <p className="modal-description">
              Capture a manual reservation — phone calls, walk-ins, host-stand entries.
            </p>
          </div>
          <button
            type="button"
            className="new-booking-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </header>

        <form className="new-booking-form" onSubmit={handleSubmit} autoComplete="off">
          {error ? (
            <div className="nb-error" role="alert">
              <Icon name="error_outline" />
              <div>
                <p>{error}</p>
                {suggestedTimes.length > 0 ? (
                  <div className="nb-suggested">
                    <span>Try one of these instead:</span>
                    <div className="nb-suggested-chips">
                      {suggestedTimes.map((t) => (
                        <button
                          key={t}
                          type="button"
                          className="nb-suggested-chip"
                          onClick={() => applySuggestedTime(t)}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <label className="nb-field">
            <span>Guest name</span>
            <input
              type="text"
              placeholder="e.g. Maria Rossi"
              value={form.name}
              onChange={update("name")}
              onInvalid={englishValidity}
              required
              lang="en"
            />
          </label>

          <label className="nb-field">
            <span>Phone number</span>
            <input
              type="tel"
              inputMode="tel"
              placeholder="+61 4XX XXX XXX"
              value={form.phone}
              onChange={update("phone")}
              onInvalid={englishValidity}
              required
              lang="en"
            />
          </label>

          <div className="nb-field-row">
            <label className="nb-field">
              <span>Date</span>
              <input
                type="date"
                value={form.date}
                onChange={update("date")}
                onInvalid={englishValidity}
                required
                lang="en"
              />
            </label>
            <label className="nb-field">
              <span>Time</span>
              <input
                type="time"
                value={form.time}
                onChange={update("time")}
                onInvalid={englishValidity}
                required
                lang="en"
              />
            </label>
            <label className="nb-field nb-field-narrow">
              <span>Party</span>
              <input
                type="number"
                min={1}
                max={20}
                value={form.partySize}
                onChange={update("partySize")}
                onInvalid={englishValidity}
                required
                lang="en"
              />
            </label>
          </div>

          <label className="nb-field">
            <span>Table</span>
            <select
              value={form.tableId}
              onChange={update("tableId")}
              onInvalid={englishValidity}
              required
              disabled={tablesLoading || availableTables.length === 0}
              lang="en"
            >
              {tablesLoading ? (
                <option value="">Checking available tables...</option>
              ) : availableTables.length === 0 ? (
                <option value="">No tables available for this time</option>
              ) : (
                availableTables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.label} · {table.minCapacity}-{table.maxCapacity} seats{table.zone ? ` · ${table.zone}` : ""}
                  </option>
                ))
              )}
            </select>
            {tableError ? (
              <em className="nb-table-hint error">{tableError}</em>
            ) : requestedTableUnavailable && !selectedTable ? (
              <em className="nb-table-hint error">
                {initialForm?.tableLabel ? `Table ${initialForm.tableLabel}` : "The table you clicked"} isn&apos;t free at {form.time} for {form.partySize} — pick another table or change the time.
              </em>
            ) : selectedTable ? (
              <em className="nb-table-hint">
                {(selectedTable.attributes ?? []).length > 0
                  ? selectedTable.attributes.join(", ")
                  : selectedTable.description || "Available for this slot"}
              </em>
            ) : (
              <em className="nb-table-hint">
                {tablesLoading ? "Looking at current reservations..." : "Adjust the time or party size to find a table."}
              </em>
            )}
          </label>

          <label className="nb-field">
            <span>Notes</span>
            <textarea
              rows={3}
              placeholder="Special requests, allergies, table preferences…"
              value={form.notes}
              onChange={update("notes")}
              lang="en"
            />
          </label>

          <div className="modal-actions">
            <button
              type="button"
              className="modal-button ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal-button confirm"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="modal-spinner" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save booking"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
