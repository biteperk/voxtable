import assert from "node:assert/strict";
import test from "node:test";

import { startBackendWorkers, stopBackendWorkers, type BackendWorker } from "./workers";

test("startBackendWorkers installs Cal.com executor before starting workers", () => {
  const events: string[] = [];
  const workers: BackendWorker[] = [
    { name: "one", start: () => events.push("start:one"), stop: async () => {} },
    { name: "two", start: () => events.push("start:two"), stop: async () => {} }
  ];

  startBackendWorkers({
    workers,
    installCalcom: () => events.push("install-calcom")
  });

  assert.deepEqual(events, ["install-calcom", "start:one", "start:two"]);
});

test("stopBackendWorkers stops all workers and reports failures", async () => {
  const stopped: string[] = [];
  const failures: string[] = [];
  const workers: BackendWorker[] = [
    {
      name: "one",
      start: () => {},
      stop: async () => {
        stopped.push("one");
      }
    },
    {
      name: "two",
      start: () => {},
      stop: async () => {
        stopped.push("two");
        throw new Error("boom");
      }
    },
    {
      name: "three",
      start: () => {},
      stop: async () => {
        stopped.push("three");
      }
    }
  ];

  await stopBackendWorkers({
    workers,
    timeoutMs: 100,
    onStopFailure: (worker, reason) => {
      failures.push(`${worker.name}:${(reason as Error).message}`);
    }
  });

  assert.deepEqual(stopped.sort(), ["one", "three", "two"]);
  assert.deepEqual(failures, ["two:boom"]);
});
