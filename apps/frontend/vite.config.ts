import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error — plain JS module shared with the app and its unit tests.
import { missingFirebaseKeys } from "./src/lib/firebaseConfig.js";

/**
 * Fail the BUILD when Firebase config is missing, rather than shipping.
 *
 * Vite silently inlines `undefined` for an absent env var, so without this a
 * misconfigured CI run produces a green build and a deployed app where nobody
 * can sign in — with nothing anywhere to say why. CI builds the artifact that
 * gets deployed, so that mistake would reach customers.
 *
 * Dev and preview are left alone: running the UI without Firebase is a
 * legitimate thing to do while working on something unrelated, and the runtime
 * error in firebaseConfig.js is enough there.
 */
function requireFirebaseConfigForBuild(mode: string): Plugin {
  return {
    name: "require-firebase-config",
    apply: "build",
    configResolved(config) {
      const env = loadEnv(mode, config.envDir ?? process.cwd(), "VITE_");
      const missing = missingFirebaseKeys({ ...env, ...process.env });
      if (missing.length > 0) {
        throw new Error(
          `\n\nRefusing to build: Firebase is not configured.\n` +
            `Missing: ${missing.join(", ")}\n\n` +
            `Building without these produces a bundle where sign-in is broken for\n` +
            `everyone, with no error at build time. Set them as repo variables in\n` +
            `GitHub and in the CI build job, or in apps/frontend/.env.local locally.\n` +
            `See apps/frontend/.env.example.\n`
        );
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), requireFirebaseConfigForBuild(mode)],
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
}));
