import { Icon } from "../Icon";

// Payment-card brand badges (Visa / Mastercard / Amex) with a generic fallback.
export function CardBrandIcon({ brand }) {
  const b = (brand || "").toLowerCase();
  if (b === "visa") {
    return (
      <svg viewBox="0 0 40 24" className="card-brand-mark" aria-label="Visa">
        <rect width="40" height="24" rx="3" fill="#1a1f71" />
        <text
          x="20"
          y="16.5"
          textAnchor="middle"
          fontFamily="Arial Black, Arial, sans-serif"
          fontSize="11"
          fontWeight="900"
          fontStyle="italic"
          fill="#fff"
        >
          VISA
        </text>
      </svg>
    );
  }
  if (b === "mastercard") {
    return (
      <svg viewBox="0 0 40 24" className="card-brand-mark" aria-label="Mastercard">
        <rect width="40" height="24" rx="3" fill="#0a0a0a" />
        <circle cx="16" cy="12" r="6.5" fill="#eb001b" />
        <circle cx="24" cy="12" r="6.5" fill="#f79e1b" />
        <path
          d="M20 7.2a6.5 6.5 0 0 1 0 9.6 6.5 6.5 0 0 1 0-9.6z"
          fill="#ff5f00"
        />
      </svg>
    );
  }
  if (b === "amex" || b === "american express") {
    return (
      <svg viewBox="0 0 40 24" className="card-brand-mark" aria-label="American Express">
        <rect width="40" height="24" rx="3" fill="#2e77bb" />
        <text
          x="20"
          y="15.5"
          textAnchor="middle"
          fontFamily="Arial Black, Arial, sans-serif"
          fontSize="8.5"
          fontWeight="900"
          fill="#fff"
          letterSpacing="0.6"
        >
          AMEX
        </text>
      </svg>
    );
  }
  return (
    <div className="card-icon">
      <Icon name="credit_card" />
    </div>
  );
}
