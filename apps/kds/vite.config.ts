import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "apps/kds",
  server: {
    host: "127.0.0.1",
    port: 3052,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
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
