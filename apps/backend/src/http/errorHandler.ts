import { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { isAppError } from "../domain/errors";
import { recordRetellAuthFailure } from "../services/retellAuthHealth";
import { logger } from "../utils/logger";
import { captureException } from "../utils/sentry";

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const fromRetell = request.path?.startsWith("/retell/");
  const fromRetellTool = request.path?.startsWith("/retell/tools/");

  if (isAppError(error)) {
    // Observability: handled AppErrors used to return here WITHOUT a log line,
    // so a flood of Retell 401s (signature failures that silently drop every
    // booking) was invisible in stdout. Log them — PII-safe via `logger`, which
    // never serialises the body. 5xx is a real server fault → error level.
    const logFields = {
      evt: "handled_error",
      code: error.code,
      statusCode: error.statusCode,
      method: request.method,
      path: request.path
    };
    if (error.statusCode >= 500) {
      logger.error(logFields);
    } else {
      logger.warn(logFields);
    }

    // Recurrence guard: feed the Retell auth-failure counter so healthAlerter
    // can page when a wrong/stale RETELL_API_KEY starts 401ing the signed
    // surface. Covers tool calls, the inbound webhook, and the post-call hook.
    if (fromRetell && (error.statusCode === 401 || error.statusCode === 403)) {
      recordRetellAuthFailure();
    }

    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    });
    return;
  }

  if (error instanceof ZodError) {
    if (fromRetellTool) {
      // LLM-friendly: a single natural sentence rather than nested flatten().
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: humanizeZodIssues(error)
        }
      });
      return;
    }

    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: error.flatten()
      }
    });
    return;
  }

  // Audit Sweep D: NEVER spread the raw error. Some thrown errors (esp from
  // fetch / axios wrappers) carry `error.config.headers.Authorization` and
  // `error.request.body` — that's how the API key + PII used to land in logs.
  // logger.error sanitises down to name/message/code/status/short-stack only.
  logger.error({
    evt: "unhandled_error",
    method: request.method,
    path: request.path,
    error
  });
  // Sentry mirrors the log line. No-op until SENTRY_DSN is set.
  captureException(error, { method: request.method, path: request.path });
  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong."
    }
  });
};

function humanizeZodIssues(error: ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.filter((p) => typeof p === "string").join(".");
    if (!field) return issue.message;
    return `${field} ${issue.message.toLowerCase()}`;
  });
  return `I couldn't read that — ${parts.join("; ")}.`;
}
