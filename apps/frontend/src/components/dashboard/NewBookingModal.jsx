import { useEffect, useState } from "react";
import { Icon } from "../Icon";

export function NewBookingModal({ onClose, onCreate }) {
  const now = new Date();
  const todayYmd = now.toISOString().slice(0, 10);
  const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
  nextHour.setMinutes(0, 0, 0);
  const defaultTime = `${String(nextHour.getHours()).padStart(2, "0")}:${String(nextHour.getMinutes()).padStart(2, "0")}`;

  const [form, setForm] = useState({
    name: "",
    phone: "",
    partySize: 2,
    date: todayYmd,
    time: defaultTime,
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [suggestedTimes, setSuggestedTimes] = useState([]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

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
    setForm((prev) => ({ ...prev, time }));
    setError(null);
    setSuggestedTimes([]);
  };

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
