import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
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
    .default("11111111-1111-4111-8111-111111111111"),
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
});

export const env = envSchema.parse(process.env);
