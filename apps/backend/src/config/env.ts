import { existsSync } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

for (const envPath of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")]) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const LOCAL_DEFAULT_RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

// Feature flags and kill-switches: a "true"/"false" string that defaults to
// FALSE, so new scaffolding ships inert until someone deliberately turns it on.
const boolFlag = () =>
  z.enum(["true", "false"]).default("false").transform((value) => value === "true");

// Security gates: same shape, opposite default. An env file that forgets to
// mention one gets signature verification and dashboard auth, not an open API.
// Forgetting a feature flag costs a feature; forgetting a gate costs every
// tenant's data, so the two must not share a default.
const gateFlag = () =>
  z.enum(["true", "false"]).default("true").transform((value) => value === "true");

const envSchema = z
  .object({
  // No default. Which environment this is decides how the whole file behaves,
  // so it has to be stated, not assumed — the old default meant a .env that
  // never mentioned APP_ENV silently got the development ruleset.
  APP_ENV: z.enum(["development", "test", "production", "migration"], {
    required_error:
      "APP_ENV must be set explicitly (development | test | production | migration). " +
      "There is no default — see .env.example."
  }),
  APP_VERSION: z.string().default("0.1.0"),
  PORT: z.coerce.number().int().positive().default(3050),
  // The worker process runs its own health surface (/livez /readyz /workerz).
  // In Cloud Run api and worker are separate containers, so both listen on the
  // injected PORT (3050) with no conflict — leave this unset there. Locally
  // dev:backend and dev:worker share one host, so the worker must bind a
  // DIFFERENT port than the api's PORT or the second process EADDRINUSEs.
  // Unset → falls back to PORT (see worker.ts).
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().optional(),
  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:3050"),
  CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: boolFlag(),
  // Per-process pool ceilings. Both containers import db/pool at boot, so the
  // TOTAL across api + worker must stay under Postgres' usable connections
  // (default max_connections=100 minus 3 superuser-reserved = 97). Defaults:
  // api keeps 40+10 = 50; Dockerfile.worker overrides to 30+5 = 35 → 85
  // total, leaving headroom for migrations and a psql session.
  PG_POOL_MAX_WRITE: z.coerce.number().int().positive().default(40),
  PG_POOL_MAX_READ: z.coerce.number().int().positive().default(10),
  // Shows up in pg_stat_activity. The worker overrides this in its image so
  // "who is holding connections" is answerable during an incident.
  PG_APPLICATION_NAME: z.string().default("vocotable-api"),
  DEFAULT_RESTAURANT_ID: z
    .string()
    .uuid()
    .default(LOCAL_DEFAULT_RESTAURANT_ID),
  RETELL_API_KEY: z.string().optional(),
  // Retell signs webhooks (x-retell-signature) with the dedicated "Secret Key
  // (Webhook)" from the dashboard, NOT the REST API key. Keep them separate:
  // RETELL_API_KEY authenticates outbound REST calls; RETELL_WEBHOOK_SECRET
  // verifies inbound webhook signatures. Falls back to RETELL_API_KEY if unset
  // (older single-key accounts).
  RETELL_WEBHOOK_SECRET: z.string().optional(),
  RETELL_AGENT_ID: z.string().optional(),
  // The LLM behind the agent. Only needed so the retell-variables worker can
  // keep `today`/`tomorrow` fresh on the LLM's default_dynamic_variables — the
  // values Retell falls back to when a number uses a static inbound_agent_id
  // rather than our /retell/inbound webhook. Unset → the worker no-ops and the
  // variables must be refreshed by hand, which is how they went stale before.
  RETELL_LLM_ID: z.string().optional(),
  RETELL_PHONE_NUMBER: z.string().optional(),
  RETELL_VERIFY_SIGNATURE: gateFlag(),
  // The core product's kill switch. Every peripheral feature has a flag; until
  // now the one thing the business actually sells had none, so a misbehaving
  // agent or corrupted booking flow could only be stopped by pulling the phone
  // number at Retell. Default ON via gateFlag — a forgotten env var must never
  // silence the phone line — but deliberately NOT in superRefine's gate
  // enforcement: unlike the security gates, this one must stay legal to turn
  // OFF in production, or it isn't a kill switch. When off, every /retell tool
  // call returns a spoken refusal and writes nothing; webhooks and call
  // logging stay live.
  VOICE_BOOKING_ENABLED: gateFlag(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_TERMINATION_URI: z.string().optional(),
  TWILIO_RETELL_SIP_URI: z.string().default("sip:sip.retellai.com"),
  TWILIO_VALIDATE_SIGNATURE: gateFlag(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Deadline on verifyIdToken — the ONLY external call in the request path
  // with no timeout of its own. If Google's cert endpoint hangs, every
  // dashboard request hangs with it. Timeouts map to 503, never 401, so a
  // Google outage can't mass-sign-out the dashboard.
  FIREBASE_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Dashboard auth gate. Defaults ON. Turning it off is a local-development
  // convenience — it lets smoke scripts and curl probes skip minting a Firebase
  // ID token — and superRefine below refuses to boot with it off on any host
  // that isn't localhost.
  DASHBOARD_VERIFY_AUTH: gateFlag(),

  // Comma-separated list of email addresses allowed to hit the dashboard /
  // booking-mutation endpoints. Empty means "any verified Google account" —
  // dev-only. Production superRefine requires this to be non-empty.
  DASHBOARD_ALLOWED_EMAILS: z.string().optional(),

  // Manager-role allowlist (subset of DASHBOARD_ALLOWED_EMAILS). Gates menu
  // CRUD, payment status toggles, and order cancellation. Kitchen kiosk
  // account is intentionally NOT in this list.
  DASHBOARD_MANAGER_EMAILS: z.string().optional(),

  // Kitchen-kiosk allowlist (subset of DASHBOARD_ALLOWED_EMAILS). Grants the
  // 'kitchen' role to the KDS kiosk account(s) — both via the legacy fallback
  // (no membership row yet) and the seed backfill — so the kitchen display keeps
  // reading /api/orders/* after those endpoints became role-gated. Mirrors
  // DASHBOARD_MANAGER_EMAILS. Real 'kitchen' memberships (invite flow) override
  // this once they exist.
  DASHBOARD_KITCHEN_EMAILS: z.string().optional(),

  // Platform admin allowlist (VoxTable staff) — gates the cross-tenant
  // provisioning console (/api/admin/*). Distinct from per-restaurant roles.
  DASHBOARD_ADMIN_EMAILS: z.string().optional(),

  // MULTITENANCY_LEGACY_FALLBACK was removed on 2 Aug 2026 (migration 027).
  // It granted any allowlisted user with no restaurant_members row access to
  // DEFAULT_RESTAURANT_ID — a rollout bridge that stayed on for months and
  // acted as a second, unrecorded authorisation path. Access is now the
  // membership table and nothing else. Setting it in a .env is harmless; it is
  // simply ignored.

  // Cal.com hybrid integration — all optional in dev, conditionally required
  // in production when CALCOM_SYNC_ENABLED=true.
  CALCOM_SYNC_ENABLED: boolFlag(),
  CALCOM_API_KEY: z.string().optional(),
  CALCOM_EVENT_TYPE_ID: z.coerce.number().int().positive().optional(),
  CALCOM_BASE_URL: z.string().url().default("https://api.cal.com/v2"),
  CALCOM_WEBHOOK_SECRET: z.string().optional(),
  CALCOM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  CALCOM_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  // Audit Sweep I: per-day Cal.com API request threshold. When today's count
  // crosses this, healthAlerter fires a Slack ping. Default is 80% of free
  // tier (100k/mo ÷ 30 days × 0.8 ≈ 2666/day). Override when on a paid plan.
  CALCOM_DAILY_QUOTA_THRESHOLD: z.coerce.number().int().positive().optional(),

  // Operations alerting — Slack webhook for outbox depth + circuit breaker events.
  OPS_SLACK_WEBHOOK_URL: z.string().url().optional(),
  // Dead-man's switch: the health alerter GETs this URL (healthchecks.io
  // style) at the end of every tick. The external service alerts when pings
  // STOP — the one failure mode every in-process alert shares is "the worker
  // that would have alerted is dead", and until this existed every probe ran
  // on the same box it was probing.
  OPS_HEARTBEAT_URL: z.string().url().optional(),

  // Sentry — error tracking. No-op when unset; safe to ship the scaffolding
  // without a DSN. Not enforced in production yet (Phase 5 calls for it but
  // we're staging the rollout) — set it when the Sentry project exists.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // Stripe billing — read-only mirror of the restaurant's real invoices,
  // saved cards, and subscription, plus a Customer Portal redirect for card
  // management. Mirrors the CALCOM_SYNC_ENABLED kill-switch pattern: deploy
  // the scaffolding OFF (GETs return { enabled:false, … }), flip ON once keys
  // are verified. superRefine below forces keys when enabled in production.
  STRIPE_BILLING_ENABLED: boolFlag(),
  STRIPE_SECRET_KEY: z.string().optional(),
  // Legacy single-tenant fallback customer. With self-serve billing (Phase 3),
  // each restaurant gets its own customer (restaurants.stripe_customer_id); this
  // env is only a transition fallback for the original tenant.
  STRIPE_CUSTOMER_ID: z.string().optional(),
  STRIPE_PORTAL_RETURN_URL: z
    .string()
    .url()
    .default("https://vocotable.web.app/billing"),
  STRIPE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Self-serve subscription (Phase 3): the $80/mo recurring Price, the free
  // trial length, the webhook signing secret, and Checkout return URLs.
  STRIPE_PRICE_ID: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // THE trial length. Stripe reads this at checkout, and the onboarding wizard
  // reads it back from /api/onboarding/status, so the number a customer is
  // promised and the number they are granted are the same value by
  // construction. Before this, the landing page said 7 days, the wizard said
  // 14, and Stripe granted 14 — three answers to one question.
  //
  // Changing it affects NEW checkouts only: Stripe fixes the trial on the
  // subscription when it is created, so anyone mid-trial keeps what they were
  // promised.
  STRIPE_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  STRIPE_CHECKOUT_SUCCESS_URL: z
    .string()
    .url()
    .default("https://vocotable.web.app/onboarding"),
  STRIPE_CHECKOUT_CANCEL_URL: z
    .string()
    .url()
    .default("https://vocotable.web.app/onboarding"),

  // Menu OCR ingestion (Phase 2). Vision-LLM parses a menu photo/PDF into
  // structured categories/items/prices. Kill-switch pattern: ships OFF; the
  // worker is a no-op and /api/menu/ingest returns 503 until enabled. Prices
  // are parsed to integer cents (same money discipline as Stripe).
  MENU_OCR_ENABLED: boolFlag(),
  MENU_OCR_API_KEY: z.string().optional(),
  // Which vision API dialect to speak. "anthropic" = Anthropic Messages API;
  // "openai" = any OpenAI-compatible /chat/completions host (OpenRouter,
  // Together, Fireworks, DeepInfra, Gemini's OpenAI shim, local Ollama, …),
  // which is how open-weight VLMs (Qwen2.5-VL, Llama-3.2-Vision, Pixtral) are
  // served. Lets us run an open model without code changes — just env.
  MENU_OCR_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  // Base URL for the "openai" provider (ignored for anthropic). E.g.
  // https://openrouter.ai/api/v1 , https://api.together.xyz/v1 ,
  // https://generativelanguage.googleapis.com/v1beta/openai .
  MENU_OCR_BASE_URL: z.string().url().optional(),
  // Default model is Anthropic's; override per provider, e.g.
  // "qwen/qwen-2.5-vl-72b-instruct" (OpenRouter) or "gemini-2.0-flash".
  MENU_OCR_MODEL: z.string().default("claude-3-5-sonnet-latest"),
  MENU_OCR_MAX_FILE_MB: z.coerce.number().int().positive().default(10),
  MENU_OCR_MAX_JOBS_PER_DAY: z.coerce.number().int().positive().default(25),
  MENU_OCR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  // Model for the recovery pass — the single-page re-read of a page the first
  // pass got nothing from. Defaults to MENU_OCR_MODEL, but SHOULD be set to
  // something stronger in production: asking the same model the same question
  // twice is a correlated second opinion, and the whole value of this pass is
  // that it is independent of the one that just missed the page.
  MENU_OCR_VERIFY_MODEL: z.string().optional(),
  // Ceiling on recovery calls per job, so a menu that is genuinely 40 pages of
  // photographs can't fan out into 40 extra calls.
  MENU_OCR_MAX_VERIFY_PAGES: z.coerce.number().int().min(0).default(8),
  // Every model call for one job — first pass, halving retries and recovery
  // share this counter. 48 pages at 3 per batch is 16; the slack absorbs retries.
  MENU_OCR_MAX_CALLS_PER_JOB: z.coerce.number().int().positive().default(24),
  // Wall clock for one parse, checked before each call is dispatched. Must stay
  // under the frontend's 10-minute polling ceiling or the owner is watching a
  // spinner for work that is still running.
  MENU_OCR_JOB_BUDGET_MS: z.coerce.number().int().positive().default(420_000),

  // Hosts the menu importer is allowed to fetch from (comma-separated, exact
  // hostname match). The client uploads to Firebase Storage and hands us the
  // download URL, so this is normally just that host. It exists because
  // `source_url` is client-supplied and fetched server-side: without a pin,
  // anyone with an account could point it at cloud metadata or our own VPC.
  MENU_OCR_ALLOWED_HOSTS: z.string().default("firebasestorage.googleapis.com"),

  // Notifications (Phase 5). Email via SendGrid REST (no SDK dep — fetch), SMS
  // via the installed Twilio SDK. Kill-switch: ships OFF; the worker is a no-op
  // and notifications silently queue without sending until enabled.
  NOTIFICATIONS_ENABLED: boolFlag(),
  SENDGRID_API_KEY: z.string().optional(),
  NOTIFICATIONS_FROM_EMAIL: z.string().email().default("hello@biteperk.com.au"),
  NOTIFICATIONS_SMS_FROM: z.string().optional(),

  // Which transactional-email API the notification worker speaks. "zeptomail"
  // is Zoho's transactional service (AU data centre by default) — used for the
  // branded verification-code emails; "sendgrid" is the original path.
  EMAIL_PROVIDER: z.enum(["sendgrid", "zeptomail"]).default("sendgrid"),
  ZEPTOMAIL_TOKEN: z.string().optional(),
  ZEPTOMAIL_BASE_URL: z.string().url().default("https://api.zeptomail.com.au/v1.1"),

  // Hard cap on a single email send. The outbox drains sequentially under a
  // tick guard, so ONE hung connection stalls the whole queue — including the
  // signup verification codes that ride it, which stops new signups dead until
  // someone restarts the worker. fetch() has no default timeout, so this is the
  // only thing standing between a slow provider and that outage.
  NOTIFICATIONS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // Premium signup verification: a 6-digit code emailed via the notifications
  // outbox and typed on the verify screen (replaces Firebase's default
  // verification email, which lands in spam). Kill-switch pattern: ships OFF;
  // the /api/auth/verify-email/* routes 404 and the frontend falls back to the
  // Firebase link flow until enabled.
  EMAIL_VERIFICATION_CODE_ENABLED: boolFlag(),

  // Automated provisioning (Phase 4b). Kill-switch: ships OFF; the worker is a
  // no-op and provisioning stays admin-assisted (Phase 4a) until enabled.
  PROVISIONING_AUTO_ENABLED: boolFlag(),
  // Template Retell agent to clone per restaurant.
  RETELL_TEMPLATE_AGENT_ID: z.string().optional(),
  // Area code to prefer when buying AU numbers (e.g. "2" for Sydney).
  PROVISIONING_TWILIO_AREA_CODE: z.string().optional(),

  // Self-serve signup: lets a verified account that is NOT in
  // DASHBOARD_ALLOWED_EMAILS create a restaurant and enter the wizard (the
  // allowlist remains the gate while this is off, and stays authoritative for
  // admin routes regardless). Kill-switch pattern: ships OFF.
  SELF_SERVE_SIGNUP_ENABLED: boolFlag(),
  // VoxConcierge is contracted "when released" — the wizard only offers it
  // once this flag is on. VoxDrive is deliberately not a service value
  // anywhere: it is a concept and must never be sold.
  SERVICES_VOXCONCIERGE_ENABLED: boolFlag(),

  // Voice-order payments: Bella texts the caller a Stripe Checkout link for
  // their food order. Kill-switch pattern: ships OFF. IMPORTANT: this flag
  // gates link CREATION only (Retell tool + staff resend) — webhook
  // reconciliation and the expiry reaper deliberately ignore it, because links
  // already in guests' hands must keep settling after a flag-off.
  ORDER_PAYMENTS_ENABLED: boolFlag(),
  // Stripe Connect (destination charges to venue connected accounts). Order
  // payments require it; it can be on alone to let venues onboard early.
  STRIPE_CONNECT_ENABLED: boolFlag(),
  // Stripe rejects expires_at < 30 min out; min 35 keeps clock skew from
  // turning the floor into intermittent mid-call failures.
  ORDER_PAYMENT_EXPIRY_MINUTES: z.coerce.number().int().min(35).max(1440).default(45),
  // BitePerk's application fee on each guest payment: bps + flat, clamped in
  // code to never reach the transaction total.
  ORDER_PAYMENT_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(0),
  ORDER_PAYMENT_FEE_FLAT_CENTS: z.coerce.number().int().min(0).default(0),
  // Where Stripe sends the guest after paying/cancelling — the dashboard
  // frontend origin (serves /order/paid and /order/cancelled), NOT the API.
  PUBLIC_ORDER_RETURN_BASE_URL: z.string().url().optional()
  })
  .superRefine((value, ctx) => {
    const publicUrl = new URL(value.PUBLIC_API_BASE_URL);
    const isLocalhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(publicUrl.hostname);

    // ---- Checked in EVERY APP_ENV ------------------------------------------
    //
    // Everything below this block returns early unless APP_ENV=production, and
    // that block used to be the only thing forcing the security gates on. So a
    // deployed .env that said `APP_ENV=development` — one word — served every
    // tenant's reservations, call transcripts and customer phone numbers to
    // anonymous callers, with no log line, no alert, and /health still green.
    //
    // The gates are bound to the URL instead of to APP_ENV: if this process is
    // reachable at something other than localhost, they are not optional, and
    // no value of APP_ENV can make them optional.
    if (!isLocalhost) {
      const corsAllowedOrigins = (value.CORS_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
      if (corsAllowedOrigins.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ALLOWED_ORIGINS"],
          message:
            "CORS_ALLOWED_ORIGINS must list at least one browser origin " +
            "when PUBLIC_API_BASE_URL is not localhost."
        });
      }

      const gates = [
        ["RETELL_VERIFY_SIGNATURE", "Retell webhook signatures"],
        ["TWILIO_VALIDATE_SIGNATURE", "Twilio request signatures"],
        ["DASHBOARD_VERIFY_AUTH", "dashboard authentication"]
      ] as const;

      for (const [key, what] of gates) {
        if (!value[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              `${key} must be true when PUBLIC_API_BASE_URL is not localhost ` +
              `(it is ${value.PUBLIC_API_BASE_URL}). Turning off ${what} on a ` +
              `reachable host exposes every tenant's data to anonymous callers.`
          });
        }
      }

      // An empty allowlist means "any verified Google account", which on a
      // reachable host is the same breach one sign-up later.
      const allowlist = (value.DASHBOARD_ALLOWED_EMAILS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowlist.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DASHBOARD_ALLOWED_EMAILS"],
          message:
            "DASHBOARD_ALLOWED_EMAILS must list at least one email (comma-separated) " +
            "when PUBLIC_API_BASE_URL is not localhost — an empty list admits any " +
            "verified Google account."
        });
      }
    }

    // ---- Production-only from here -----------------------------------------
    if (value.APP_ENV !== "production") {
      return;
    }

    // Flag a field that must be present (or true) in production. `!value[key]`
    // covers both an undefined string and a false boolean flag uniformly.
    const requireInProd = (key: keyof typeof value, message: string): void => {
      if (!value[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      }
    };

    if (isLocalhost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_API_BASE_URL"],
        message: "Production PUBLIC_API_BASE_URL must be a public HTTPS URL."
      });
    }

    requireInProd("RETELL_API_KEY", "RETELL_API_KEY is required in production.");
    requireInProd("TWILIO_ACCOUNT_SID", "TWILIO_ACCOUNT_SID is required in production.");
    requireInProd("TWILIO_AUTH_TOKEN", "TWILIO_AUTH_TOKEN is required in production.");
    // RETELL_AGENT_ID and TWILIO_PHONE_NUMBER are deliberately NOT required:
    // they are per-restaurant data, not deployment config (review decision on
    // biteperk-cloud-platform PR #20). The authoritative values live on the
    // restaurants row (retell_agent_id, twilio_phone_number — written by
    // provisioning/bind), dialled-number routing reads only the database, and
    // every env read of these two is fallback-guarded. The env values remain
    // as optional single-tenant/dev fallbacks only.
    // The three signature/auth gates and the allowlist are enforced above for
    // every APP_ENV, keyed on the public URL rather than on this branch.

    // Cal.com integration — only enforce credential presence when the flag is on.
    // Lets us deploy the scaffolding to production with the flag OFF for one
    // observation window, then flip on with credentials ready.
    if (value.CALCOM_SYNC_ENABLED) {
      requireInProd("CALCOM_API_KEY", "CALCOM_API_KEY is required when CALCOM_SYNC_ENABLED=true.");
      requireInProd(
        "CALCOM_EVENT_TYPE_ID",
        "CALCOM_EVENT_TYPE_ID is required when CALCOM_SYNC_ENABLED=true."
      );
      requireInProd(
        "CALCOM_WEBHOOK_SECRET",
        "CALCOM_WEBHOOK_SECRET is required when CALCOM_SYNC_ENABLED=true " +
          "(used to verify Cal.com webhook HMAC signatures)."
      );
    }

    // Stripe billing — only enforce credential presence when the flag is on,
    // so the scaffolding can ship to production with the flag OFF for an
    // observation window, then flip on with keys ready (mirrors Cal.com).
    if (value.STRIPE_BILLING_ENABLED) {
      requireInProd("STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY is required when STRIPE_BILLING_ENABLED=true.");
      // Self-serve billing needs a Price to subscribe to and a webhook secret to
      // verify subscription events. Per-tenant customers are created on demand,
      // so STRIPE_CUSTOMER_ID is no longer required.
      requireInProd("STRIPE_PRICE_ID", "STRIPE_PRICE_ID is required when STRIPE_BILLING_ENABLED=true.");
      requireInProd(
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_WEBHOOK_SECRET is required when STRIPE_BILLING_ENABLED=true."
      );
    }

    if (value.ORDER_PAYMENTS_ENABLED) {
      requireInProd("STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY is required when ORDER_PAYMENTS_ENABLED=true.");
      requireInProd(
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_WEBHOOK_SECRET is required when ORDER_PAYMENTS_ENABLED=true."
      );
      // Links are delivered by SMS; a payments deployment without an SMS
      // sender silently strands every link in the outbox.
      requireInProd(
        "NOTIFICATIONS_SMS_FROM",
        "NOTIFICATIONS_SMS_FROM is required when ORDER_PAYMENTS_ENABLED=true (links go out by SMS)."
      );
      // Without this the success_url is literally "undefined/order/paid" and
      // Stripe rejects the session mid-phone-call.
      requireInProd(
        "PUBLIC_ORDER_RETURN_BASE_URL",
        "PUBLIC_ORDER_RETURN_BASE_URL is required when ORDER_PAYMENTS_ENABLED=true."
      );
      if (!value.NOTIFICATIONS_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["NOTIFICATIONS_ENABLED"],
          message: "NOTIFICATIONS_ENABLED must be true when ORDER_PAYMENTS_ENABLED=true (links go out via the notifications outbox)."
        });
      }
      if (!value.STRIPE_CONNECT_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["STRIPE_CONNECT_ENABLED"],
          message: "STRIPE_CONNECT_ENABLED must be true when ORDER_PAYMENTS_ENABLED=true (guest payments are Connect destination charges)."
        });
      }
    }

    if (value.MENU_OCR_ENABLED && !value.MENU_OCR_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MENU_OCR_API_KEY"],
        message: "MENU_OCR_API_KEY is required when MENU_OCR_ENABLED=true."
      });
    }

    // The OpenAI-compatible provider (open-weight VLM hosts) needs a base URL —
    // there's no single default endpoint the way Anthropic has one.
    if (value.MENU_OCR_ENABLED && value.MENU_OCR_PROVIDER === "openai" && !value.MENU_OCR_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MENU_OCR_BASE_URL"],
        message: "MENU_OCR_BASE_URL is required when MENU_OCR_PROVIDER=openai."
      });
    }

    // Notifications email provider — the worker can't send without the matching
    // credential. Only enforced when the outbox is actually draining.
    if (value.NOTIFICATIONS_ENABLED && value.EMAIL_PROVIDER === "sendgrid") {
      requireInProd(
        "SENDGRID_API_KEY",
        "SENDGRID_API_KEY is required when NOTIFICATIONS_ENABLED=true and EMAIL_PROVIDER=sendgrid."
      );
    }
    if (value.NOTIFICATIONS_ENABLED && value.EMAIL_PROVIDER === "zeptomail") {
      requireInProd(
        "ZEPTOMAIL_TOKEN",
        "ZEPTOMAIL_TOKEN is required when NOTIFICATIONS_ENABLED=true and EMAIL_PROVIDER=zeptomail."
      );
    }

    // Verification codes ride the notifications outbox — without the worker
    // draining it, signups would wait forever for an email that never sends.
    if (value.EMAIL_VERIFICATION_CODE_ENABLED) {
      requireInProd(
        "NOTIFICATIONS_ENABLED",
        "NOTIFICATIONS_ENABLED must be true when EMAIL_VERIFICATION_CODE_ENABLED=true " +
          "(verification codes are delivered via the notifications outbox)."
      );
    }

    if (value.PROVISIONING_AUTO_ENABLED && !value.RETELL_TEMPLATE_AGENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RETELL_TEMPLATE_AGENT_ID"],
        message: "RETELL_TEMPLATE_AGENT_ID is required when PROVISIONING_AUTO_ENABLED=true."
      });
    }
  });

// Every key the schema accepts — the .env.example drift test compares this
// list against the example file, so a new variable cannot ship undocumented.
export const ENV_SCHEMA_KEYS = Object.keys(envSchema.innerType().shape);

/**
 * Validate a raw environment without touching `process.env` or exiting. Exists
 * so the boot rules above can be tested — the module-level load below is the
 * one that actually runs in a server.
 */
export function validateEnv(raw: Record<string, unknown>) {
  return envSchema.safeParse(raw);
}

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (result.success) {
    return result.data;
  }
  // A Zod stack trace at boot is not a useful thing to page someone with at
  // 6am. Print the field, the problem, and stop.
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
    .join("\n");
  process.stderr.write(
    `Refusing to start: the environment is not safe to boot.\n${problems}\n`
  );
  process.exit(1);
}

export const env = loadEnv();
