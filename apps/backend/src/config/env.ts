import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const LOCAL_DEFAULT_RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

// Every boolean env var is a "true"/"false" string that defaults to false and
// is coerced to a real boolean — kill-switches, signature gates, feature flags.
const boolFlag = () =>
  z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const envSchema = z
  .object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_VERSION: z.string().default("0.1.0"),
  PORT: z.coerce.number().int().positive().default(3050),
  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:3050"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: boolFlag(),
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
  RETELL_VERIFY_SIGNATURE: boolFlag(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_TERMINATION_URI: z.string().optional(),
  TWILIO_RETELL_SIP_URI: z.string().default("sip:sip.retellai.com"),
  TWILIO_VALIDATE_SIGNATURE: boolFlag(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // Dashboard auth gate. Defaults to OFF in dev so smoke scripts and local
  // curl probes work without minting a Firebase ID token (mirrors the
  // RETELL_VERIFY_SIGNATURE / TWILIO_VALIDATE_SIGNATURE pattern). Production
  // is forced ON by superRefine below.
  DASHBOARD_VERIFY_AUTH: boolFlag(),

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

  // Multi-tenancy rollout bridge. When true, an authenticated user with no
  // restaurant_members row but whose email is in DASHBOARD_ALLOWED_EMAILS is
  // granted access to DEFAULT_RESTAURANT_ID (role from DASHBOARD_MANAGER_EMAILS).
  // This keeps existing allowlisted users working between deploying the
  // multi-tenant code and running the membership backfill. Remove once the
  // backfill is verified. Mirrors the CALCOM_SYNC_ENABLED enum→bool pattern.
  MULTITENANCY_LEGACY_FALLBACK: boolFlag(),

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

  // Legal layer (agreement wizard step). The Client Services Agreement and
  // Privacy & Data Handling Schedule are published on biteperk.com.au; the app
  // records WHICH version (plus content hashes of the published pages) each
  // owner accepted. "DRAFT" is a sentinel meaning "no executed documents yet":
  // the agreement endpoint refuses it in production, and superRefine below
  // refuses to boot production with self-serve signup on while it stands.
  TERMS_DOCUMENT_SET_VERSION: z.string().trim().min(1).default("DRAFT"),
  // Interim URLs are the live site terms/privacy pages; switch to the
  // versioned CSA/Schedule URLs when the executed documents publish.
  TERMS_CSA_URL: z.string().url().default("https://biteperk.com.au/legal/terms/"),
  TERMS_SCHEDULE_URL: z.string().url().default("https://biteperk.com.au/legal/privacy/"),
  TERMS_CSA_SHA256: z.string().trim().optional(),
  TERMS_SCHEDULE_SHA256: z.string().trim().optional(),
  // Self-serve signup: lets a verified account that is NOT in
  // DASHBOARD_ALLOWED_EMAILS create a restaurant and enter the wizard (the
  // allowlist remains the gate while this is off, and stays authoritative for
  // admin routes regardless). Kill-switch pattern: ships OFF.
  SELF_SERVE_SIGNUP_ENABLED: boolFlag(),
  // VoxConcierge is contracted "when released" — the wizard only offers it
  // once this flag is on. VoxDrive is deliberately not a service value
  // anywhere: it is a concept and must never be sold.
  SERVICES_VOXCONCIERGE_ENABLED: boolFlag()
  })
  .superRefine((value, ctx) => {
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

    const publicUrl = new URL(value.PUBLIC_API_BASE_URL);

    if (["localhost", "127.0.0.1", "::1"].includes(publicUrl.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_API_BASE_URL"],
        message: "Production PUBLIC_API_BASE_URL must be a public HTTPS URL."
      });
    }

    requireInProd("RETELL_API_KEY", "RETELL_API_KEY is required in production.");
    requireInProd("RETELL_AGENT_ID", "RETELL_AGENT_ID is required in production.");
    requireInProd("RETELL_VERIFY_SIGNATURE", "RETELL_VERIFY_SIGNATURE must be true in production.");
    requireInProd("TWILIO_ACCOUNT_SID", "TWILIO_ACCOUNT_SID is required in production.");
    requireInProd("TWILIO_AUTH_TOKEN", "TWILIO_AUTH_TOKEN is required in production.");
    requireInProd("TWILIO_PHONE_NUMBER", "TWILIO_PHONE_NUMBER is required in production.");
    requireInProd("TWILIO_VALIDATE_SIGNATURE", "TWILIO_VALIDATE_SIGNATURE must be true in production.");
    requireInProd("DASHBOARD_VERIFY_AUTH", "DASHBOARD_VERIFY_AUTH must be true in production.");

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

    // Legal layer — self-serve signup must never run against DRAFT documents:
    // an acceptance recorded against "DRAFT" is evidence of nothing. The
    // content hashes pin the acceptance to the exact published bytes.
    if (value.SELF_SERVE_SIGNUP_ENABLED) {
      if (value.TERMS_DOCUMENT_SET_VERSION === "DRAFT") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TERMS_DOCUMENT_SET_VERSION"],
          message:
            "TERMS_DOCUMENT_SET_VERSION must name a published document set (not DRAFT) " +
            "when SELF_SERVE_SIGNUP_ENABLED=true."
        });
      }
      requireInProd(
        "TERMS_CSA_SHA256",
        "TERMS_CSA_SHA256 is required when SELF_SERVE_SIGNUP_ENABLED=true."
      );
      requireInProd(
        "TERMS_SCHEDULE_SHA256",
        "TERMS_SCHEDULE_SHA256 is required when SELF_SERVE_SIGNUP_ENABLED=true."
      );
    }
  });

export const env = envSchema.parse(process.env);
