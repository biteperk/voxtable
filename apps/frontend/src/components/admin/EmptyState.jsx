import { Icon } from "../Icon";

/**
 * An empty panel should say what the emptiness MEANS and, where there is one,
 * offer the thing that fills it. "Queue is empty." told an operator nothing
 * about whether that was good news.
 */
export function EmptyState({ icon = "inbox", title, children, action }) {
  return (
    <div className="adm-empty">
      <Icon name={icon} />
      {title ? <p className="adm-empty-title">{title}</p> : null}
      {children ? <p className="adm-empty-body">{children}</p> : null}
      {action}
    </div>
  );
}
