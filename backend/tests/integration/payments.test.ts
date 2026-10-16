import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { before, after, afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createDatabasePool } from "../../src/database/pool.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Temporal } from "@js-temporal/polyfill";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createConfigurationService } from "../../src/modules/configuration/configuration.service.js";
import { createApiRouter } from "../../src/app/routes.js";
import { createApp } from "../../src/app/app.js";
import { parseEnv } from "../../src/config/env.schema.js";
import { ApiError } from "../../src/shared/http.js";
import { days } from "../../src/modules/configuration/configuration.schema.js";
import { SALON_COORDINATION_KEY } from "../../src/modules/scheduling/coordination.js";

import { createAppointmentsService } from "../../src/modules/appointments/appointments.service.js";
import type { BookingInput } from "../../src/modules/appointments/appointments.schema.js";
import { tokenHash } from "../../src/modules/appointments/appointments.security.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL is required for disposable PostgreSQL tests.");
const dbName = `salon_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl); url.pathname = `/${dbName}`; url.searchParams.delete("schema");
const adminPool = new Pool({ connectionString: adminUrl });
const pool = createDatabasePool(url.toString(), { application_name: "phase6-configuration" });
const observer = new Pool({ connectionString: url.toString(), application_name: "phase6-observer" });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const configuration = createConfigurationService(prisma, "Asia/Manila");
const run = promisify(execFile);
let adminId = "";
let cashierId = "";
let created = false;
before(async () => {
  await adminPool.query(`CREATE DATABASE "${dbName}"`); created = true;
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url.toString(), SEED_ADMIN_EMAIL: "admin@example.test", SEED_ADMIN_PASSWORD: "phase6-admin-password", SEED_CASHIER_EMAIL: "cashier@example.test", SEED_CASHIER_PASSWORD: "phase6-cashier-password" };
  await run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma7.config.ts"], { env });
  await run(process.execPath, ["--import", "tsx", "prisma/seed.ts"], { env });
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: env.SEED_ADMIN_EMAIL } })).id;
  cashierId = (await prisma.user.findUniqueOrThrow({ where: { email: env.SEED_CASHIER_EMAIL } })).id;
}, { timeout: 90_000 });
afterEach(async () => { await prisma.appointment.updateMany({ data: { status: "CANCELLED" } }); });
after(async () => {
  await prisma.$disconnect(); await pool.end(); await observer.end();
  try {
    if (created) {
      // Pool.end() can resolve before PostgreSQL observes each socket closing.
      // Wait for disconnection instead of force-terminating closing clients.
      await waitUntil(async () => (await adminPool.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [dbName])).rowCount === 0);
      await adminPool.query(`DROP DATABASE "${dbName}"`);
    }
  }
  finally { await adminPool.end(); }
});

async function fixture(status: "CONFIRMED" | "PENDING_PAYMENT" = "CONFIRMED", holdExpiresAt = new Date(Date.now() + 60_000)) {
  const staff = await prisma.staff.create({ data: { firstName: "Fixture", lastName: randomUUID() } });
  const item = await prisma.service.create({ data: { name: "Fixture service", price: "120.00", durationMinutes: 30, bufferMinutes: 15 } });
  const qualification = await prisma.staffService.create({ data: { staffId: staff.id, serviceId: item.id, commissionRate: "0.4000" } });
  const day = Temporal.Now.zonedDateTimeISO("Asia/Manila").add({ days: 7 }).with({ hour: 9, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  const startAt = new Date(day.epochMilliseconds);
  const endAt = new Date(startAt.getTime() + 30 * 60_000);
  const reservedUntilAt = new Date(startAt.getTime() + 45 * 60_000);
  const weekday = days[day.dayOfWeek - 1]!;
  const schedule = await prisma.staffSchedule.create({ data: { staffId: staff.id, dayOfWeek: weekday, startTime: new Date("1970-01-01T08:00Z"), endTime: new Date("1970-01-01T22:00Z") } });
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow({ orderBy: { version: "asc" } });
  const booking = await prisma.appointment.create({ data: {
    bookingCode: randomUUID(), customer: { create: { firstName: "Test", lastName: "Guest", phone: "0" } },
    bookingPolicyVersion: { connect: { id: policy.id } }, status, startAt, endAt, appointmentFeeAmount: "100.00", holdExpiresAt, guestAccessTokenHash: "test",
    appointmentServices: { create: { serviceId: item.id, staffId: staff.id, assignmentMode: "SPECIFIC", sequenceNo: 1, serviceNameSnapshot: item.name,
      priceSnapshot: "120.00", durationMinutesSnapshot: 30, bufferMinutesSnapshot: 15, commissionRateSnapshot: "0.4000", scheduledStartAt: startAt, scheduledEndAt: endAt, reservedUntilAt } },
  }, include: { appointmentServices: true } });
  return { staff, item, qualification, schedule, weekday, policy, booking, startAt, endAt, reservedUntilAt };
}
async function expectConflict(operation: Promise<unknown>, bookingId: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ApiError); assert.equal(error.code, "RESERVATION_CONFLICT");
    assert.ok(JSON.stringify(error.details).includes(bookingId)); return true;
  });
}
async function waitUntil(check: () => Promise<boolean>, limit = 3000) {
  const end = Date.now() + limit;
  while (!await check()) { if (Date.now() >= end) throw new Error("Database coordination test timed out."); await delay(20); }
}
async function writerBlocked() {
  await waitUntil(async () => (await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = 'phase6-configuration' AND wait_event_type = 'Lock'", [dbName])).rowCount! > 0);
}

const bookings = createAppointmentsService(prisma, "Asia/Manila");
async function bookingFixture() {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "CANCELLED" } });
  const input: BookingInput = { date: Temporal.Instant.fromEpochMilliseconds(+f.startAt).toZonedDateTimeISO("Asia/Manila").toPlainDate().toString(),
    startAt: f.startAt.toISOString(), services: [{ serviceId: f.item.id, assignmentMode: "SPECIFIC", staffId: f.staff.id }],
    customer: { firstName: "Guest", lastName: "Booking", phone: "+639171234567", email: "guest@example.test" } };
  return { ...f, input };
}

import { createPaymentsService } from "../../src/modules/payments/payments.service.js";
import { TestPaymentProvider, type VerifiedPayment } from "../../src/modules/payments/payment-provider.js";
import { createTokenService } from "../../src/modules/auth/auth.token.js";
const secret = "phase6-test-provider-secret-32-characters";
const provider = new TestPaymentProvider(secret, "test");
const payments = createPaymentsService(prisma, provider);
async function heldBooking() {
  const f = await bookingFixture();
  const booking = await bookings.book(f.input);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { bookingCode: booking.appointment.bookingCode } });
  return { ...f, ...booking, row };
}
function manual(bookingCode: string, reference = randomUUID()) {
  return { bookingCode, idempotencyKey: randomUUID(), amount: "100.00", currency: "PHP" as const, method: "CASH" as const, externalReference: reference };
}
async function eventFor(paymentId: string, changes: Partial<VerifiedPayment> = {}) {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const event = { paymentId, appointmentId: p.appointmentId, reference: p.externalReference!, amount: p.amount.toFixed(2), currency: "PHP", status: "SUCCEEDED", paidAt: new Date().toISOString(), ...changes };
  const raw = Buffer.from(JSON.stringify(event));
  return { raw, signature: createHmac("sha256", secret).update(raw).digest("hex") };
}
async function sendEvent(paymentId: string, changes: Partial<VerifiedPayment> = {}) {
  const event = await eventFor(paymentId, changes);
  const result = await payments.providerEvent(event.raw, event.signature);
  assert.ok(result); return result;
}

test("manual capture atomically confirms once, receipts, audits and queues notifications under concurrent retries", async () => {
  const f = await heldBooking(); const input = manual(f.row.bookingCode);
  const results = await Promise.all([payments.manual(cashierId, input), payments.manual(adminId, input)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[0].appointment.status, "CONFIRMED");
  assert.equal(results[0].satisfiesObligation, true); assert.ok(results[0].receipt);
  assert.equal(await prisma.payment.count({ where: { appointmentId: f.row.id } }), 1);
  assert.equal(await prisma.receipt.count({ where: { paymentId: results[0].id } }), 1);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id } }), 2);
  assert.equal(await prisma.auditLog.count({ where: { entityId: f.row.id, action: "BOOKING_CONFIRMED" } }), 1);
  assert.equal(await prisma.commissionRecord.count({ where: { appointmentId: f.row.id } }), 0);
  assert.equal((await bookings.retrieve(f.row.bookingCode, f.guestToken)).appointment.payments[0]!.receipt!.receiptNumber, results[0].receipt!.receiptNumber);
  assert.equal((await payments.manual(cashierId, { ...input, idempotencyKey: randomUUID() })).id, results[0].id);
  await assert.rejects(payments.manual(cashierId, { ...input, method: "GCASH" }), (e: ApiError) => e.code === "PAYMENT_IDENTITY_CONFLICT");
});

test("distinct captures are preserved for reconciliation without a second confirmation", async () => {
  const f = await heldBooking();
  const result = await Promise.all([payments.manual(adminId, manual(f.row.bookingCode)), payments.manual(cashierId, manual(f.row.bookingCode))]);
  assert.equal(result.filter(p => p.satisfiesObligation).length, 1);
  assert.equal(result.filter(p => p.reconciliationStatus === "REQUIRED").length, 1);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id, eventType: "BOOKING_CONFIRMED" } }), 1);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id, eventType: "PAYMENT_RECEIVED" } }), 2);
  assert.equal((await prisma.payment.aggregate({ where: { appointmentId: f.row.id, status: "SUCCEEDED" }, _sum: { amount: true } }))._sum.amount?.toFixed(2), "200.00");
});

test("manual fee payments generate unique references for every method and reuse them on retries", async () => {
  const references = new Set<string>();
  for (const method of ["CASH", "GCASH", "OTHER"] as const) {
    const f = await heldBooking();
    const { externalReference: _unused, ...base } = manual(f.row.bookingCode);
    const input = { ...base, method };
    const [first, retry] = await Promise.all([payments.manual(cashierId, input), payments.manual(cashierId, input)]);
    assert.equal(first.id, retry.id);
    assert.equal(first.receipt!.receiptNumber, retry.receipt!.receiptNumber);
    const saved = await prisma.payment.findUniqueOrThrow({ where: { id: first.id } });
    assert.match(saved.externalReference!, /^SALON-FEE-[a-f0-9-]{36}$/);
    assert.equal((first.receipt!.receiptSnapshot as { externalReference: string }).externalReference, saved.externalReference);
    assert.equal(await prisma.payment.count({ where: { appointmentId: f.row.id } }), 1);
    references.add(saved.externalReference!);
    await assert.rejects(payments.manual(cashierId, { ...input, method: method === "CASH" ? "GCASH" : "CASH" }), { code: "PAYMENT_IDENTITY_CONFLICT" });
  }
  assert.equal(references.size, 3);
});

test("checkout retries reuse their key; signed success and retries issue one confirmation and staff receipt", async () => {
  const f = await heldBooking();
  const key = randomUUID();
  const attempts = await Promise.all([payments.checkout(f.row.bookingCode, f.guestToken, key), payments.checkout(f.row.bookingCode, f.guestToken, key)]);
  assert.equal(attempts[0].payment.id, attempts[1].payment.id); assert.equal(attempts[0].testMode, true);
  const id = attempts[0].payment.id;
  const captured = await Promise.all([sendEvent(id), sendEvent(id)]);
  assert.equal(captured[0].appointment.status, "CONFIRMED"); assert.equal(captured[0].receipt, null);
  const receipts = await Promise.all([payments.issueReceipt(adminId, id), payments.issueReceipt(cashierId, id)]);
  assert.equal(receipts[0].receipt!.receiptNumber, receipts[1].receipt!.receiptNumber);
  await sendEvent(id, { status: "FAILED", paidAt: null });
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id } })).status, "SUCCEEDED");
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id } }), 2);
});

test("forged, mismatched and unowned payment events cannot confirm or write money", async () => {
  const f = await heldBooking(); const { payment } = await payments.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  const event = await eventFor(payment.id);
  await assert.rejects(payments.providerEvent(event.raw, "0".repeat(64)));
  for (const changes of [{ amount: "99.00" }, { currency: "USD" as "PHP" }, { appointmentId: randomUUID() }, { reference: "wrong" }]) await assert.rejects(sendEvent(payment.id, changes));
  await assert.rejects(payments.simulate(f.row.bookingCode, "x".repeat(43), payment.id, "SUCCEEDED"));
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, "PENDING");
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.row.id } })).status, "PENDING_PAYMENT");
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id } }), 0);
});

test("failed attempt can be retried; an eventual distinct capture is recorded for reconciliation", async () => {
  const f = await heldBooking(); const first = await payments.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  await sendEvent(first.payment.id, { status: "FAILED", paidAt: null });
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.row.id } })).status, "PENDING_PAYMENT");
  await assert.rejects(payments.issueReceipt(adminId, first.payment.id));
  const second = await payments.checkout(f.row.bookingCode, f.guestToken, randomUUID()); assert.notEqual(first.payment.id, second.payment.id);
  await payments.simulate(f.row.bookingCode, f.guestToken, second.payment.id, "SUCCEEDED");
  const late = await sendEvent(first.payment.id); assert.equal(late.status, "SUCCEEDED"); assert.equal(late.reconciliationStatus, "REQUIRED");
});

test("late capture records money without restoring a released reservation or displacing a new booking", async () => {
  const f = await heldBooking(); const { payment } = await payments.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  await prisma.appointment.update({ where: { id: f.row.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  const replacement = await bookings.book(f.input);
  const result = await sendEvent(payment.id, { paidAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(result.appointment.status, "EXPIRED"); assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.satisfiesObligation, false); assert.equal(result.reconciliationStatus, "REQUIRED");
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id, eventType: "BOOKING_CONFIRMED" } }), 0);
  assert.equal((await bookings.retrieve(replacement.appointment.bookingCode, replacement.guestToken)).appointment.status, "PENDING_PAYMENT");
  assert.ok((await payments.list(adminId)).payments.some(p => p.id === payment.id));
  await assert.rejects(payments.list(cashierId), (e: ApiError) => e.status === 403);
});

test("payment waiting on staff or payment lock uses fresh time after the deadline", async () => {
  for (const table of ["Staff", "Payment"] as const) {
    const f = await heldBooking(); const { payment } = await payments.checkout(f.row.bookingCode, f.guestToken, randomUUID());
    const client = await observer.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [table === "Staff" ? f.staff.id : payment.id]);
      await prisma.appointment.update({ where: { id: f.row.id }, data: { holdExpiresAt: new Date(Date.now() + 250) } });
      const pending = sendEvent(payment.id); await writerBlocked(); await delay(350); await client.query("COMMIT");
      const result = await pending; assert.equal(result.appointment.status, "EXPIRED"); assert.equal(result.reconciliationStatus, "REQUIRED");
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
});

test("expiration worker and payment confirmation serialize to a consistent state", async () => {
  for (const expired of [false, true]) {
    const f = await heldBooking();
    if (expired) await prisma.appointment.update({ where: { id: f.row.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    const [result] = await Promise.all([payments.manual(cashierId, manual(f.row.bookingCode)), bookings.expireHolds()]);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.row.id } })).status, expired ? "EXPIRED" : "CONFIRMED");
    assert.equal(result.satisfiesObligation, !expired);
  }
});

test("missing reservation ownership blocks automatic confirmation", async () => {
  const f = await heldBooking();
  await prisma.appointmentService.updateMany({ where: { appointmentId: f.row.id }, data: { membershipStatus: "REMOVED", removedAt: new Date() } });
  const result = await payments.manual(adminId, manual(f.row.bookingCode));
  assert.equal(result.satisfiesObligation, false); assert.equal(result.reconciliationStatus, "REQUIRED"); assert.equal(result.appointment.status, "PENDING_PAYMENT");
});

test("manual identity cannot cross appointments; wrong amounts and inactive actors roll back", async () => {
  const f = await heldBooking(); const second = await heldBooking(); const input = manual(f.row.bookingCode);
  await payments.manual(adminId, input);
  await assert.rejects(payments.manual(adminId, { ...input, bookingCode: second.row.bookingCode }));
  await assert.rejects(payments.manual(adminId, { ...manual(second.row.bookingCode), amount: "99.00" }));
  await prisma.user.update({ where: { id: cashierId }, data: { isActive: false } });
  try { await assert.rejects(payments.manual(cashierId, manual(second.row.bookingCode)), (e: ApiError) => e.status === 401); }
  finally { await prisma.user.update({ where: { id: cashierId }, data: { isActive: true } }); }
  assert.equal(await prisma.payment.count({ where: { appointmentId: second.row.id } }), 0);
});

test("HTTP endpoints enforce guest access, CSRF, staff/admin permissions, and raw provider authentication", async () => {
  const config = parseEnv({ NODE_ENV: "test", DATABASE_URL: url.toString(), JWT_SECRET: "p".repeat(32), PAYMENT_PROVIDER: "test", PAYMENT_TEST_SECRET: secret });
  const app = createApp(createApiRouter(prisma, config)); const server = app.listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`; const tokens = createTokenService(config.JWT_SECRET);
  const cashierCookie = `salon_session=${await tokens.sign({ userId: cashierId, role: "CASHIER" })}`;
  const adminCookie = `salon_session=${await tokens.sign({ userId: adminId, role: "ADMIN" })}`;
  const post = (path: string, body: unknown, cookie?: string, origin: string | null = "http://localhost:5173") => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    const f = await heldBooking();
    assert.equal((await post("/payments/manual", manual(f.row.bookingCode))).status, 401);
    assert.equal((await post("/payments/manual", manual(f.row.bookingCode), cashierCookie, null)).status, 403);
    assert.equal((await post("/payments/manual", { ...manual(f.row.bookingCode), currency: "USD" }, cashierCookie)).status, 400);
    assert.equal((await fetch(`${base}/payments`, { headers: { Cookie: cashierCookie } })).status, 403);
    assert.equal((await fetch(`${base}/payments`, { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await post("/payments/checkout", { bookingCode: f.row.bookingCode, token: "x".repeat(43), idempotencyKey: randomUUID() })).status, 404);
    const response = await post("/payments/checkout", { bookingCode: f.row.bookingCode, token: f.guestToken, idempotencyKey: randomUUID() });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const { payment } = await response.json(); const event = await eventFor(payment.id);
    const receiptInput = { bookingCode: f.row.bookingCode, token: f.guestToken, paymentId: payment.id };
    assert.equal((await post("/payments/customer-receipt", { ...receiptInput, token: "x".repeat(43) })).status, 404);
    assert.equal((await post("/payments/customer-receipt", receiptInput, undefined, "https://evil.test")).status, 403);
    assert.equal((await post("/payments/customer-receipt", { ...receiptInput, amount: "100.00" })).status, 400);
    assert.equal((await post("/payments/customer-receipt", receiptInput)).status, 409);
    assert.equal((await post("/payments/provider/events", JSON.parse(event.raw.toString()), undefined, null)).status, 401);
    const accepted = await fetch(`${base}/payments/provider/events`, { method: "POST", headers: { "Content-Type": "application/json", "x-payment-signature": event.signature }, body: event.raw.toString() });
    assert.equal(accepted.status, 200); assert.equal((await accepted.json()).received, true);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.row.id } })).status, "CONFIRMED");
    assert.equal((await post("/payments/receipts", { paymentId: payment.id }, cashierCookie)).status, 200);
    const lookup = await post("/payments/lookup", { bookingCode: f.row.bookingCode }, cashierCookie);
    assert.equal(lookup.status, 200); assert.ok(!JSON.stringify(await lookup.json()).includes("guestAccessTokenHash"));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a deadline crossed during notification insertion rolls back stale confirmation and reconciles the capture", async () => {
  const f = await heldBooking();
  await observer.query(`CREATE FUNCTION phase6_delay_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."appointmentId" = '${f.row.id}'::uuid AND NEW."eventType" = 'BOOKING_CONFIRMED' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$`);
  await observer.query('CREATE TRIGGER phase6_delay BEFORE INSERT ON "NotificationQueue" FOR EACH ROW EXECUTE FUNCTION phase6_delay_confirmation()');
  try {
    await prisma.appointment.update({ where: { id: f.row.id }, data: { holdExpiresAt: new Date(Date.now() + 300) } });
    const result = await payments.manual(adminId, manual(f.row.bookingCode));
    assert.equal(result.status, "SUCCEEDED"); assert.equal(result.appointment.status, "EXPIRED");
    assert.equal(result.satisfiesObligation, false); assert.equal(result.reconciliationStatus, "REQUIRED");
    assert.equal(await prisma.payment.count({ where: { appointmentId: f.row.id } }), 1);
    assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id, eventType: "BOOKING_CONFIRMED" } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { entityId: f.row.id, action: "BOOKING_CONFIRMED" } }), 0);
  } finally {
    await observer.query('DROP TRIGGER phase6_delay ON "NotificationQueue"');
    await observer.query('DROP FUNCTION phase6_delay_confirmation()');
  }
});

test("outbox insertion failure rolls back payment, receipt, audit, and confirmation together", async () => {
  const f = await heldBooking();
  await observer.query(`CREATE FUNCTION phase6_reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."appointmentId" = '${f.row.id}'::uuid THEN RAISE EXCEPTION 'test outbox failure'; END IF; RETURN NEW; END $$`);
  await observer.query('CREATE TRIGGER phase6_reject BEFORE INSERT ON "NotificationQueue" FOR EACH ROW EXECUTE FUNCTION phase6_reject_notification()');
  const input = manual(f.row.bookingCode);
  try {
    await assert.rejects(payments.manual(adminId, input));
    assert.equal(await prisma.payment.count({ where: { appointmentId: f.row.id } }), 0);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.row.id } })).status, "PENDING_PAYMENT");
    assert.equal(await prisma.auditLog.count({ where: { entityId: f.row.id, action: "BOOKING_CONFIRMED" } }), 0);
  } finally {
    await observer.query('DROP TRIGGER phase6_reject ON "NotificationQueue"');
    await observer.query('DROP FUNCTION phase6_reject_notification()');
  }
  assert.equal((await payments.manual(adminId, input)).appointment.status, "CONFIRMED");
});

test("provider outage preserves a retryable pending attempt with stable checkout identity", async () => {
  class UnavailableOnce extends TestPaymentProvider {
    calls = 0;
    override async createPayment(request: Parameters<TestPaymentProvider["createPayment"]>[0]) {
      if (this.calls++ === 0) throw new ApiError(503, "PROVIDER_UNAVAILABLE", "Test outage.");
      return super.createPayment(request);
    }
  }
  const service = createPaymentsService(prisma, new UnavailableOnce(secret, "test"));
  const f = await heldBooking(); const key = randomUUID();
  await assert.rejects(service.checkout(f.row.bookingCode, f.guestToken, key));
  const before = await prisma.payment.findFirstOrThrow({ where: { appointmentId: f.row.id } });
  assert.equal(before.status, "PENDING"); assert.equal(before.externalReference, null);
  const retry = await service.checkout(f.row.bookingCode, f.guestToken, key);
  assert.equal(retry.payment.id, before.id);
  assert.equal(await prisma.payment.count({ where: { appointmentId: f.row.id } }), 1);
  assert.equal((await bookings.retrieve(f.row.bookingCode, f.guestToken)).appointment.status, "PENDING_PAYMENT");
});

test("confirmation rechecks stored reservation coverage without repricing service snapshots", async () => {
  const f = await heldBooking();
  await prisma.service.update({ where: { id: f.item.id }, data: { price: "900.00", durationMinutes: 90 } });
  const result = await payments.manual(adminId, manual(f.row.bookingCode));
  assert.equal(result.appointment.status, "CONFIRMED");
  const row = await prisma.appointmentService.findFirstOrThrow({ where: { appointmentId: f.row.id } });
  assert.equal(row.priceSnapshot.toFixed(2), "120.00"); assert.equal(row.durationMinutesSnapshot, 30);
  const broken = await heldBooking();
  // Simulate inconsistent persisted data; ordinary configuration writes reject this.
  await prisma.staffSchedule.update({ where: { id: broken.schedule.id }, data: { isActive: false } });
  const captured = await payments.manual(adminId, manual(broken.row.bookingCode));
  assert.equal(captured.satisfiesObligation, false); assert.equal(captured.reconciliationStatus, "REQUIRED");
});

import { PayMongoProvider } from "../../src/modules/payments/paymongo-provider.js";
function paymongoFixture() {
  const namespace = randomUUID().replaceAll("-", "");
  const sessions = new Map<string, { request: { reference_number: string; metadata: { paymentId: string; appointmentId: string }; line_items: { amount: number; currency: string; quantity: number }[] }; paid: boolean; expired: boolean }>();
  let creates = 0, loseResponse = false;
  const config = { secretKey: "sk_test_fixture", webhookSecret: "whsk_fixture_secret_123456", returnUrl: "https://salon.test/appointment" };
  const provider = new PayMongoProvider(config, (async (url, init) => {
    const path = new URL(String(url)).pathname;
    let sessionId: string;
    if (path === "/v2/checkout_sessions") {
      creates++; sessionId = `cs_${namespace}${creates}`;
      sessions.set(sessionId, { request: JSON.parse(init!.body as string).data.attributes, paid: false, expired: false });
      if (loseResponse) throw new Error("Lost response after successful creation");
    } else sessionId = path.split("/")[3]!;
    const row = sessions.get(sessionId)!;
    if (path.endsWith("/expire")) row.expired = true;
    return Response.json({ data: { id: sessionId, type: "checkout_session", attributes: {
      ...row.request, livemode: false, status: row.expired ? "expired" : "active", checkout_url: `https://checkout.paymongo.com/${sessionId}`,
      payments: row.paid ? [{ id: `pay_${sessionId.slice(3)}`, type: "payment", attributes: { amount: row.request.line_items[0]!.amount, currency: "PHP", status: "paid", source: { type: "gcash" }, livemode: false, paid_at: Math.floor(Date.now()/1000) } }] : [],
    } } });
  }) as typeof fetch);
  const service = createPaymentsService(prisma, provider);
  async function capture(sessionId: string) {
    sessions.get(sessionId)!.paid = true;
    const raw = Buffer.from(JSON.stringify({ data: { type: "event", attributes: { type: "checkout_session.payment.paid", livemode: false, data: { id: sessionId, type: "checkout_session" } } } }));
    const t = String(Math.floor(Date.now()/1000));
    const sig = createHmac("sha256", config.webhookSecret).update(`${t}.`).update(raw).digest("hex");
    return service.providerEvent(raw, `t=${t},te=${sig},li=`);
  }
  return { service, provider, sessions, capture, get creates() { return creates; }, get reference() { return `cs_${namespace}1`; }, loseResponse: () => { loseResponse = true; } };
}
test("PayMongo checkout is claimed once across processes/keys; capture identity confirms once and status refresh is safe", async () => {
  const f = await heldBooking(); const gateway = paymongoFixture();
  const first = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  const retried = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  assert.equal(first.payment.id, retried.payment.id); assert.equal(gateway.creates, 1);
  assert.match(retried.checkoutUrl!, /^https:\/\/checkout.paymongo.com/);
  assert.equal((await gateway.service.refresh(f.row.bookingCode, f.guestToken, first.payment.id)).status, "PENDING");
  const results = await Promise.all([gateway.capture(gateway.reference), gateway.capture(gateway.reference)]);
  assert.equal(results[0]!.appointment.status, "CONFIRMED");
  assert.ok(results[0]!.receipt);
  assert.equal(results[0]!.receipt!.receiptNumber, results[1]!.receipt!.receiptNumber);
  const receipt = await prisma.receipt.findUniqueOrThrow({ where: { paymentId: first.payment.id } });
  assert.equal(receipt.issuedByUserId, null);
  assert.equal((receipt.receiptSnapshot as { issuedBy: string }).issuedBy, "SYSTEM");
  assert.equal((receipt.receiptSnapshot as { amount: string }).amount, first.payment.amount);
  assert.equal(await prisma.receipt.count({ where: { paymentId: first.payment.id } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { entityId: receipt.id, action: "RECEIPT_ISSUED" } }), 1);
  assert.equal((await bookings.retrieve(f.row.bookingCode, f.guestToken)).appointment.payments[0]!.receipt!.receiptNumber, receipt.receiptNumber);
  const customerReceipt = await gateway.service.customerReceipt(f.row.bookingCode, f.guestToken, first.payment.id);
  assert.equal(customerReceipt.receipt!.receiptNumber, receipt.receiptNumber);
  assert.equal((await gateway.service.issueReceipt(adminId, first.payment.id)).receipt!.receiptNumber, receipt.receiptNumber);
  const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: first.payment.id } });
  assert.equal(persisted.externalReference, `pay_${gateway.reference.slice(3)}`); assert.equal(persisted.method, "GCASH");
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id } }), 2);
  await assert.rejects(gateway.service.refresh(f.row.bookingCode, "x".repeat(43), first.payment.id));
});
test("customer receipt generation requires appointment access and an already verified PayMongo capture", async () => {
  const f = await heldBooking(); const gateway = paymongoFixture();
  const checkout = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  await assert.rejects(gateway.service.customerReceipt(f.row.bookingCode, f.guestToken, checkout.payment.id), { code: "RECEIPT_UNAVAILABLE" });
  await assert.rejects(gateway.service.customerReceipt(f.row.bookingCode, "x".repeat(43), checkout.payment.id), { code: "APPOINTMENT_NOT_FOUND" });
  const other = await heldBooking();
  await assert.rejects(gateway.service.customerReceipt(other.row.bookingCode, other.guestToken, checkout.payment.id), { code: "NOT_FOUND" });
  assert.equal(await prisma.receipt.count({ where: { paymentId: checkout.payment.id } }), 0);
  // A verified capture from before automatic issuance can receive its first receipt.
  const legacy = await prisma.payment.create({ data: { appointmentId: f.row.id, idempotencyKey: randomUUID(), type: "APPOINTMENT_FEE", provider: "paymongo", method: "GCASH", status: "SUCCEEDED", amount: f.row.appointmentFeeAmount, currency: "PHP", paidAt: new Date(), externalReference: `pay_legacy_${randomUUID()}` } });
  const [first, second] = await Promise.all([gateway.service.customerReceipt(f.row.bookingCode, f.guestToken, legacy.id), gateway.service.customerReceipt(f.row.bookingCode, f.guestToken, legacy.id)]);
  assert.equal(first.receipt!.receiptNumber, second.receipt!.receiptNumber);
  assert.equal(await prisma.receipt.count({ where: { paymentId: legacy.id } }), 1);
  const snapshot = (await prisma.receipt.findUniqueOrThrow({ where: { paymentId: legacy.id } })).receiptSnapshot;
  await prisma.customer.update({ where: { id: f.row.customerId }, data: { firstName: "Changed after receipt" } });
  assert.deepEqual((await gateway.service.customerReceipt(f.row.bookingCode, f.guestToken, legacy.id)).receipt!.receiptSnapshot, snapshot);
});
test("automatic PayMongo receipt failure rolls back capture and confirmation, then retries issue once", async () => {
  const f = await heldBooking(); const gateway = paymongoFixture();
  const checkout = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  await observer.query(`CREATE FUNCTION reject_auto_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."paymentId" = '${checkout.payment.id}'::uuid THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$`);
  await observer.query('CREATE TRIGGER reject_auto_receipt BEFORE INSERT ON "Receipt" FOR EACH ROW EXECUTE FUNCTION reject_auto_receipt()');
  try {
    await assert.rejects(gateway.capture(gateway.reference));
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: checkout.payment.id } })).status, "PENDING");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.row.id } })).status, "PENDING_PAYMENT");
    assert.equal(await prisma.receipt.count({ where: { paymentId: checkout.payment.id } }), 0);
    assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id } }), 0);
  } finally {
    await observer.query('DROP TRIGGER reject_auto_receipt ON "Receipt"');
    await observer.query('DROP FUNCTION reject_auto_receipt()');
  }
  assert.ok((await gateway.capture(gateway.reference))!.receipt);
  assert.equal(await prisma.receipt.count({ where: { paymentId: checkout.payment.id } }), 1);
});
test("lost PayMongo create response is not retried blindly; signed callback recovers session and records payment", async () => {
  const f = await heldBooking(); const gateway = paymongoFixture(); gateway.loseResponse();
  const key = randomUUID(); await assert.rejects(gateway.service.checkout(f.row.bookingCode, f.guestToken, key));
  await assert.rejects(gateway.service.checkout(f.row.bookingCode, f.guestToken, key), (e: ApiError) => e.code === "CHECKOUT_UNCERTAIN");
  await assert.rejects(gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID()));
  assert.equal(gateway.creates, 1);
  const captured = await gateway.capture(gateway.reference); assert.equal(captured!.appointment.status, "CONFIRMED");
});
test("Admin recovers an uncertain PayMongo session by verified identity; Cashier cannot", async () => {
  const f = await heldBooking(); const gateway = paymongoFixture(); gateway.loseResponse();
  await assert.rejects(gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID()));
  const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: f.row.id } });
  await assert.rejects(gateway.service.recoverCheckout(cashierId, payment.id, gateway.reference), (e: ApiError) => e.status === 403);
  await assert.rejects(gateway.service.recoverCheckout(adminId, randomUUID(), gateway.reference));
  const result = await gateway.service.recoverCheckout(adminId, payment.id, gateway.reference); assert.equal(result.status, "PENDING");
  const resumed = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID()); assert.ok(resumed.checkoutUrl); assert.equal(gateway.creates, 1);
});
test("expired PayMongo sessions are cleaned up outside locks; late captures remain reconciliation transactions", async () => {
  const f = await heldBooking(); const gateway = paymongoFixture();
  const checkout = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  await prisma.appointment.update({ where: { id: f.row.id }, data: { holdExpiresAt: new Date(Date.now()-1000) } });
  await bookings.expireHolds(); await gateway.service.synchronizeExpired();
  assert.equal(gateway.sessions.get(gateway.reference)!.expired, true);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: checkout.payment.id } })).status, "EXPIRED");
  const late = await gateway.capture(gateway.reference); assert.equal(late!.status, "SUCCEEDED"); assert.equal(late!.reconciliationStatus, "REQUIRED"); assert.equal(late!.appointment.status, "EXPIRED");
});

import { createPaymentsRouter } from "../../src/modules/payments/payments.routes.js";
test("PayMongo HTTP webhook uses Paymongo-Signature without browser cookies and exposes only an acknowledgement", async () => {
  const gateway = paymongoFixture(); const f = await heldBooking();
  const checkout = await gateway.service.checkout(f.row.bookingCode, f.guestToken, randomUUID());
  gateway.sessions.get(gateway.reference)!.paid = true;
  const config = parseEnv({ NODE_ENV: "test", DATABASE_URL: url.toString(), JWT_SECRET: "p".repeat(32) });
  const server = createApp(createPaymentsRouter(prisma, config, gateway.provider)).listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const raw = JSON.stringify({ data: { type: "event", attributes: { type: "checkout_session.payment.paid", livemode: false, data: { id: gateway.reference, type: "checkout_session" } } } });
    const t = String(Math.floor(Date.now()/1000)); const signature = createHmac("sha256", "whsk_fixture_secret_123456").update(`${t}.${raw}`).digest("hex");
    const endpoint = `http://127.0.0.1:${address.port}/api/payments/provider/events`;
    const request = (header: string, body = raw) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", [header]: `t=${t},te=${signature},li=` }, body });
    assert.equal((await request("x-payment-signature")).status, 401);
    assert.equal((await request("paymongo-signature", raw+" ")).status, 401);
    const accepted = await request("paymongo-signature"); assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { received: true });
    assert.equal((await request("paymongo-signature")).status, 200);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: checkout.payment.id } })).status, "SUCCEEDED");
    assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.row.id } }), 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
