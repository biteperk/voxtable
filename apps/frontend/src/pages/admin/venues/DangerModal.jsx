import { useEffect, useMemo, useRef, useState } from "react";

import { AdminAction } from "../../../components/admin/AdminAction";
import { Icon } from "../../../components/Icon";

const FIELD_LABEL = {
  twilio_phone_number: "Twilio number — the number guests dial",
  retell_phone_number: "Retell number",
  retell_agent_id: "Retell agent — the voice that answers",
  calcom_event_type_id: "Cal.com event type — online bookings"
};

/**
 * Disconnecting a venue's phone line, in a modal.
 *
 * It used to sit inline at the bottom of a long card, reachable by scrolling
 * past it, with its destructive button wearing the brand gold — the same colour
 * as "Save bindings". Three rules now hold: nothing destructive lives in the
 * normal flow, the consequence is stated in plain words with the live values
 * before anything else, and the button that does it is never the primary
 * colour.
 */
export function DangerModal({ prov, venueName, busy, onClose, onConfirm }) {
  const [fields, setFields] = useState([]);
  const [confirmName, setConfirmName] = useState("");
  const [ackLive, setAckLive] = useState(false);
  const dialogRef = useRef(null);
  const firstRef = useRef(null);

  const isLive = prov?.onboarding_status === "live";

  const available = useMemo(
    () =>
      [
        ["twilio_phone_number", prov?.twilio_phone_number],
        ["retell_phone_number", prov?.retell_phone_number],
        ["retell_agent_id", prov?.retell_agent_id],
        ["calcom_event_type_id", prov?.calcom_event_type_id]
      ].filter(([, value]) => value !== null && value !== undefined && value !== ""),
    [prov]
  );

  // Escape closes, and focus is trapped: this dialog can disconnect a live
  // venue, so it must not be possible to tab out of it and act on the page
  // behind.
  useEffect(() => {
    firstRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const toggleField = (name) =>
    setFields((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));

  const nameMatches = confirmName.trim() === venueName;
  const clearingNumber = fields.includes("twilio_phone_number") || fields.includes("retell_agent_id");

  // The consequence, in the venue's own values. Not a warning to skim.
  const consequence = clearingNumber
    ? prov?.twilio_phone_number
      ? `${prov.twilio_phone_number} will ring and no agent will answer.`
      : "The line will have no agent behind it."
    : fields.includes("calcom_event_type_id")
      ? "New online bookings will stop mirroring to Cal.com. The phone line is unaffected."
      : "Nothing is selected yet, so nothing will change.";

  const blocked =
    fields.length === 0
      ? "Tick at least one binding to clear."
      : !nameMatches
        ? `Type the venue's exact name — "${venueName}" — to confirm.`
        : isLive && !ackLive
          ? "Tick the acknowledgement: this venue is live and this disconnects its phone line."
          : null;

  return (
    <div className="adm-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="adm-modal is-danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="danger-title"
        ref={dialogRef}
      >
        <header className="adm-modal-head">
          <h3 id="danger-title">
            <Icon name="link_off" /> Disconnect this venue&apos;s phone line
          </h3>
          <button type="button" className="ghost-button" onClick={onClose} ref={firstRef} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <p className="adm-modal-consequence">{consequence}</p>
        {isLive ? (
          <p className="admin-muted">
            {venueName} is <strong>live</strong> right now. Guests calling after this will hear a
            ringing line and nothing else until a number and agent are bound again.
          </p>
        ) : (
          <p className="admin-muted">
            This venue is not live, so no guest is on the line. It can be re-bound at any time.
          </p>
        )}

        <fieldset className="adm-modal-fields">
          <legend>
            What to clear · {fields.length} of {available.length} selected
          </legend>
          {available.length === 0 ? (
            <p className="admin-muted">This venue has no bindings set, so there is nothing to clear.</p>
          ) : (
            available.map(([name, value]) => (
              <label key={name} className="adm-check">
                <input
                  type="checkbox"
                  checked={fields.includes(name)}
                  onChange={() => toggleField(name)}
                />
                <span>
                  <span className="adm-check-label">{FIELD_LABEL[name] ?? name.replace(/_/g, " ")}</span>
                  <code className="adm-check-value">{String(value)}</code>
                </span>
              </label>
            ))
          )}
          {/* Unset fields are stated, not offered as a checkbox for nothing. */}
          {available.length < 4 ? (
            <p className="admin-muted">
              Not set on this venue, so not listed:{" "}
              {Object.keys(FIELD_LABEL)
                .filter((k) => !available.some(([name]) => name === k))
                .map((k) => k.replace(/_/g, " "))
                .join(", ")}
              .
            </p>
          ) : null}
        </fieldset>

        <label className="admin-field">
          <span>Type the venue&apos;s exact name to confirm</span>
          <input
            className="admin-input"
            value={confirmName}
            placeholder={venueName}
            autoComplete="off"
            onChange={(e) => setConfirmName(e.target.value)}
            aria-describedby="danger-name-state"
          />
        </label>
        {/* Live feedback as you type, rather than a button that silently stays grey. */}
        <p id="danger-name-state" className={nameMatches ? "adm-match-ok" : "admin-muted"}>
          {confirmName.trim() === ""
            ? `Expecting "${venueName}".`
            : nameMatches
              ? "Name matches."
              : `Doesn't match "${venueName}" yet.`}
        </p>

        {isLive ? (
          <label className="adm-check">
            <input type="checkbox" checked={ackLive} onChange={(e) => setAckLive(e.target.checked)} />
            <span className="adm-check-label">
              I understand this disconnects a live venue&apos;s phone line.
            </span>
          </label>
        ) : null}

        <footer className="adm-modal-actions">
          <AdminAction onAct={onClose}>Cancel</AdminAction>
          <AdminAction
            tone="danger"
            icon="link_off"
            busy={busy}
            blocked={blocked}
            busyLabel="Disconnecting…"
            onAct={() => onConfirm({ fields, confirm_name: confirmName.trim(), acknowledge_live: ackLive })}
          >
            Disconnect this venue&apos;s phone line
          </AdminAction>
        </footer>
      </div>
    </div>
  );
}
