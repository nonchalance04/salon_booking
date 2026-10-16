import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.enum(["127.0.0.1", "0.0.0.0", "::1", "::"]).default("127.0.0.1"),
  DATABASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return ["postgresql:", "postgres:"].includes(url.protocol) &&
      url.hostname.length > 0 && url.pathname.length > 1;
  }, "A PostgreSQL URL with a database name is required."),
  JWT_SECRET: z.string().trim().min(32),
  CHATBOT_PROVIDER: z.enum(["guided", "gemini"]).default("guided"),
  GEMINI_API_KEY: z.preprocess(v => v === "" ? undefined : v, z.string().trim().min(1).optional()),
  GEMINI_MODEL: z.preprocess(v => v === "" ? undefined : v, z.string().trim().regex(/^[A-Za-z0-9._-]+$/).optional()),
  CHATBOT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(15000),
  NOTIFICATION_EMAIL_PROVIDER: z.enum(["disabled", "test", "gmail"]).default("disabled"),
  NOTIFICATION_SMS_PROVIDER: z.enum(["disabled", "test", "philsms", "textbee"]).default("disabled"),
  APPOINTMENT_EMAIL_OTP_PROVIDER: z.enum(["disabled", "gmail"]).default("disabled"),
  APPOINTMENT_OTP_PROVIDER: z.enum(["disabled", "textbee"]).default("disabled"),
  TEXTBEE_API_KEY: z.preprocess(v => v === "" ? undefined : v, z.string().trim().min(1).regex(/^\S+$/).optional()),
  TEXTBEE_DEVICE_ID: z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^[a-fA-F0-9]{24}$/).optional()),
  APPOINTMENT_OTP_SECRET: z.preprocess(v => v === "" ? undefined : v, z.string().min(32).optional()),
  GMAIL_USER: z.preprocess(v => v === "" ? undefined : v, z.email().optional()),
  GMAIL_APP_PASSWORD: z.preprocess(v => typeof v === "string" ? v.replace(/ /g, "") || undefined : v, z.string().regex(/^[A-Za-z]{16}$/).optional()),
  NOTIFICATION_EMAIL_FROM: z.preprocess(v => v === "" ? undefined : v, z.email().optional()),
  PHILSMS_API_TOKEN: z.preprocess(v => v === "" ? undefined : v, z.string().trim().min(1).regex(/^\S+$/).optional()),
  PHILSMS_SENDER_ID: z.preprocess(v => v === "" ? undefined : v, z.string().trim().min(1).max(11).regex(/^[A-Za-z0-9 ]+$/).optional()),
  NOTIFICATION_SMS_POLICY: z.enum(["single", "minimal", "all"]).default("minimal"),
  PUBLIC_SITE_URL: z.preprocess(v => v === "" ? undefined : v, z.url().optional()),
  NOTIFICATION_LEASE_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
  NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(20000).default(10000),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  NOTIFICATION_RETRY_BASE_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  NOTIFICATION_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  NOTIFICATION_REMINDER_HOURS: z.coerce.number().int().min(0).max(168).default(24),
  PAYMENT_PROVIDER: z.enum(["disabled", "test", "paymongo"]).default("disabled"),
  PAYMONGO_SECRET_KEY: z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/).optional()),
  PAYMONGO_WEBHOOK_SECRET: z.preprocess(v => v === "" ? undefined : v, z.string().min(16).optional()),
  PAYMONGO_RETURN_URL: z.preprocess(v => v === "" ? undefined : v, z.url().optional()),
  PAYMENT_TEST_SECRET: z.preprocess(value => value === "" ? undefined : value, z.string().min(32).optional()),
  SALON_TIMEZONE: z.string().default("Asia/Manila").refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "A supported IANA timezone is required."),
  TRUSTED_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173")
    .transform(value => value.split(",").map(origin => origin.trim()))
    .refine(origins => origins.length > 0 && origins.every(origin => {
      try {
        const url = new URL(origin);
        return ["http:", "https:"].includes(url.protocol) && url.origin === origin;
      } catch { return false; }
    }), "Provide exact HTTP(S) origins, separated by commas."),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
}).superRefine((value, context) => {
  if (value.CHATBOT_PROVIDER === "gemini") {
    for (const field of ["GEMINI_API_KEY", "GEMINI_MODEL"] as const) {
      if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "Gemini configuration is required." });
    }
  }
  if (value.PUBLIC_SITE_URL) {
    const url = new URL(value.PUBLIC_SITE_URL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !value.TRUSTED_ORIGINS.includes(url.origin) || (value.NODE_ENV === "production" && url.protocol !== "https:")) {
      context.addIssue({ code: "custom", path: ["PUBLIC_SITE_URL"], message: "Use a trusted frontend origin without a path." });
    }
  }
  if (value.NOTIFICATION_LEASE_MS <= value.NOTIFICATION_TIMEOUT_MS + 1000) {
    context.addIssue({ code: "custom", path: ["NOTIFICATION_LEASE_MS"], message: "Lease must exceed provider timeout by more than one second." });
  }
  for (const field of ["NOTIFICATION_EMAIL_PROVIDER", "NOTIFICATION_SMS_PROVIDER"] as const) {
    if (value.NODE_ENV === "production" && value[field] === "test") context.addIssue({ code: "custom", path: [field], message: "Test notification providers are disabled in production." });
  }
  if ((value.APPOINTMENT_OTP_PROVIDER === "textbee" || value.APPOINTMENT_EMAIL_OTP_PROVIDER === "gmail") && !value.APPOINTMENT_OTP_SECRET) {
    context.addIssue({ code: "custom", path: ["APPOINTMENT_OTP_SECRET"], message: "A separate OTP secret is required." });
  }
  if ((value.NOTIFICATION_EMAIL_PROVIDER === "gmail" || value.APPOINTMENT_EMAIL_OTP_PROVIDER === "gmail") && value.GMAIL_USER && value.NOTIFICATION_EMAIL_FROM &&
      value.GMAIL_USER.toLowerCase() !== value.NOTIFICATION_EMAIL_FROM.toLowerCase()) {
    context.addIssue({ code: "custom", path: ["NOTIFICATION_EMAIL_FROM"], message: "Gmail sender must match GMAIL_USER." });
  }
  const notificationFields = [
    ...(value.NOTIFICATION_SMS_PROVIDER === "textbee" || value.APPOINTMENT_OTP_PROVIDER === "textbee" ? ["TEXTBEE_API_KEY", "TEXTBEE_DEVICE_ID"] as const : []),
    ...(value.NOTIFICATION_EMAIL_PROVIDER === "gmail" || value.APPOINTMENT_EMAIL_OTP_PROVIDER === "gmail" ? ["GMAIL_USER", "GMAIL_APP_PASSWORD", "NOTIFICATION_EMAIL_FROM"] as const : []),
    ...(value.NOTIFICATION_SMS_PROVIDER === "philsms" ? ["PHILSMS_API_TOKEN", "PHILSMS_SENDER_ID"] as const : []),
  ];
  for (const field of notificationFields) {
    if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "Notification provider configuration is required." });
  }
  if (value.PAYMENT_PROVIDER === "paymongo") {
    for (const field of ["PAYMONGO_SECRET_KEY", "PAYMONGO_WEBHOOK_SECRET", "PAYMONGO_RETURN_URL"] as const) {
      if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "PayMongo configuration is required." });
    }
    if (value.PAYMONGO_SECRET_KEY && (value.NODE_ENV === "production") !== value.PAYMONGO_SECRET_KEY.startsWith("sk_live_")) {
      context.addIssue({ code: "custom", path: ["PAYMONGO_SECRET_KEY"], message: "Use live keys only in production, and test keys otherwise." });
    }
    if (value.PAYMONGO_RETURN_URL) {
      const url = new URL(value.PAYMONGO_RETURN_URL);
      if (!value.TRUSTED_ORIGINS.includes(url.origin) || !["/appointment", "/booking-confirmed"].includes(url.pathname) || url.search || url.hash || url.username || url.password ||
        (url.protocol !== "https:" && !(value.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
        context.addIssue({ code: "custom", path: ["PAYMONGO_RETURN_URL"], message: "Use the trusted frontend booking-confirmed or appointment URL." });
      }
    }
  }
  if (value.PAYMENT_PROVIDER === "test" && (value.NODE_ENV === "production" || !value.PAYMENT_TEST_SECRET)) {
    context.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"], message: "Test payments require a secret and a non-production environment." });
  }
  if (value.COOKIE_SAME_SITE === "none" && value.NODE_ENV !== "production") {
    context.addIssue({ code: "custom", path: ["COOKIE_SAME_SITE"], message: "Cross-site cookies require production HTTPS." });
  }
  if (value.NODE_ENV === "production" && value.TRUSTED_ORIGINS.some(origin => !origin.startsWith("https://"))) {
    context.addIssue({ code: "custom", path: ["TRUSTED_ORIGINS"], message: "Production requires explicit HTTPS origins." });
  }
});

export function parseEnv(input: Record<string, unknown>) {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    // Report variable names only: never print connection strings or secrets.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${fields.join(", ")}.`);
  }
  return result.data;
}
