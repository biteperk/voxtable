import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";

import { env } from "./config/env";
import { adminRouter } from "./routes/admin";
import { availabilityRouter } from "./routes/availability";
import { billingRouter } from "./routes/billing";
import { bookingsRouter } from "./routes/bookings";
import { calRouter } from "./routes/cal";
import { dashboardRouter } from "./routes/dashboard";
import { healthRouter } from "./routes/health";
import { meRouter } from "./routes/me";
import { menuRouter } from "./routes/menu";
import { onboardingRouter } from "./routes/onboarding";
import { ordersRouter } from "./routes/orders";
import { restaurantRouter } from "./routes/restaurant";
import { staffRouter } from "./routes/staff";
import { retellRouter } from "./routes/retell";
import { stripeWebhookRouter } from "./routes/stripeWebhook";
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
          ? [
              // Branded production URLs — canonical surface for customers.
              "https://vocotable.biteperk.com.au",
              "https://biteperk.com.au",
              // Kitchen Display System — separate Firebase Hosting target.
              "https://kitchen.vocotable.biteperk.com.au",
              "https://vocotable-kds.web.app",
              "https://vocotable-kds.firebaseapp.com",
              // Legacy / fallback Firebase Hosting URLs. Kept so existing
              // bookmarks and the .web.app default keep working without 401s.
              "https://vocotable.web.app",
              "https://vocotable.algorythmos.com.au"
            ]
          : true,
      // Setting allowedHeaders explicitly REPLACES cors's default reflection of
      // Access-Control-Request-Headers, so this list must be exhaustive: missing
      // If-Match / Idempotency-Key would silently break order mutations.
      // X-Restaurant-Id carries the active tenant for the multi-tenant dashboard.
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "If-Match",
        "Idempotency-Key",
        "X-Restaurant-Id"
      ]
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

  // Audit M5: app-level rate limit as a second line of defence behind nginx.
  // Skips webhook endpoints (HMAC-gated, legitimate retell/twilio bursts), the
  // health probe (load-balancer poll), and the root landing page. 120 req/min
  // per IP is generous enough that a logged-in dashboard polling at 5s won't
  // trip it, but caps abuse if someone discovers a reservation UUID and tries
  // to brute-cancel.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (request) => {
        const path = request.path;
        return (
          path === "/" ||
          path === "/health" ||
          path.startsWith("/retell/") ||
          path.startsWith("/twilio/") ||
          path.startsWith("/cal/") ||
          path.startsWith("/stripe/")
        );
      }
    })
  );

  app.use(healthRouter);
  app.use(availabilityRouter);
  app.use(bookingsRouter);
  app.use(retellRouter);
  app.use(twilioRouter);
  app.use(calRouter);
  app.use(menuRouter);
  app.use(ordersRouter);
  app.use(dashboardRouter);
  app.use(billingRouter);
  app.use(meRouter);
  app.use(onboardingRouter);
  app.use(restaurantRouter);
  app.use(staffRouter);
  app.use(adminRouter);
  app.use(stripeWebhookRouter);

  app.use(errorHandler);

  return app;
}
