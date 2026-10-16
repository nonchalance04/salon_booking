import { createGmailProvider } from "../notifications/gmail-provider.js";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { browserSecurity, cookieOptions, type AuthConfig } from "../auth/auth.security.js";
import { validateRequest, ApiError } from "../../shared/http.js";
import { createTextBeeProvider, type NotificationProvider } from "../notifications/notification-provider.js";
import { createAppointmentOtpService, GUEST_SESSION_MS } from "./appointment-otp.service.js";
import { createAppointmentsService } from "./appointments.service.js";
import { tokenHash } from "./appointments.security.js";
import { guestAccessSchema } from "./appointments.schema.js";

export const GUEST_SESSION_COOKIE = "salon_appointment_session";
const COOKIE = GUEST_SESSION_COOKIE;
export function guestSessionCookie(header?: string) {
  const values = (header ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return "";
  const token = values[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
}
// Empty tokens explicitly select the HttpOnly appointment session. Existing
// private links continue to use their original token and are never rotated.
export function guestSessionCredentials(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    if (req.body?.token === "") {
      const token = guestSessionCookie(req.get("cookie"));
      const session = token ? await prisma.appointmentGuestSession.findUnique({ where: { tokenHash: tokenHash(token) } }) : null;
      if (!session || session.expiresAt <= new Date()) throw new ApiError(401, "GUEST_SESSION_EXPIRED", "Your appointment session expired. Verify your email or phone number again.");
      req.body.token = token;
    }
    next();
  };
}
export function createAppointmentOtpRouter(prisma: PrismaClient, config: AuthConfig, provider?: NotificationProvider, emailProvider?: NotificationProvider) {
  const router = Router();
  const enabled = config.APPOINTMENT_OTP_PROVIDER === "textbee";
  const sms = provider ?? (enabled ? createTextBeeProvider(config.TEXTBEE_API_KEY!, config.TEXTBEE_DEVICE_ID!) : undefined);
  const emailEnabled = config.APPOINTMENT_EMAIL_OTP_PROVIDER === "gmail";
  const email = emailProvider ?? (emailEnabled ? createGmailProvider(config.GMAIL_USER!, config.GMAIL_APP_PASSWORD!, config.NOTIFICATION_EMAIL_FROM!, config.NOTIFICATION_TIMEOUT_MS) : undefined);
  const channels = [...(enabled ? ["SMS" as const] : []), ...(emailEnabled ? ["EMAIL" as const] : [])];
  const service = createAppointmentOtpService(prisma, config.APPOINTMENT_OTP_SECRET ?? "", sms, email);
  const bookings = createAppointmentsService(prisma, config.SALON_TIMEZONE);
  router.use("/appointments/otp", browserSecurity(config.TRUSTED_ORIGINS));
  router.post("/appointments/link", browserSecurity(config.TRUSTED_ORIGINS), validateRequest(z.object({ body: z.object({ token: guestAccessSchema.shape.token }).strict() })), async (_req, res) => {
    const token = res.locals.validated.body.token;
    const code = await service.session(token);
    if (!code) throw new ApiError(404, "BOOKING_LINK_EXPIRED", "This private link is invalid or expired. Use email or SMS verification to access your appointment.");
    res.set("Referrer-Policy", "no-referrer");
    res.json(await bookings.retrieve(code, token));
  });
  router.get("/appointments/otp/options", (_req, res) => res.json({ available: channels.length > 0, channels }));
  const requestSchema = z.discriminatedUnion("channel", [
    z.object({ channel: z.literal("SMS"), bookingCode: guestAccessSchema.shape.bookingCode,
      phone: z.string().trim().min(5).max(32).regex(/^\+?[0-9 ()-]+$/) }).strict(),
    z.object({ channel: z.literal("EMAIL"), bookingCode: guestAccessSchema.shape.bookingCode,
      email: z.email().max(254) }).strict(),
  ]);
  router.post("/appointments/otp/request", validateRequest(z.object({ body: z.preprocess(
    value => value && typeof value === "object" && !("channel" in value) ? { ...value, channel: "SMS" } : value,
    requestSchema,
  ) })), async (req, res) => {
    const input = res.locals.validated.body as z.infer<typeof requestSchema>;
    res.json(await service.request(input.bookingCode, input.channel === "EMAIL" ? input.email : input.phone, req.ip ?? "unknown", input.channel));
  });
  router.post("/appointments/otp/verify", validateRequest(z.object({ body: z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict() })), async (req, res) => {
    const { challengeId, code } = res.locals.validated.body;
    const session = await service.verify(challengeId, code, req.ip ?? "unknown");
    const result = await bookings.retrieve(session.bookingCode, session.token);
    res.cookie(COOKIE, session.token, { ...cookieOptions(config), maxAge: GUEST_SESSION_MS });
    res.json(result);
  });
  router.get("/appointments/otp/session", async (req, res) => {
    const token = guestSessionCookie(req.get("cookie"));
    const code = token ? await service.session(token) : null;
    if (!code) throw new ApiError(401, "GUEST_SESSION_EXPIRED", "Verify your email or phone number to view your appointment.");
    res.json(await bookings.retrieve(code, token));
  });
  router.post("/appointments/otp/logout", async (req, res) => {
    await service.logout(guestSessionCookie(req.get("cookie")));
    res.clearCookie(COOKIE, cookieOptions(config));
    res.status(204).end();
  });
  return router;
}
