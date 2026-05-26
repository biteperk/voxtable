import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";

import { logger, withLogContext } from "../utils/logger";

/**
 * Per-request middleware:
 *   1. Generates a UUID request_id and pins it to AsyncLocalStorage so any
 *      logger.* call inside this request's handler chain auto-attaches it.
 *   2. Emits one structured access-log line on response finish — method,
 *      path, status, duration. NEVER includes request body / query string
 *      (those can carry PII for /retell/tools/* and /availability/check).
 */
export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const request_id = randomUUID();

  // Expose the id to downstream so clients can correlate across systems.
  response.setHeader("x-request-id", request_id);

  withLogContext({ request_id }, () => {
    response.on("finish", () => {
      logger.info({
        evt: "http_request",
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt
      });
    });
    next();
  });
}
