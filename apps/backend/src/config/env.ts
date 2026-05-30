import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const LOCAL_DEFAULT_RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

const envSchema = z
  .object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_VERSION: z.string().default("0.1.0"),
  PORT: z.coerce.number().int().positive().default(3050),
  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:3050"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
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
  RETELL_PHONE_NUMBER: z.string().optional(),
  RETELL_VERIFY_SIGNATURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_TERMINATION_URI: z.string().optional(),
  TWILIO_RETELL_SIP_URI: z.string().default("sip:sip.retellai.com"),
  TWILIO_VALIDATE_SIGNATURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  FIREBASE_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // Dashboard auth gate. Defaults to OFF in dev so smoke scripts and local
  // curl probes work without minting a Firebase ID token (mirrors the
  // RETELL_VERIFY_SIGNATURE / TWILIO_VALIDATE_SIGNATURE pattern). Production
  // is forced ON by superRefine below.
  DASHBOARD_VERIFY_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Comma-separated list of email addresses allowed to hit the dashboard /
  // booking-mutation endpoints. Empty means "any verified Google account" —
  // dev-only. Production superRefine requires this to be non-empty.
  DASHBOARD_ALLOWED_EMAILS: z.string().optional(),

  // Manager-role allowlist (subset of DASHBOARD_ALLOWED_EMAILS). Gates menu
  // CRUD, payment status toggles, and order cancellation. Kitchen kiosk
  // account is intentionally NOT in this list.
  DASHBOARD_MANAGER_EMAILS: z.string().optional(),

  // Platform admin allowlist (VocoTable staff) — gates the cross-tenant
  // provisioning console (/api/admin/*). Distinct from per-restaurant roles.
  DASHBOARD_ADMIN_EMAILS: z.string().optional(),

  // Multi-tenancy rollout bridge. When true, an authenticated user with no
  // restaurant_members row but whose email is in DASHBOARD_ALLOWED_EMAILS is
  // granted access to DEFAULT_RESTAURANT_ID (role from DASHBOARD_MANAGER_EMAILS).
  // This keeps existing allowlisted users working between deploying the
  // multi-tenant code and running the membership backfill. Remove once the
  // backfill is verified. Mirrors the CALCOM_SYNC_ENABLED enum→bool pattern.
  MULTITENANCY_LEGACY_FALLBACK: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Cal.com hybrid integration — all optional in dev, conditionally required
  // in production when CALCOM_SYNC_ENABLED=true.
  CALCOM_SYNC_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
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
  STRIPE_BILLING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
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
  // Self-serve subscription (Phase 3): the $80/mo recurring Price, a 14-day
  // free trial, the webhook signing secret, and Checkout return URLs.
  STRIPE_PRICE_ID: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),
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
  MENU_OCR_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MENU_OCR_API_KEY: z.string().optional(),
  MENU_OCR_MODEL: z.string().default("claude-3-5-sonnet-latest"),
  MENU_OCR_MAX_FILE_MB: z.coerce.number().int().positive().default(10),
  MENU_OCR_MAX_JOBS_PER_DAY: z.coerce.number().int().positive().default(25),
  MENU_OCR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  // Notifications (Phase 5). Email via SendGrid REST (no SDK dep — fetch), SMS
  // via the installed Twilio SDK. Kill-switch: ships OFF; the worker is a no-op
  // and notifications silently queue without sending until enabled.
  NOTIFICATIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SENDGRID_API_KEY: z.string().optional(),
  NOTIFICATIONS_FROM_EMAIL: z.string().email().default("hello@biteperk.com.au"),
  NOTIFICATIONS_SMS_FROM: z.string().optional(),

  // Automated provisioning (Phase 4b). Kill-switch: ships OFF; the worker is a
  // no-op and provisioning stays admin-assisted (Phase 4a) until enabled.
  PROVISIONING_AUTO_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Template Retell agent to clone per restaurant.
  RETELL_TEMPLATE_AGENT_ID: z.string().optional(),
  // Area code to prefer when buying AU numbers (e.g. "2" for Sydney).
  PROVISIONING_TWILIO_AREA_CODE: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (value.APP_ENV !== "production") {
      return;
    }

    const publicUrl = new URL(value.PUBLIC_API_BASE_URL);

    if (["localhost", "127.0.0.1", "::1"].includes(publicUrl.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_API_BASE_URL"],
        message: "Production PUBLIC_API_BASE_URL must be a public HTTPS URL."
      });
    }

    if (!value.RETELL_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RETELL_API_KEY"],
        message: "RETELL_API_KEY is required in production."
      });
    }

    if (!value.RETELL_AGENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RETELL_AGENT_ID"],
        message: "RETELL_AGENT_ID is required in production."
      });
    }

    if (!value.RETELL_VERIFY_SIGNATURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RETELL_VERIFY_SIGNATURE"],
        message: "RETELL_VERIFY_SIGNATURE must be true in production."
      });
    }

    if (!value.TWILIO_ACCOUNT_SID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_ACCOUNT_SID"],
        message: "TWILIO_ACCOUNT_SID is required in production."
      });
    }

    if (!value.TWILIO_AUTH_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_AUTH_TOKEN"],
        message: "TWILIO_AUTH_TOKEN is required in production."
      });
    }

    if (!value.TWILIO_PHONE_NUMBER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_PHONE_NUMBER"],
        message: "TWILIO_PHONE_NUMBER is required in production."
      });
    }

    if (!value.TWILIO_VALIDATE_SIGNATURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_VALIDATE_SIGNATURE"],
        message: "TWILIO_VALIDATE_SIGNATURE must be true in production."
      });
    }

    if (!value.DASHBOARD_VERIFY_AUTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DASHBOARD_VERIFY_AUTH"],
        message: "DASHBOARD_VERIFY_AUTH must be true in production."
      });
    }

    const allowlist = (value.DASHBOARD_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowlist.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DASHBOARD_ALLOWED_EMAILS"],
        message:
          "DASHBOARD_ALLOWED_EMAILS must list at least one email in production (comma-separated)."
      });
    }

    // Cal.com integration — only enforce credential presence when the flag is on.
    // Lets us deploy the scaffolding to production with the flag OFF for one
    // observation window, then flip on with credentials ready.
    if (value.CALCOM_SYNC_ENABLED) {
      if (!value.CALCOM_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CALCOM_API_KEY"],
          message: "CALCOM_API_KEY is required when CALCOM_SYNC_ENABLED=true."
        });
      }
      if (!value.CALCOM_EVENT_TYPE_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CALCOM_EVENT_TYPE_ID"],
          message: "CALCOM_EVENT_TYPE_ID is required when CALCOM_SYNC_ENABLED=true."
        });
      }
      if (!value.CALCOM_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CALCOM_WEBHOOK_SECRET"],
          message:
            "CALCOM_WEBHOOK_SECRET is required when CALCOM_SYNC_ENABLED=true " +
            "(used to verify Cal.com webhook HMAC signatures)."
        });
      }
    }

    // Stripe billing — only enforce credential presence when the flag is on,
    // so the scaffolding can ship to production with the flag OFF for an
    // observation window, then flip on with keys ready (mirrors Cal.com).
    if (value.STRIPE_BILLING_ENABLED) {
      if (!value.STRIPE_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["STRIPE_SECRET_KEY"],
          message: "STRIPE_SECRET_KEY is required when STRIPE_BILLING_ENABLED=true."
        });
      }
      // Self-serve billing needs a Price to subscribe to and a webhook secret to
      // verify subscription events. Per-tenant customers are created on demand,
      // so STRIPE_CUSTOMER_ID is no longer required.
      if (!value.STRIPE_PRICE_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["STRIPE_PRICE_ID"],
          message: "STRIPE_PRICE_ID is required when STRIPE_BILLING_ENABLED=true."
        });
      }
      if (!value.STRIPE_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["STRIPE_WEBHOOK_SECRET"],
          message: "STRIPE_WEBHOOK_SECRET is required when STRIPE_BILLING_ENABLED=true."
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

    if (value.PROVISIONING_AUTO_ENABLED && !value.RETELL_TEMPLATE_AGENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RETELL_TEMPLATE_AGENT_ID"],
        message: "RETELL_TEMPLATE_AGENT_ID is required when PROVISIONING_AUTO_ENABLED=true."
      });
    }
  });

export const env = envSchema.parse(process.env);
