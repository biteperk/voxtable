import { useId } from "react";

// Biteperk brand mark — the gold star with a green fork, matching
// biteperk.com.au (StarMark). Pure SVG. ids are made unique per render
// so multiple instances on one page (nav + footer) don't collide.
export function BiteperkMark({ size = 42 }) {
  const uid = useId().replace(/:/g, "");
  const grad = `bp-star-${uid}`;
  const shadow = `bp-shadow-${uid}`;
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={grad} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#fff7c4" />
          <stop offset="30%" stopColor="#f5c418" />
          <stop offset="100%" stopColor="#9a7a0a" />
        </radialGradient>
        <filter id={shadow} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity="0.4" />
        </filter>
      </defs>
      <g filter={`url(#${shadow})`}>
        <polygon
          points="32,4 39,24 60,24 43,37 49,58 32,46 15,58 21,37 4,24 25,24"
          fill={`url(#${grad})`}
          stroke="#1a4d1a"
          strokeWidth="1.2"
        />
        {/* Fork tines */}
        <rect x="29" y="20" width="2.5" height="22" fill="#1a4d1a" rx="0.8" />
        <rect x="32.5" y="20" width="2.5" height="14" fill="#1a4d1a" rx="0.8" />
        <rect x="35.5" y="20" width="2.5" height="22" fill="#1a4d1a" rx="0.8" />
      </g>
    </svg>
  );
}
