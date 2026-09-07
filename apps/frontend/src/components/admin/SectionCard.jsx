import { Icon } from "../Icon";

/**
 * The one card. Every admin panel was assembling `onboarding-card admin-card`
 * by hand with its own heading markup, so no two panels had the same padding,
 * heading size or action placement.
 *
 * `tone="danger"` tints the card, which is how a destructive area announces
 * itself — rather than a destructive BUTTON wearing the primary colour, which
 * is what shipped.
 */
export function SectionCard({
  title,
  subtitle,
  icon,
  badge,
  actions,
  tone = "default",
  children,
  className = ""
}) {
  return (
    <section className={`adm-card${tone === "danger" ? " is-danger" : ""} ${className}`}>
      {title || actions || badge ? (
        <header className="adm-card-head">
          <div>
            <div className="adm-card-title">
              {icon ? <Icon name={icon} /> : null}
              {title ? <h3>{title}</h3> : null}
              {badge}
            </div>
            {subtitle ? <p className="adm-card-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="adm-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
