import { useId, useState } from "react";

import { decideAction, isTrulyDisabled } from "../../lib/adminAction";
import { Icon } from "../Icon";

/**
 * A control acts, or it says why it cannot. It is never quietly grey.
 * The rule and its rationale live in lib/adminAction.js, where they are tested.
 */
export function AdminAction({
  children,
  onAct,
  blocked = null,
  busy = false,
  tone = "neutral",
  icon,
  busyLabel = "Working…",
  className = ""
}) {
  const [reason, setReason] = useState(null);
  // Unique per instance — a panel renders several of these, and a shared id
  // would point every button's aria-describedby at the same paragraph.
  const reasonId = useId();

  const toneClass =
    tone === "primary" ? "primary-button" : tone === "danger" ? "ghost-button adm-btn-danger" : "ghost-button";

  const handleClick = () => {
    const decision = decideAction({ busy, blocked });
    if (decision.kind === "explain") {
      setReason(decision.reason);
      return;
    }
    if (decision.kind === "act") {
      setReason(null);
      onAct?.();
    }
  };

  return (
    <>
      <button
        type="button"
        className={`${toneClass} ${className}`}
        onClick={handleClick}
        disabled={isTrulyDisabled({ busy })}
        aria-describedby={reason ? reasonId : undefined}
      >
        {icon ? <Icon name={icon} /> : null}
        {busy ? busyLabel : children}
      </button>
      {reason ? (
        <p className="adm-action-hint" id={reasonId} role="alert">
          <Icon name="info" />
          <span>{reason}</span>
        </p>
      ) : null}
    </>
  );
}
