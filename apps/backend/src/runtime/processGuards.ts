/**
 * Last-resort process guards. Until now NOTHING in either container caught a
 * stray rejection: the server.ts comment claimed Sentry wired these hooks, but
 * initSentry() returns before calling Sentry.init when SENTRY_DSN is unset —
 * which is every environment today — and Node >= 15 exits on an unhandled
 * rejection. One promise chain missing a .catch anywhere in the worker took
 * all seven workers down with it.
 *
 * Policy:
 *   - unhandledRejection → log and keep running. The rejection escaped one
 *     task's chain; the process as a whole is still coherent, and killing the
 *     phone line over a background tick's slip is the outage we are guarding
 *     against. Each occurrence is a bug — the log line carries the stack so
 *     it gets fixed at the source (every tick chain also has its own .catch;
 *     this hook is the backstop, not the plan).
 *   - uncaughtException → log, then exit(1). A synchronous throw that reached
 *     the event loop leaves shared state undefined mid-operation; Node's docs
 *     are unambiguous that resuming is unsafe. The container runtime restarts
 *     us clean.
 */

import { logger } from "../utils/logger";
import { captureException } from "../utils/sentry";

let installed = false;

export function installProcessGuards(
  processName: string,
  // DI seam for tests — exiting the test runner is not an assertion.
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    logger.error({ evt: "unhandled_rejection", process: processName, error: reason });
    captureException(reason, { process: processName, hook: "unhandledRejection" });
  });

  process.on("uncaughtException", (error, origin) => {
    // logger.error writes synchronously to stderr, so the line is flushed
    // before exit even without a callback.
    logger.error({ evt: "uncaught_exception", process: processName, origin, error });
    captureException(error, { process: processName, hook: "uncaughtException" });
    exit(1);
  });
}

/** Test-only: allow a suite to install fresh guards after removing old ones. */
export function resetProcessGuardsForTest(): void {
  installed = false;
}
