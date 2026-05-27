import cors from "cors";
import express from "express";

import { env } from "./config/env";
import { availabilityRouter } from "./routes/availability";
import { bookingsRouter } from "./routes/bookings";
import { calRouter } from "./routes/cal";
import { dashboardRouter } from "./routes/dashboard";
import { healthRouter } from "./routes/health";
import { retellRouter } from "./routes/retell";
import { twilioRouter } from "./routes/twilio";
import { errorHandler } from "./http/errorHandler";
import { requestLogger } from "./http/requestLogger";

type RequestWithRawBody = express.Request & { rawBody?: string };

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    cors({
      origin:
        env.APP_ENV === "production"
          ? ["https://vocotable.algorythmos.com.au", "https://vocotable.web.app"]
          : true
    })
  );
  // Limit bumped from 1mb → 2mb to accommodate Retell `call_analyzed` payloads
  // that ship full transcripts inline. Express default is 100kb which silently
  // 413s longer calls. Cap stays conservative to limit blast radius if a buggy
  // upstream tries to stream binary at us.
  app.use(
    express.json({
      limit: "2mb",
      verify: (request, _response, buffer) => {
        (request as RequestWithRawBody).rawBody = buffer.toString("utf8");
      }
    })
  );
  app.use(
    express.urlencoded({
      extended: false,
      limit: "2mb",
      verify: (request, _response, buffer) => {
        (request as RequestWithRawBody).rawBody = buffer.toString("utf8");
      }
    })
  );
  app.use(requestLogger);

  app.use(healthRouter);
  app.use(availabilityRouter);
  app.use(bookingsRouter);
  app.use(retellRouter);
  app.use(twilioRouter);
  app.use(calRouter);
  app.use(dashboardRouter);

  app.use(errorHandler);

  return app;
}
