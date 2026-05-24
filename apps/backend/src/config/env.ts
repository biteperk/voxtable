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
    .transform((value) => value === "true")
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
  });

export const env = envSchema.parse(process.env);
