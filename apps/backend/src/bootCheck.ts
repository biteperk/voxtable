/**
 * Proves the COMPILED image can actually load and run its own code.
 *
 * Exists because of 1 Aug 2026: a green CI shipped images whose every process
 * died on line one with "exports is not defined in ES module scope" — a
 * package.json "type": "module" telling Node to run tsc's CommonJS output as
 * ESM. Unit tests (tsx), the compile (tsc) and the image build all passed,
 * because none of them ever EXECUTED a file out of dist/. Production found out
 * first: both containers crash-looped and the API 502'd during Friday service.
 *
 * CI now runs this file inside the freshly built image. It imports the same
 * module graph the real entrypoints use — express app, worker registry, env,
 * schema fixtures — without listening on a port or touching the database, so
 * it needs nothing but two dummy env vars. If the module system, a dependency,
 * or the compiled output is broken, this exits non-zero and the image never
 * ships.
 */
import { createApp } from "./app";
import { startBackendWorkers } from "./runtime/workers";
import { verifyCalcomSchemasAgainstFixtures } from "./services/calcomSchemas";

// The same fail-loud fixture check the real entrypoints run at startup.
verifyCalcomSchemasAgainstFixtures();

// Building the express app exercises every route module and middleware import.
// No .listen() — construction only.
const app = createApp();
if (!app || typeof app.use !== "function") {
  throw new Error("createApp() did not return an express app");
}

// Referenced, not called — importing the registry is what proves the worker
// module graph compiles and loads; calling it would start timers.
if (typeof startBackendWorkers !== "function") {
  throw new Error("worker registry failed to load");
}

console.log("[boot-check] ok — compiled output loads, module graph resolves");
process.exit(0);
