import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    host: "127.0.0.1",
    port: 3051,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 3051,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
