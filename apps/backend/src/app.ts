import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { env } from "./config/env";
import { adminRouter } from "./routes/admin";
import { authVerificationRouter } from "./routes/authVerification";
import { availabilityRouter } from "./routes/availability";
import { billingRouter } from "./routes/billing";
import { bookingsRouter } from "./routes/bookings";
import { calRouter } from "./routes/cal";
import { dashboardRouter } from "./routes/dashboard";
import { healthRouter } from "./routes/health";
import { homeRouter } from "./routes/home";
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
import { logger } from "./utils/logger";

type RequestWithRawBody = express.Request & { rawBody?: string };

function corsOrigin() {
  const configured = env.CORS_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Unconfigured means local development only (env.ts refuses to boot on a
  // reachable host with an empty allowlist), so the fallback admits localhost
  // origins rather than reflecting whatever Origin the request carries.
  return configured?.length
    ? configured
    : [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];
}

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  // Security headers must come from the app, not the proxy: nginx only fronts
  // the VM, so Cloud Run revisions would otherwise serve with none at all.
  // Helmet defaults stand — the default CSP costs a JSON API nothing (browsers
  // only enforce it on documents) and covers any HTML error page express emits.
  app.use(helmet({ strictTransportSecurity: { maxAge: 31536000 } }));
  app.use(
    cors({
      origin: corsOrigin(),
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

  const isWebhookPath = (path: string): boolean =>
    path.startsWith("/retell/") ||
    path.startsWith("/twilio/") ||
    path.startsWith("/cal/") ||
    path.startsWith("/stripe/");

  // Webhook paths used to be exempt from rate limiting entirely, on the grounds
  // that they are HMAC-gated and burst legitimately. But the HMAC check runs
  // per request, so an unauthenticated caller could still spend our CPU and our
  // log volume without limit — and until the Cal.com verifier was fixed, each
  // one of those requests raised.
  //
  // So: a separate, much higher ceiling rather than no ceiling. 1200/min per IP
  // matches what nginx already allows these paths (20r/s), which makes this a
  // backstop for anything that reaches the app without going through nginx
  // rather than a new constraint on real provider traffic. If it ever does
  // trip, that is a genuine surprise, so say so loudly.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 1200,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (request) => !isWebhookPath(request.path),
      handler: (request, response) => {
        logger.warn({
          evt: "webhook_rate_limited",
          path: request.path,
          // A real provider tripping this means dropped bookings, so this line
          // is the difference between noticing and not.
          note: "webhook path exceeded 1200 req/min for this IP"
        });
        response.status(429).json({ error: "Too many requests." });
      }
    })
  );

  // Audit M5: app-level rate limit as a second line of defence behind nginx.
  // Skips the health probe (load-balancer poll), the root landing page, and the
  // webhook paths (handled by their own higher limit above). 120 req/min per IP
  // is generous enough that a logged-in dashboard polling at 5s won't trip it,
  // but caps abuse if someone discovers a reservation UUID and tries to
  // brute-cancel.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: (request) => {
        const path = request.path;
        return path === "/" || path === "/health" || isWebhookPath(path);
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
  app.use(homeRouter);
  app.use(meRouter);
  app.use(authVerificationRouter);
  app.use(onboardingRouter);
  app.use(restaurantRouter);
  app.use(staffRouter);
  app.use(adminRouter);
  app.use(stripeWebhookRouter);

  app.use(errorHandler);

  return app;
}
