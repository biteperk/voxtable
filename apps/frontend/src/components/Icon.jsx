// Material Symbols icon wrapper. The static font styling lives inline so the
// component is drop-in anywhere without a CSS import.
export function Icon({ name, fill = false, className = "" }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{
        fontFamily: '"Material Symbols Outlined"',
        fontFeatureSettings: '"liga"',
        fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400`
      }}
    >
      {name}
    </span>
  );
}
