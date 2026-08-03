import assert from "node:assert/strict";
import test from "node:test";

import { installProcessGuards, resetProcessGuardsForTest } from "./processGuards";

type RejectionHandler = (reason: unknown, promise: Promise<unknown>) => void;
type ExceptionHandler = (error: Error, origin: string) => void;

/**
 * Install guards, hand the newly-registered handlers to `fn`, then remove
 * them. Handlers are invoked DIRECTLY rather than via `process.emit` — the
 * test runner has its own rejection bookkeeping, and firing a synthetic
 * event through it would fail the suite for the wrong reason.
 */
async function withInstalledGuards(
  exit: (code: number) => void,
  fn: (handlers: { rejection: RejectionHandler; exception: ExceptionHandler }) => Promise<void> | void
): Promise<void> {
  resetProcessGuardsForTest();
  const rejectionsBefore = process.listeners("unhandledRejection");
  const exceptionsBefore = process.listeners("uncaughtException");
  installProcessGuards("test-process", exit);
  const rejection = process
    .listeners("unhandledRejection")
    .find((l) => !rejectionsBefore.includes(l)) as RejectionHandler;
  const exception = process
    .listeners("uncaughtException")
    .find((l) => !exceptionsBefore.includes(l)) as ExceptionHandler;
  try {
    await fn({ rejection, exception });
  } finally {
    process.removeListener("unhandledRejection", rejection as never);
    process.removeListener("uncaughtException", exception as never);
    resetProcessGuardsForTest();
  }
}

/** Capture everything the logger writes to stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("unhandledRejection logs a structured line and does NOT exit", async () => {
  let exitedWith: number | null = null;
  await withInstalledGuards(
    (code) => {
      exitedWith = code;
    },
    async ({ rejection }) => {
      const lines = await captureStderr(() => {
        rejection(new Error("stray tick rejection"), Promise.resolve());
      });
      assert.equal(exitedWith, null, "a stray rejection must not kill the process");
      const parsed = JSON.parse(lines.at(-1)!);
      assert.equal(parsed.evt, "unhandled_rejection");
      assert.equal(parsed.process, "test-process");
      assert.equal(parsed.error.message, "stray tick rejection");
    }
  );
});

test("uncaughtException logs, then exits 1", async () => {
  let exitedWith: number | null = null;
  await withInstalledGuards(
    (code) => {
      exitedWith = code;
    },
    async ({ exception }) => {
      const lines = await captureStderr(() => {
        exception(new Error("sync throw"), "uncaughtException");
      });
      assert.equal(exitedWith, 1, "state is undefined after a sync throw — must exit");
      const parsed = JSON.parse(lines.at(-1)!);
      assert.equal(parsed.evt, "uncaught_exception");
      assert.equal(parsed.error.message, "sync throw");
    }
  );
});

test("installing twice registers only one set of handlers", () => {
  resetProcessGuardsForTest();
  const rejectionsBefore = process.listeners("unhandledRejection");
  const exceptionsBefore = process.listeners("uncaughtException");
  installProcessGuards("test-process");
  installProcessGuards("test-process");
  const addedRejections = process
    .listeners("unhandledRejection")
    .filter((l) => !rejectionsBefore.includes(l));
  const addedExceptions = process
    .listeners("uncaughtException")
    .filter((l) => !exceptionsBefore.includes(l));
  // Clean up before asserting so a failure can't leak handlers into other tests.
  for (const l of addedRejections) process.removeListener("unhandledRejection", l as never);
  for (const l of addedExceptions) process.removeListener("uncaughtException", l as never);
  resetProcessGuardsForTest();
  assert.equal(addedRejections.length, 1);
  assert.equal(addedExceptions.length, 1);
});
