import { Icon } from "../Icon";

/**
 * A single big figure. Renders as a button when `onClick` is given, so a number
 * an operator wants to act on takes them somewhere instead of just sitting
 * there — every headline figure in the admin used to be a dead end.
 *
 * `state` tints only the figure (warn/danger), never the whole tile, so a
 * dashboard with one problem doesn't read as an emergency.
 */
export function StatTile({ label, value, note, icon, state = "default", onClick, ariaLabel }) {
  const className = `adm-stat is-${state}`;
  const body = (
    <>
      <span className="adm-stat-label">
        {icon ? <Icon name={icon} /> : null}
        {label}
      </span>
      <span className="adm-stat-value">{value}</span>
      {note ? <span className="adm-stat-note">{note}</span> : null}
    </>
  );

  if (!onClick) {
    return <div className={className}>{body}</div>;
  }
  return (
    <button type="button" className={className} onClick={onClick} aria-label={ariaLabel}>
      {body}
    </button>
  );
}
