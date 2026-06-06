// Biteperk logo mark (gradient strokes + glossy orange dot). Pure SVG.
export function BiteperkMark({ size = 42 }) {
  return (
    <svg
      viewBox="-160 -200 320 380"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="lp-mk" x1="18%" y1="0%" x2="60%" y2="100%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="46%" stopColor="#e2e7f1" />
          <stop offset="100%" stopColor="#919bac" />
        </linearGradient>
        <radialGradient id="lp-ok" cx="35%" cy="26%" r="86%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="20%" stopColor="#fdeede" />
          <stop offset="54%" stopColor="#ff9d3c" />
          <stop offset="100%" stopColor="#9a5a16" />
        </radialGradient>
        <filter id="lp-fk" x="-80%" y="-80%" width="260%" height="260%">
          <feDropShadow dx="0" dy="9" stdDeviation="18" floodColor="#000" floodOpacity="0.4" />
        </filter>
      </defs>
      <g filter="url(#lp-fk)">
        <path d="M -118 -130 L 4 88" stroke="url(#lp-mk)" strokeWidth="100" strokeLinecap="round" fill="none" />
        <path d="M 118 -130 L -4 88" stroke="url(#lp-mk)" strokeWidth="100" strokeLinecap="round" fill="none" />
      </g>
      <circle cx="0" cy="70" r="66" fill="url(#lp-ok)" filter="url(#lp-fk)" />
      <ellipse cx="-20" cy="44" rx="15" ry="9" fill="#fff" opacity="0.6" />
    </svg>
  );
}
