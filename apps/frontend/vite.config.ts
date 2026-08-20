import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error — plain JS module shared with the app and its unit tests.
import { missingFirebaseKeys } from "./src/lib/firebaseConfig.js";
// @ts-expect-error — plain JS module shared with the app and its unit tests.
import { missingLegalDocumentKeys } from "./src/lib/legalDocuments.js";

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
function requireFrontendConfigForBuild(mode: string): Plugin {
  return {
    name: "require-frontend-config",
    apply: "build",
    configResolved(config) {
      const env = loadEnv(mode, config.envDir ?? process.cwd(), "VITE_");
      const buildEnv = { ...env, ...process.env };
      const missing = [
        ...missingFirebaseKeys(buildEnv),
        ...missingLegalDocumentKeys(buildEnv)
      ];
      if (missing.length > 0) {
        throw new Error(
          `\n\nRefusing to build: frontend config is incomplete.\n` +
            `Missing: ${missing.join(", ")}\n\n` +
            `Building without these produces a bundle where sign-in or legal-document\n` +
            `acceptance is broken. Set them as GitHub Environment variables and in\n` +
            `the CI build job, or in apps/frontend/.env.local locally.\n` +
            `See apps/frontend/.env.example.\n`
        );
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), requireFrontendConfigForBuild(mode)],
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
