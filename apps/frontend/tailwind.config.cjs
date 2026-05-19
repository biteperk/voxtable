/** @type {import('tailwindcss').Config} */
module.exports = {
  content: {
    relative: true,
    files: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"]
  },
  theme: {
    extend: {
      colors: {
        background: "#131313",
        surface: "#131313",
        "surface-container": "#201f1f",
        "surface-container-high": "#2a2a2a",
        "surface-container-low": "#1c1b1b",
        "surface-container-lowest": "#0e0e0e",
        "on-surface": "#e5e2e1",
        "on-surface-variant": "#c1c6d7",
        outline: "#8b90a0",
        "outline-variant": "#414755",
        primary: "#adc6ff",
        "on-primary": "#002e69",
        "primary-container": "#4b8eff",
        "on-primary-container": "#00285c",
        secondary: "#d3fbff",
        "secondary-container": "#00eefc",
        "on-secondary-container": "#00686f",
        tertiary: "#ffb595",
        "tertiary-container": "#ef6719",
        error: "#ffb4ab"
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
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
