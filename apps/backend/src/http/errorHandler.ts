import { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { isAppError } from "../domain/errors";

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const fromRetellTool = request.path?.startsWith("/retell/tools/");

  if (isAppError(error)) {
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

  console.error(error);
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
