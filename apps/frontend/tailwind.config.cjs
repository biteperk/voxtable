/** @type {import('tailwindcss').Config} */
module.exports = {
  content: {
    relative: true,
    files: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"]
  },
  theme: {
    extend: {
      // Mirror the CSS custom properties (single source of truth in styles.css :root).
      // Pointing at var() kills the hardcoded duplication — retint happens in one place.
      colors: {
        background: "var(--background)",
        surface: "var(--surface)",
        "surface-container": "var(--surface-container)",
        "surface-container-high": "var(--surface-container-high)",
        "surface-container-low": "var(--surface-container-low)",
        "surface-container-lowest": "var(--surface-container-lowest)",
        "on-surface": "var(--on-surface)",
        "on-surface-variant": "var(--on-surface-variant)",
        outline: "var(--outline)",
        "outline-variant": "var(--outline-variant)",
        primary: "var(--primary)",
        "primary-dim": "var(--primary-dim)",
        "on-primary": "var(--on-primary)",
        "primary-container": "var(--primary-container)",
        "on-primary-container": "var(--on-primary-container)",
        secondary: "var(--secondary)",
        "secondary-container": "var(--secondary-container)",
        "on-secondary-container": "var(--on-secondary-container)",
        tertiary: "var(--tertiary)",
        "tertiary-container": "var(--tertiary-container)",
        error: "var(--error)"
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"]
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        xl: "0.75rem"
      }
    }
  },
  plugins: []
};
