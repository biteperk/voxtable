import { Icon } from "./Icon";

// On-brand confirmation for destructive actions — replaces the browser's
// native confirm()/prompt(), which are unstyled, unlocalisable, and can be
// suppressed entirely in kiosk/embedded webviews (the kitchen tablet being the
// screen most likely to run in one). Same shell as the ProfilePage staff
// modal; `children` slots an optional extra field (e.g. a cancellation reason).
export function ConfirmModal({ title, message, confirmLabel, busy, onConfirm, onCancel, children }) {
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
      <div className="modal-card new-booking-modal staff-confirm-modal">
        <header className="new-booking-head">
          <div>
            <h2 id="confirm-modal-title" className="modal-title">{title}</h2>
            <p className="modal-description">{message}</p>
          </div>
          <button
            type="button"
            className="new-booking-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
        <div className="modal-actions">
          <button type="button" className="modal-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="modal-button danger" onClick={onConfirm} disabled={busy}>
            {busy ? (
              <>
                <span className="modal-spinner" aria-hidden="true" />
                Working…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
