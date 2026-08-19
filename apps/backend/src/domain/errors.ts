export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * A provisioning step that must NOT be retried. The worker marks the job failed
 * on sight instead of backing off, so a human reconciles it.
 *
 * Lives here rather than inside provisioningWorker because the services the
 * worker calls need to raise it too: a template whose prompt names a specific
 * venue, or a response engine with no LLM to clone, are misconfigurations that
 * six retries cannot fix — and retrying them creates Retell resources each time.
 */
export class PermanentProvisioningError extends Error {}

/**
 * An inbound Cal.com webhook that no number of retries can fix.
 *
 * The inbox worker dead-letters this on sight instead of backing off. It exists
 * because the two things are genuinely different: a booking we refused (no
 * table, a date in the past, a payload the schema rejects) will be refused
 * identically forever, while a booking that hit a lock wait or an exhausted
 * pool will very likely succeed on the next attempt.
 *
 * The distinction is load-bearing, not tidiness. When we refuse a booking we
 * also cancel it back on Cal.com so the guest is told — and a retry after that
 * would create a reservation for a booking the guest has already been told was
 * cancelled. Retrying a refusal is worse than not retrying it.
 */
export class PermanentInboxError extends Error {}
