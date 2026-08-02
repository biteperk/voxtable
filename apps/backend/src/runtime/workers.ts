import { installCalcomExecutor } from "../services/calcomService";
import { startOutboxWorker, stopOutboxWorker } from "../workers/calcomOutboxWorker";
import { startCleanupWorker, stopCleanupWorker } from "../workers/cleanupWorker";
import { startHealthAlerter, stopHealthAlerter } from "../workers/healthAlerter";
import { startMenuOcrWorker, stopMenuOcrWorker } from "../workers/menuOcrWorker";
import { startNotificationWorker, stopNotificationWorker } from "../workers/notificationWorker";
import { startProvisioningWorker, stopProvisioningWorker } from "../workers/provisioningWorker";
import {
  startRetellVariablesWorker,
  stopRetellVariablesWorker
} from "../workers/retellVariablesWorker";

export interface BackendWorker {
  name: string;
  start: () => void;
  stop: () => Promise<void>;
}

export const backendWorkers: BackendWorker[] = [
  { name: "calcom-outbox", start: startOutboxWorker, stop: stopOutboxWorker },
  { name: "health-alerter", start: startHealthAlerter, stop: stopHealthAlerter },
  { name: "cleanup", start: startCleanupWorker, stop: stopCleanupWorker },
  { name: "menu-ocr", start: startMenuOcrWorker, stop: stopMenuOcrWorker },
  { name: "notifications", start: startNotificationWorker, stop: stopNotificationWorker },
  { name: "provisioning", start: startProvisioningWorker, stop: stopProvisioningWorker },
  {
    name: "retell-variables",
    start: startRetellVariablesWorker,
    stop: stopRetellVariablesWorker
  }
];

interface StartBackendWorkersOptions {
  workers?: BackendWorker[];
  installCalcom?: () => void;
}

export function startBackendWorkers(options: StartBackendWorkersOptions = {}): void {
  const workers = options.workers ?? backendWorkers;
  const installCalcom = options.installCalcom ?? installCalcomExecutor;

  // The Cal.com outbox worker needs its real executor before the first tick.
  installCalcom();
  for (const worker of workers) {
    worker.start();
  }
}

interface StopBackendWorkersOptions {
  workers?: BackendWorker[];
  timeoutMs?: number;
  onStopFailure?: (worker: BackendWorker, reason: unknown) => void;
}

export async function stopBackendWorkers(options: StopBackendWorkersOptions = {}): Promise<void> {
  const workers = options.workers ?? backendWorkers;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const results = await Promise.allSettled(
    workers.map((worker) =>
      Promise.race([
        worker.stop(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("worker shutdown timeout")), timeoutMs)
        )
      ])
    )
  );

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      options.onStopFailure?.(workers[index]!, result.reason);
    }
  }
}
