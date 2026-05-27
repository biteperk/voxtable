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
  OPS_SLACK_WEBHOOK_URL: z.string().url().optional()
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
  });

export const env = envSchema.parse(process.env);
