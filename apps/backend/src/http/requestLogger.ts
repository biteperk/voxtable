import { NextFunction, Request, Response } from "express";

export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const startedAt = Date.now();

  response.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs
      })
    );
  });

  next();
}
