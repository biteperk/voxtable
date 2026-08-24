import { Icon } from "../../components/Icon";
import { STATUS_LABEL } from "../../data/products";

/**
 * A product the venue owns: a full card with its live figure and a way in.
 * A product they don't: quiet, smaller, plainly marked. The hierarchy is the
 * information — not a badge bolted onto two identical tiles.
 */

function figureFor(product, service) {
  for (const key of product.metricKeys) {
    if (service?.[key] !== undefined) {
      const value = service[key];
      const labels = {
        covers_booked: value === 1 ? "cover booked" : "covers booked",
        bookings_today: value === 1 ? "booking today" : "bookings today",
        orders_waiting: value === 1 ? "order waiting" : "orders waiting"
      };
      return { value, label: labels[key] ?? key.replace(/_/g, " ") };
    }
  }
  return null;
}

export function ProductTile({ product, service, owned, onOpen }) {
  const figure = owned ? figureFor(product, service) : null;
  const canOpen = Boolean(product.route);

  return (
    <article className={`product-tile${owned ? " is-owned" : ""}`}>
      <header className="product-tile-head">
        <Icon name={product.icon} className="product-tile-icon" />
        <h3 className="product-tile-name">{product.name}</h3>
        {!owned ? (
          <span className={`product-tile-status status-${product.status}`}>
            {STATUS_LABEL[product.status]}
          </span>
        ) : null}
      </header>

      <p className="product-tile-tagline">{product.tagline}</p>

      {figure ? (
        <p className="product-tile-figure">
          <span className="product-tile-figure-value">{figure.value}</span>
          <span className="product-tile-figure-label">{figure.label}</span>
        </p>
      ) : null}

      <div className="product-tile-actions">
        <button
          type="button"
          className={owned && canOpen ? "primary-button" : "ghost-button"}
          onClick={() => onOpen(product)}
        >
          {owned && canOpen ? `Open ${product.name}` : `About ${product.name}`}
        </button>
        {owned && product.secondary ? (
          <a
            className="product-tile-secondary"
            href={product.secondary.href}
            target="_blank"
            rel="noreferrer"
          >
            {product.secondary.label}
            {/* Different origin, so it asks for its own sign-in. Say so rather
                than letting the second login look like a bug. */}
            <span className="product-tile-secondary-note">signs in separately</span>
          </a>
        ) : null}
      </div>
    </article>
  );
}
