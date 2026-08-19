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
