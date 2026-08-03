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
    // Fire-and-forget: the counter is DB-backed now (the alerter reads it
    // from the worker process), and the error response must not stall — or
    // fail — on an observability write.
    if (fromRetell && (error.statusCode === 401 || error.statusCode === 403)) {
      void recordRetellAuthFailure().catch((recordError) => {
        logger.warn({ evt: "retell_auth_failure_record_failed", error: (recordError as Error).message });
      });
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

    // Say WHICH field is wrong and why. This used to return a flat "Request
    // validation failed." with the real reason buried in `details`, so a client
    // filling in the agreement step saw only that sentence and had no way to
    // tell that (say) their ABN failed the ATO checksum — a dead end on a form
    // they cannot skip. Our schemas already carry good, specific messages;
    // there was no reason to withhold them from the dashboard when the Retell
    // path had been getting them all along.
    // `details` stays for programmatic per-field handling.
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: describeZodIssues(error),
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

/** `client_abn` → `ABN`, `client_legal_name` → `Client legal name`. */
function prettyFieldName(path: string): string {
  const leaf = path.split(".").pop() ?? path;
  const words = leaf.split("_");
  // Keep acronyms shouting — "Client abn" reads like a typo.
  const ACRONYMS = new Set(["abn", "id", "url", "sms", "pii", "api"]);
  return words
    .map((word, i) =>
      ACRONYMS.has(word) ? word.toUpperCase() : i === 0 ? word[0]?.toUpperCase() + word.slice(1) : word
    )
    .join(" ");
}

/**
 * Turn a validation failure into something a restaurant owner can act on.
 *
 * Distinct from humanizeZodIssues above, which is written in Bella's voice for
 * the phone agent ("I couldn't read that — ...") and lowercases everything,
 * mangling "ABN" into "abn". That register is wrong for a form.
 */
function describeZodIssues(error: ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.filter((p) => typeof p === "string").join(".");
    // Our schemas' custom messages are already written for people and name
    // their own field ("That ABN fails the ATO checksum — please re-check
    // it."). Only Zod's terse built-ins ("Required") need a field name
    // bolted on, so detect a real sentence and leave it alone.
    const isFullSentence = /^[A-Z]/.test(issue.message) && /[.!?]$/.test(issue.message);
    if (isFullSentence || !field) return issue.message;
    const label = prettyFieldName(field);
    // Don't stutter: "ABN must be 11 digits" already names its field, so
    // prefixing gives "Client ABN: ABN must be 11 digits".
    const namesItself = issue.message.toLowerCase().includes(label.toLowerCase().split(" ").pop() ?? "");
    return namesItself ? `${issue.message}.` : `${label}: ${issue.message}.`;
  });
  const more = error.issues.length - parts.length;
  return parts.join(" ") + (more > 0 ? ` (and ${more} more.)` : "");
}
