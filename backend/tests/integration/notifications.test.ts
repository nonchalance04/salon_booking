import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { before, after, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createDatabasePool } from "../../src/database/pool.js";
import { createNotificationsService, type NotificationOptions } from "../../src/modules/notifications/notifications.service.js";
import { createTestNotificationProvider, NotificationFailure, type NotificationMessage, type NotificationProvider } from "../../src/modules/notifications/notification-provider.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL is required for disposable PostgreSQL tests.");
const dbName = `salon_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl); url.pathname = `/${dbName}`; url.searchParams.delete("schema");
const adminPool = new Pool({ connectionString: adminUrl });
const pool = createDatabasePool(url.toString());
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
let created = false;
before(async () => {
  await adminPool.query(`CREATE DATABASE "${dbName}"`); created = true;
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url.toString(), SEED_ADMIN_EMAIL: "admin@example.test", SEED_ADMIN_PASSWORD: "phase9-test-password", SEED_CASHIER_EMAIL: "cashier@example.test", SEED_CASHIER_PASSWORD: "phase9-test-password" };
  const run = promisify(execFile);
  await run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma7.config.ts"], { env });
  await run(process.execPath, ["--import", "tsx", "prisma/seed.ts"], { env });
}, { timeout: 90_000 });
beforeEach(async () => {
  await prisma.notificationQueue.deleteMany();
  await prisma.appointment.updateMany({ data: { status: "CANCELLED" } });
});
after(async () => {
  await prisma.$disconnect(); await pool.end();
  try {
    if (created) {
      for (let i = 0; i < 100 && (await adminPool.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [dbName])).rowCount; i++) await delay(20);
      await adminPool.query(`DROP DATABASE "${dbName}"`);
    }
  } finally { await adminPool.end(); }
});
const sent: NotificationMessage[] = [];
function service(provider: NotificationProvider = createTestNotificationProvider(m => sent.push(m)), overrides: Partial<NotificationOptions> = {}) {
  return createNotificationsService(prisma, { smsPolicy: "all", publicSiteUrl: "https://salon.example.com", bookingLinkSecret: "s".repeat(32), providers: { EMAIL: provider, SMS: provider }, timeZone: "Asia/Manila", leaseMs: 1000, timeoutMs: 500, maxAttempts: 3, retryBaseMs: 10000, reminderHours: 24, ...overrides });
}
async function queue(extra: object = {}) {
  return prisma.notificationQueue.create({ data: { eventType: "BOOKING_CONFIRMED", channel: "EMAIL", recipient: "guest@example.test", status: "PENDING", scheduledAt: new Date(Date.now() - 1000), payload: { schemaVersion: 1, bookingCode: "BOOK-123" }, ...extra } });
}
const stored = (id: string) => prisma.notificationQueue.findUniqueOrThrow({ where: { id } });
const expire = (id: string) => prisma.notificationQueue.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 60_000) } });
async function appointment(extra: object = {}, email: string | null = "guest@example.test") {
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow();
  const startAt = new Date(Date.now() + 3_600_000);
  return prisma.appointment.create({ data: { bookingCode: randomUUID(), customer: { create: { firstName: "Test", lastName: "Guest", phone: "09171234567", email } },
    bookingPolicyVersion: { connect: { id: policy.id } }, status: "CONFIRMED", startAt, endAt: new Date(+startAt + 1800000), appointmentFeeAmount: "100.00", guestAccessTokenHash: "secret-hash", ...extra } });
}

test("concurrent workers exclusively claim due rows and leave future/disabled rows queued", async () => {
  const row = await queue();
  const worker = service();
  const claims = await Promise.all(Array.from({ length: 8 }, () => worker.claim()));
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(claims.find(Boolean)!.attemptCount, 1);
  assert.equal(await worker.claim(), null);
  await worker.deliver(claims.find(Boolean)!);
  assert.equal((await stored(row.id)).status, "SENT"); assert.ok((await stored(row.id)).sentAt);
  await queue({ scheduledAt: new Date(Date.now() + 60000) });
  const sms = await queue({ channel: "SMS" });
  assert.equal(await service(undefined, { providers: { EMAIL: createTestNotificationProvider() } }).claim(), null);
  assert.equal(await service(undefined, { providers: {} }).claim(), null);
  assert.equal((await stored(sms.id)).attemptCount, 0);
});

test("bounded backoff retries transient failures, sanitizes errors and preserves business records", async () => {
  const booking = await appointment();
  const payment = await prisma.payment.create({ data: { appointmentId: booking.id, type: "APPOINTMENT_FEE", status: "SUCCEEDED", satisfiesObligation: true, amount: "100.00", method: "CASH", provider: "manual", idempotencyKey: randomUUID(), externalReference: randomUUID(), paidAt: new Date() } });
  const row = await queue({ appointmentId: booking.id });
  const worker = service({ async send() { throw new Error("secret recipient provider token"); } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await worker.processNext(); const result = await stored(row.id);
    assert.equal(result.attemptCount, attempt); assert.equal(result.lastError, "PROVIDER_UNAVAILABLE");
    assert.equal(result.status, attempt === 3 ? "FAILED" : "PENDING");
    if (attempt < 3) {
      assert.ok(+result.scheduledAt - +result.updatedAt >= 10000 * 2 ** (attempt - 1));
      assert.equal(await worker.processNext(), false);
      await prisma.notificationQueue.update({ where: { id: row.id }, data: { scheduledAt: new Date(0) } });
    }
  }
  assert.equal(await worker.processNext(), false);
  assert.deepEqual(await prisma.appointment.findUnique({ where: { id: booking.id } }), booking);
  assert.deepEqual(await prisma.payment.findUnique({ where: { id: payment.id } }), payment);
});

test("permanent payload and provider errors fail once; hung providers time out", async () => {
  const row = await queue({ payload: { schemaVersion: 999 } });
  await service({ async send() { assert.fail("invalid payload must not send"); } }).processNext();
  assert.equal((await stored(row.id)).lastError, "INVALID_PAYLOAD");
  const rejected = await queue();
  await service({ async send() { throw new NotificationFailure("PROVIDER_HTTP_400", false); } }).processNext();
  assert.equal((await stored(rejected.id)).status, "FAILED");
  const hung = await queue(); let aborted = false;
  await service({ async send(_message, signal) { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); } }, { timeoutMs: 20 }).processNext();
  assert.equal(aborted, true); assert.equal((await stored(hung.id)).lastError, "PROVIDER_TIMEOUT");
});

test("abandoned leases recover with a new generation and exhausted crashes terminate", async () => {
  const row = await queue(); const worker = service();
  const first = (await worker.claim())!; assert.equal(first.attemptCount, 1);
  assert.equal(await worker.claim(), null);
  await expire(row.id);
  await worker.deliver(first); assert.equal((await stored(row.id)).status, "PROCESSING");
  const second = (await worker.claim())!;
  assert.equal(second.attemptCount, 2);
  await worker.deliver(first); assert.equal((await stored(row.id)).status, "PROCESSING");
  await expire(row.id); assert.equal((await worker.claim())!.attemptCount, 3);
  await expire(row.id); const exhausted = (await worker.claim())!;
  assert.equal(exhausted.status, "FAILED"); assert.equal(exhausted.attemptCount, 3);
  assert.equal(exhausted.lastError, "ATTEMPTS_EXHAUSTED"); assert.equal(await worker.claim(), null);
});

test("late success and late failure cannot overwrite a newer completed attempt", async () => {
  for (const failure of [false, true]) {
    const row = await queue();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const old = service({ async send() { entered(); await blocked; if (failure) throw new Error("late error"); } }, { timeoutMs: 5000, leaseMs: 10000 });
    const first = (await old.claim())!;
    const delivery = old.deliver(first); await started;
    await expire(row.id); const fresh = service(); const replacement = (await fresh.claim())!;
    assert.equal(replacement.attemptCount, 2); await fresh.deliver(replacement);
    const expected = await stored(row.id); release(); await delivery;
    assert.deepEqual(await stored(row.id), expected); assert.equal(expected.status, "SENT");
  }
});

test("crash after provider acceptance reuses queue identity on recovery", async () => {
  const accepted = new Set<string>(); let calls = 0;
  const provider = createTestNotificationProvider(m => { calls++; accepted.add(m.id); });
  const row = await queue(); const worker = service(provider);
  const first = (await worker.claim())!;
  // Simulate external acceptance followed by process loss before SENT is persisted.
  await provider.send({ id: first.id, channel: first.channel, recipient: first.recipient, subject: "Booking confirmed", text: "text" }, new AbortController().signal);
  await expire(row.id); await worker.processNext();
  assert.equal(calls, 2); assert.equal(accepted.size, 1); assert.equal((await stored(row.id)).status, "SENT");
});

test("concurrent reminder scans deduplicate each schedule revision and respect eligibility", async () => {
  const email = await appointment(); const sms = await appointment({}, null);
  for (const status of ["PENDING_PAYMENT", "CANCELLED", "EXPIRED", "NO_SHOW", "COMPLETED"]) await appointment({ status });
  await appointment({ startAt: new Date(Date.now() - 1000) });
  await appointment({ startAt: new Date(Date.now() + 25 * 3600000) });
  const worker = service();
  const counts = await Promise.all([worker.enqueueReminders(), worker.enqueueReminders(), worker.enqueueReminders()]);
  assert.equal(counts.reduce((a, b) => a + b), 1);
  assert.equal(await worker.enqueueReminders(), 0);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: email.id } }), 0);
  assert.equal((await prisma.notificationQueue.findFirstOrThrow({ where: { appointmentId: sms.id } })).channel, "SMS");
  while (await worker.processNext()) { /* drain */ }
  assert.equal(await worker.enqueueReminders(), 0);
  await prisma.appointment.update({ where: { id: sms.id }, data: { rescheduleCount: { increment: 1 }, startAt: new Date(+sms.startAt + 3600000) } });
  assert.equal(await worker.enqueueReminders(), 1);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: sms.id } }), 2);
});

test("cancelled, rescheduled and already-started reminders are suppressed before sending", async () => {
  for (const change of [{ status: "CANCELLED" as const }, { rescheduleCount: 1 }, { startAt: new Date(Date.now() - 1000) }]) {
    const booking = await appointment({}, null); const worker = service({ async send() { assert.fail("obsolete reminder must not send"); } });
    await worker.enqueueReminders();
    await prisma.appointment.update({ where: { id: booking.id }, data: change });
    await worker.processNext();
    const row = await prisma.notificationQueue.findFirstOrThrow({ where: { appointmentId: booking.id } });
    assert.equal(row.status, "FAILED"); assert.equal(row.lastError, "REMINDER_OBSOLETE");
    await prisma.appointment.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
  }
});

test("reminder scans skip locked appointments and disabled reminders create no rows", async () => {
  const booking = await appointment({}, null); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transaction = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Appointment" WHERE "id" = ${booking.id}::uuid FOR UPDATE`;
    entered(); await blocked;
    await tx.appointment.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
  });
  await started;
  try { assert.equal(await service().enqueueReminders(), 0); } finally { release(); await transaction; }
  assert.equal(await service().enqueueReminders(), 0);
  await appointment(); assert.equal(await service(undefined, { reminderHours: 0 }).enqueueReminders(), 0);
});

test("reminder pagination progresses past existing rows", async () => {
  await appointment({}, null); await appointment({}, null); await appointment({}, null);
  const worker = service();
  assert.equal(await worker.enqueueReminders(2), 2);
  assert.equal(await worker.enqueueReminders(2), 1);
  assert.equal(await worker.enqueueReminders(2), 0);
});

test("minimal SMS sends one combined confirmation and skips old separate notifications", async () => {
  const booking = await appointment({}, null);
  await prisma.payment.create({ data: { appointmentId: booking.id, type: "APPOINTMENT_FEE", status: "SUCCEEDED", satisfiesObligation: true, amount: "100.00", method: "CASH", provider: "manual", idempotencyKey: randomUUID(), externalReference: randomUUID(), paidAt: new Date() } });
  const confirmation = await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567" });
  const others = [];
  for (const eventType of ["PAYMENT_RECEIVED", "APPOINTMENT_COMPLETED", "APPOINTMENT_REMINDER"]) others.push(await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567", eventType }));
  const messages: NotificationMessage[] = [];
  const worker = service(createTestNotificationProvider(m => messages.push(m)), { smsPolicy: "minimal", publicSiteUrl: "https://salon.example.com", bookingLinkSecret: "s".repeat(32) });
  while (await worker.processNext()) { /* drain without real SMS */ }
  assert.equal(messages.length, 1); assert.match(messages[0]!.text, /^Hello, Test Guest!\n\nYour appointment at Clique Salon has been successfully confirmed, and your appointment fee has been received\./);
  assert.equal((await stored(confirmation.id)).status, "SENT");
  for (const row of others) { assert.equal((await stored(row.id)).status, "SKIPPED"); assert.equal((await stored(row.id)).lastError, "SMS_MINIMAL_POLICY"); }
  assert.ok(messages[0]!.text.includes(booking.bookingCode));
  assert.doesNotMatch(messages[0]!.text, /https?:|Private link/);
  assert.equal(await prisma.appointmentGuestSession.count({ where: { appointmentId: booking.id } }), 0);
});

test("minimal policy generates no separate reminders and preserves SMS cancellation notices", async () => {
  const smsBooking = await appointment({}, null); await appointment();
  const messages: NotificationMessage[] = [];
  const worker = service(createTestNotificationProvider(m => messages.push(m)), { smsPolicy: "minimal" });
  assert.equal(await worker.enqueueReminders(), 0);
  assert.equal(await prisma.notificationQueue.count({ where: { channel: "SMS", eventType: "APPOINTMENT_REMINDER" } }), 0);
  await queue({ appointmentId: smsBooking.id, channel: "SMS", recipient: "09171234567", eventType: "BOOKING_CANCELLED" });
  while (await worker.processNext()) { /* drain */ }
  assert.equal(messages.filter(m => m.channel === "SMS").length, 1);
  assert.match(messages.find(m => m.channel === "SMS")!.text, /cancelled/);
});

test("every SMS policy requires verified fee payment before sending the personalized confirmation", async () => {
  for (const smsPolicy of ["minimal", "single", "all"] as const) {
    const booking = await appointment({}, null);
    const messages: NotificationMessage[] = [];
    const worker = service(createTestNotificationProvider(m => messages.push(m)), { smsPolicy });
    const unpaid = await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567" });
    await worker.processNext();
    assert.equal((await stored(unpaid.id)).lastError, "CONFIRMATION_PAYMENT_UNVERIFIED");
    assert.equal(messages.length, 0);
    await prisma.payment.create({ data: { appointmentId: booking.id, type: "APPOINTMENT_FEE", status: "SUCCEEDED", satisfiesObligation: true, amount: "100.00", method: "CASH", provider: "manual", idempotencyKey: randomUUID(), externalReference: randomUUID(), paidAt: new Date() } });
    await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567" });
    await worker.processNext();
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.text, /^Hello, Test Guest!/);
    assert.ok(messages[0]!.text.includes(`Reference Number: ${booking.bookingCode}`));
    assert.match(messages[0]!.text, /Time: \d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/);
  }
});

test("minimal SMS avoids retries on uncertain delivery or reclaimed claims", async () => {
  let calls = 0;
  const worker = service({ async send() { calls++; throw new Error("uncertain timeout"); } }, { smsPolicy: "minimal" });
  const failed = await queue({ channel: "SMS", recipient: "09171234567", eventType: "BOOKING_CANCELLED" });
  await worker.processNext(); assert.equal((await stored(failed.id)).status, "FAILED");
  assert.equal(await worker.processNext(), false); assert.equal(calls, 1);
  const abandoned = await queue({ channel: "SMS", recipient: "09171234567", eventType: "BOOKING_CANCELLED" });
  await worker.claim(); await expire(abandoned.id); await worker.processNext();
  assert.equal((await stored(abandoned.id)).status, "SKIPPED"); assert.equal((await stored(abandoned.id)).lastError, "SMS_DELIVERY_UNCERTAIN");
  assert.equal(calls, 1);
});

test("obsolete confirmation never sends a misleading message or creates a link", async () => {
  const booking = await appointment({ status: "CANCELLED" }, null);
  const row = await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567" });
  await service({ async send() { assert.fail("obsolete confirmation"); } }, { smsPolicy: "minimal" }).processNext();
  assert.equal((await stored(row.id)).status, "SKIPPED");
  assert.equal((await stored(row.id)).lastError, "CONFIRMATION_OBSOLETE");
});


test("email sends one confirmation including payment and reminder, suppressing paired legacy payment and queued reminder", async () => {
  const booking = await appointment();
  const payload = { schemaVersion: 1, bookingCode: booking.bookingCode, paymentId: randomUUID(),
    appointmentStatus: "CONFIRMED", reconciliationRequired: false, startAt: booking.startAt.toISOString() };
  const payment = await queue({ appointmentId: booking.id, eventType: "PAYMENT_RECEIVED", payload });
  const confirmation = await queue({ appointmentId: booking.id, eventType: "BOOKING_CONFIRMED", payload });
  const reminder = await queue({ appointmentId: booking.id, eventType: "APPOINTMENT_REMINDER", payload: { ...payload, rescheduleCount: 0 } });
  const messages: NotificationMessage[] = [];
  const worker = service(createTestNotificationProvider(m => messages.push(m)));
  assert.equal(await worker.enqueueReminders(), 0);
  while (await worker.processNext()) {}
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.subject, /Payment received.*confirmed/);
  assert.match(messages[0]!.text, /fee has been received/);
  assert.match(messages[0]!.text, /Asia\/Manila/);
  assert.match(messages[0]!.text, /Appointment reminder: Please arrive 10 minutes early/);
  assert.equal((await stored(confirmation.id)).status, "SENT");
  assert.equal((await stored(payment.id)).lastError, "EMAIL_COMBINED_WITH_CONFIRMATION");
  assert.equal((await stored(reminder.id)).lastError, "EMAIL_REMINDER_INCLUDED_IN_CONFIRMATION");
  assert.equal(await worker.processNext(), false);
});

test("email payment notices without a matching confirmation and reconciliation exceptions are preserved", async () => {
  const booking = await appointment();
  const payload = { schemaVersion: 1, bookingCode: booking.bookingCode, paymentId: randomUUID(), appointmentStatus: "CONFIRMED", reconciliationRequired: false };
  await queue({ appointmentId: booking.id, eventType: "BOOKING_CONFIRMED", payload: { ...payload, paymentId: randomUUID() } });
  const standalone = await queue({ appointmentId: booking.id, eventType: "PAYMENT_RECEIVED", payload });
  const review = await queue({ appointmentId: booking.id, eventType: "PAYMENT_RECEIVED", payload: { ...payload, reconciliationRequired: true } });
  const messages: NotificationMessage[] = [];
  const worker = service(createTestNotificationProvider(m => messages.push(m)));
  while (await worker.processNext()) {}
  assert.equal((await stored(standalone.id)).status, "SENT");
  assert.equal((await stored(review.id)).status, "SENT");
  assert.match(messages.find(m => m.id === review.id)!.text, /does not confirm/);
});

test("single policy allows one confirmation across concurrent workers and suppresses later events", async () => {
  const booking = await appointment({}, null);
  await prisma.payment.create({ data: { appointmentId: booking.id, type: "APPOINTMENT_FEE", status: "SUCCEEDED", satisfiesObligation: true, amount: "100.00", method: "CASH", provider: "manual", idempotencyKey: randomUUID(), externalReference: randomUUID(), paidAt: new Date() } });
  const messages: NotificationMessage[] = [];
  const worker = service(createTestNotificationProvider(m => messages.push(m)), { smsPolicy: "single", publicSiteUrl: undefined, bookingLinkSecret: undefined });
  for (let i = 0; i < 3; i++) await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567" });
  await Promise.all(Array.from({ length: 3 }, () => worker.processNext()));
  assert.equal(messages.length, 1);
  assert.equal(await prisma.notificationQueue.count({ where: { status: "SKIPPED", lastError: "SMS_BOOKING_LIMIT" } }), 2);
  for (const eventType of ["BOOKING_RESCHEDULED", "BOOKING_CANCELLED", "NO_SHOW_RECOVERY_CREATED", "PAYMENT_RECEIVED", "APPOINTMENT_COMPLETED", "APPOINTMENT_REMINDER"]) {
    const row = await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567", eventType });
    await worker.processNext();
    assert.equal((await stored(row.id)).lastError, "SMS_SINGLE_POLICY");
  }
  const duplicate = await queue({ appointmentId: booking.id, channel: "SMS", recipient: "09171234567" });
  await worker.processNext();
  assert.equal((await stored(duplicate.id)).lastError, "SMS_BOOKING_LIMIT");
  const email = await queue({ appointmentId: booking.id });
  await worker.processNext();
  assert.equal((await stored(email.id)).status, "SENT");
  assert.equal(messages.filter(m => m.channel === "SMS").length, 1);
});

test("single policy does not send another SMS after a prior failed attempt", async () => {
  const booking = await appointment({}, null);
  await queue({ appointmentId: booking.id, channel: "SMS", status: "FAILED", lastError: "PROVIDER_TIMEOUT", attemptCount: 1 });
  const duplicate = await queue({ appointmentId: booking.id, channel: "SMS" });
  let calls = 0;
  await service(createTestNotificationProvider(() => { calls++; }), { smsPolicy: "single" }).processNext();
  assert.equal(calls, 0);
  assert.equal((await stored(duplicate.id)).lastError, "SMS_BOOKING_LIMIT");
});
