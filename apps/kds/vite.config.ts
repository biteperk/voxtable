import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devHost = process.env.VITE_DEV_HOST ?? "0.0.0.0";

export default defineConfig({
  plugins: [react()],
  root: "apps/kds",
  server: {
    host: devHost,
    port: 3052,
    strictPort: true
  },
  preview: {
    host: devHost,
    port: 3052,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  esbuild: {
    // Drop console.log/debug from production bundles; kitchen kiosk should
    // never spew to a devtools panel that nobody is watching.
    drop: ["debugger"],
    pure: ["console.debug", "console.log"]
  }
});
