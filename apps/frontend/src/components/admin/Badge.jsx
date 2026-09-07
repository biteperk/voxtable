import { Icon } from "../Icon";

// State is named by MEANING, not by colour, and the word is always rendered —
// a pill must never carry its meaning in the colour alone. `ok` is the brand
// gold, which is why `danger` exists separately: a destructive or failing state
// must not be able to reach for the primary colour.
const TONE_ICON = {
  ok: "check_circle",
  info: "info",
  warn: "warning",
  danger: "error",
  neutral: null
};

export function Badge({ state = "neutral", icon, children, className = "" }) {
  const glyph = icon === undefined ? TONE_ICON[state] : icon;
  return (
    <span className={`adm-badge is-${state} ${className}`}>
      {glyph ? <Icon name={glyph} /> : null}
      {children}
    </span>
  );
}
