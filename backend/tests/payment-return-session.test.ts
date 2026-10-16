import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createPaymentsService } from "../src/modules/payments/payments.service.js";
import { createGuestCredentials, tokenHash, validGuestAccess } from "../src/modules/appointments/appointments.security.js";
import { GUEST_SESSION_MS } from "../src/modules/appointments/appointment-otp.service.js";

function fixture() {
  const credentials = createGuestCredentials();
  const appointment = { id: "appointment-id", bookingCode: credentials.bookingCode, guestAccessTokenHash: credentials.hash, status: "PENDING_PAYMENT" };
  const sessions: { tokenHash: string; appointmentId: string; expiresAt: Date }[] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    appointment: { findUnique: async ({ where }: { where: { bookingCode: string } }) => where.bookingCode === appointment.bookingCode ? appointment : null },
    appointmentGuestSession: {
      create: async ({ data }: { data: typeof sessions[number] }) => { sessions.push(data); return data; },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const session = sessions.find(s => s.tokenHash === where.tokenHash);
        return session ? { ...session, appointment: { bookingCode: appointment.bookingCode } } : null;
      },
    },
  };
  const prisma = { ...tx, $transaction: async (work: (db: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  return { credentials, appointment, sessions, prisma, service: createPaymentsService(prisma) };
}

test("checkout return sessions preserve private access and payment state, store hashes, and expire in two hours", async () => {
  const f = fixture();
  const before = Date.now();
  const token = await f.service.returnSession(f.appointment.bookingCode, f.credentials.token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, f.credentials.token);
  assert.equal(f.sessions[0]!.tokenHash, tokenHash(token));
  assert.ok(+f.sessions[0]!.expiresAt >= before + GUEST_SESSION_MS);
  assert.ok(+f.sessions[0]!.expiresAt <= Date.now() + GUEST_SESSION_MS);
  assert.equal(f.appointment.status, "PENDING_PAYMENT");
  assert.equal(await validGuestAccess(f.prisma, f.credentials.token, f.appointment), true);
  assert.equal(await validGuestAccess(f.prisma, token, f.appointment), true);
  assert.equal(await validGuestAccess(f.prisma, token, { ...f.appointment, bookingCode: "SL-OTHER1", guestAccessTokenHash: "0".repeat(64) }), false);
  f.sessions[0]!.expiresAt = new Date(0);
  assert.equal(await validGuestAccess(f.prisma, token, f.appointment), false);
});

test("a booking reference, invalid token, or expired session cannot grant return access", async () => {
  const f = fixture();
  await assert.rejects(f.service.returnSession(f.appointment.bookingCode, "x".repeat(43)), { code: "APPOINTMENT_NOT_FOUND" });
  await assert.rejects(f.service.returnSession("SL-OTHER1", f.credentials.token), { code: "APPOINTMENT_NOT_FOUND" });
  assert.equal(f.sessions.length, 0);
  const token = await f.service.returnSession(f.appointment.bookingCode, f.credentials.token);
  f.sessions[0]!.expiresAt = new Date(0);
  await assert.rejects(f.service.returnSession(f.appointment.bookingCode, token), { code: "APPOINTMENT_NOT_FOUND" });
  assert.equal(f.sessions.length, 1);
});
