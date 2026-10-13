import { z } from "zod";
import { renderSimpleEmailLayout } from "../notifications/simple-email-layout.js";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import { ApiError } from "../../shared/http.js";
import { createGuestCredentials, tokenHash } from "./appointments.security.js";
import { smsRecipient, type NotificationProvider } from "../notifications/notification-provider.js";

export const OTP_TTL_MS = 5 * 60_000;
export const GUEST_SESSION_MS = 2 * 60 * 60_000;
export type OtpChannel = "SMS" | "EMAIL";
export const OTP_NOTICE = "If the booking details match, a verification code will arrive by your selected method. It expires in 5 minutes.";
function email(value: string) { const normalized = value.trim().toLowerCase(); return z.email().safeParse(normalized).success ? normalized : null; }
const invalid = () => new ApiError(400, "INVALID_OTP", "The code is incorrect or expired. Request a new code if needed.");
const limited = () => new ApiError(429, "OTP_LIMIT", "Please wait before requesting or checking another code.");
export function otpDigest(secret: string, purpose: string, value: string) {
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest("hex");
}
function sameHash(a: string, b: string) {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
function phone(value: string) { try { return smsRecipient(value); } catch { return null; } }

// Database-backed counters work across server processes and survive restarts.
async function rate(tx: Prisma.TransactionClient, key: string, limit: number, now: Date) {
  const rows = await tx.$queryRaw<{ count: number }[]>`
    INSERT INTO "AppointmentOtpRate" (key, count, "expiresAt") VALUES (${key}, 1, ${new Date(+now + 15 * 60_000)})
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN "AppointmentOtpRate"."expiresAt" <= ${now} THEN 1 ELSE "AppointmentOtpRate".count + 1 END,
    "expiresAt" = CASE WHEN "AppointmentOtpRate"."expiresAt" <= ${now} THEN ${new Date(+now + 15 * 60_000)} ELSE "AppointmentOtpRate"."expiresAt" END
    RETURNING count`;
  return rows[0]!.count <= limit;
}
export function createAppointmentOtpService(prisma: PrismaClient, secret: string, provider?: NotificationProvider, emailProvider?: NotificationProvider) {
  return {
    async request(bookingCode: string, contact: string, ip: string, channel: OtpChannel = "SMS") {
      const sender = channel === "EMAIL" ? emailProvider : provider;
      if (!sender) throw new ApiError(503, "OTP_DISABLED", "This verification method is unavailable. Choose another method or contact the salon.");
      const normalized = channel === "EMAIL" ? email(contact) : phone(contact);
      const identityKey = otpDigest(secret, "identity", bookingCode);
      const id = randomUUID(), code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const result = await prisma.$transaction(async tx => {
        const now = new Date();
        // Fixed order prevents deadlocks. Unknown bookings consume the same limits.
        const allowedIp = await rate(tx, otpDigest(secret, "request-ip", ip), 10, now);
        const allowedContact = await rate(tx, otpDigest(secret, channel === "EMAIL" ? "request-email" : "request-phone", normalized ?? contact), 3, now);
        const allowedBooking = await rate(tx, otpDigest(secret, "request-booking", bookingCode), 3, now);
        if (!allowedIp || !allowedContact || !allowedBooking) return { limited: true } as const;
        const recent = await tx.appointmentOtpChallenge.findFirst({ where: { identityKey, createdAt: { gt: new Date(+now - 60_000) } } });
        if (recent) return { limited: true } as const;
        const appointment = await tx.appointment.findUnique({ where: { bookingCode }, include: { customer: true } });
        const recorded = appointment ? (channel === "EMAIL" ? email(appointment.customer.email ?? "") : phone(appointment.customer.phone)) : null;
        const matches = normalized && appointment && recorded === normalized;
        await tx.appointmentOtpChallenge.updateMany({ where: { identityKey, consumedAt: null }, data: { consumedAt: now } });
        await tx.appointmentOtpChallenge.create({ data: { id, identityKey, appointmentId: matches ? appointment.id : null,
          codeHash: otpDigest(secret, id, code), expiresAt: new Date(+now + OTP_TTL_MS) } });
        return { recipient: matches ? normalized : null } as const;
      });
      if ("limited" in result) throw limited();
      if (result.recipient) {
        try {
          await sender.send({ id, channel, recipient: result.recipient, subject: "Appointment verification",
            ...(channel === "EMAIL" ? { html: renderSimpleEmailLayout({ title: "Your verification code", verificationCode: code,
              text: "Use this code to access your salon appointment. It expires in 5 minutes.\n\nDo not share this code." }) } : {}),
            text: `Your salon appointment access code is ${code}. It expires in 5 minutes. Do not share this code.` }, AbortSignal.timeout(10_000));
        } catch {
          await prisma.appointmentOtpChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
          console.error(JSON.stringify({ event: "appointment_otp_send_failed", challengeId: id }));
        }
      }
      // Do not expose whether the booking/contact exists or delivery was accepted.
      return { challengeId: id, message: OTP_NOTICE, retryAfterSeconds: 60 };
    },
    async verify(id: string, code: string, ip: string) {
      if (!provider && !emailProvider) throw new ApiError(503, "OTP_DISABLED", "Appointment verification is unavailable.");
      const result = await prisma.$transaction(async tx => {
        const now = new Date();
        if (!await rate(tx, otpDigest(secret, "verify-ip", ip), 30, now)) return { limited: true } as const;
        await tx.$queryRaw`SELECT id FROM "AppointmentOtpChallenge" WHERE id = ${id}::uuid FOR UPDATE`;
        const challenge = await tx.appointmentOtpChallenge.findUnique({ where: { id } });
        if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= 5) return null;
        const valid = sameHash(challenge.codeHash, otpDigest(secret, id, code));
        await tx.appointmentOtpChallenge.update({ where: { id }, data: { attempts: { increment: 1 },
          ...(valid || challenge.attempts === 4 ? { consumedAt: now } : {}) } });
        if (!valid || !challenge.appointmentId) return null;
        const appointment = await tx.appointment.findUniqueOrThrow({ where: { id: challenge.appointmentId } });
        const session = createGuestCredentials();
        await tx.appointmentGuestSession.create({ data: { tokenHash: session.hash, appointmentId: appointment.id, expiresAt: new Date(+now + GUEST_SESSION_MS) } });
        return { bookingCode: appointment.bookingCode, token: session.token };
      });
      if (!result) throw invalid();
      if ("limited" in result) throw limited();
      return result;
    },
    async session(token: string) {
      const row = await prisma.appointmentGuestSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { appointment: { select: { bookingCode: true } } } });
      return row && row.expiresAt > new Date() ? row.appointment.bookingCode : null;
    },
    async logout(token: string) {
      await prisma.appointmentGuestSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
    },
  };
}

export async function pruneAppointmentAccess(prisma: PrismaClient) {
  const now = new Date();
  // Retain challenge records briefly for operational diagnosis; none contain raw codes.
  await prisma.appointmentOtpChallenge.deleteMany({ where: { expiresAt: { lt: new Date(+now - 86400_000) } } });
  await prisma.appointmentGuestSession.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.appointmentOtpRate.deleteMany({ where: { expiresAt: { lt: now } } });
}
