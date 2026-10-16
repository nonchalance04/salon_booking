import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

import { createApiRouter } from "../../src/app/routes.js";
import { createApp } from "../../src/app/app.js";
import { parseEnv } from "../../src/config/env.schema.js";
import { ApiError } from "../../src/shared/http.js";
import { days } from "../../src/modules/configuration/configuration.schema.js";






const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL is required for disposable PostgreSQL tests.");
const dbName = `salon_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl); url.pathname = `/${dbName}`; url.searchParams.delete("schema");
const adminPool = new Pool({ connectionString: adminUrl });
const pool = createDatabasePool(url.toString(), { application_name: "phase8-configuration" });
const observer = new Pool({ connectionString: url.toString(), application_name: "phase8-observer" });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const run = promisify(execFile);
let adminId = "";
let cashierId = "";
let created = false;
before(async () => {
  await adminPool.query(`CREATE DATABASE "${dbName}"`); created = true;
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url.toString(), SEED_ADMIN_EMAIL: "admin@example.test", SEED_ADMIN_PASSWORD: "phase8-admin-password", SEED_CASHIER_EMAIL: "cashier@example.test", SEED_CASHIER_PASSWORD: "phase8-cashier-password" };
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
      for (let i = 0; i < 100 && (await adminPool.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [dbName])).rowCount; i++) await delay(20);
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
import { createSettlementService } from "../../src/modules/settlement/settlement.service.js";
import { createTokenService } from "../../src/modules/auth/auth.token.js";
const settlement = createSettlementService(prisma);
async function recorded(outcome: "PERFORMED" | "NOT_PERFORMED" = "PERFORMED") {
  const f = await fixture(); const row = await settlement.lookup(cashierId, f.booking.bookingCode);
  const saved = await settlement.outcomes(adminId, { bookingCode: row.bookingCode, revision: row.revision, services: row.services.map(s => ({ id: s.id, outcome })) });
  return { ...f, saved };
}
function pay(row: { bookingCode: string; revision: string; amountDue: string }) { return { bookingCode: row.bookingCode, revision: row.revision, idempotencyKey: randomUUID(), amount: row.amountDue, currency: "PHP" as const, method: "CASH" as const, externalReference: randomUUID() }; }
async function fee(appointmentId: string, amount = "100.00", extra = {}) { return prisma.payment.create({ data: { appointmentId, type: "APPOINTMENT_FEE", status: "SUCCEEDED", satisfiesObligation: true, amount, method: "CASH", provider: "manual", idempotencyKey: randomUUID(), externalReference: randomUUID(), paidAt: new Date(), ...extra } }); }

test("settlement retries atomically create one payment, receipt, commissions and completion", async () => {
  const f = await recorded(); await fee(f.booking.id); const input = pay(f.saved);
  const results = await Promise.all([settlement.settle(cashierId, input), settlement.settle(cashierId, input)]);
  assert.equal(results[0].status, "COMPLETED"); assert.equal(results[1].status, "COMPLETED");
  const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: f.booking.id, type: "SERVICE_PAYMENT" }, include: { receipt: true } });
  assert.equal(payment.amount.toFixed(2), "120.00"); assert.ok(payment.receipt);
  const commissions = await prisma.commissionRecord.findMany({ where: { appointmentId: f.booking.id } });
  assert.equal(commissions.length, 1); assert.equal(commissions[0]!.commissionAmount.toFixed(2), "88.00");
  assert.equal(await prisma.payment.count({ where: { appointmentId: f.booking.id, type: "SERVICE_PAYMENT" } }), 1);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.booking.id } }), 2);
  assert.ok((await prisma.appointmentService.findFirstOrThrow({ where: { appointmentId: f.booking.id } })).outcomeFinalizedAt);
  await settlement.settle(cashierId, { ...input, idempotencyKey: randomUUID() });
  await assert.rejects(settlement.settle(cashierId, { ...input, amount: "121.00" }), (e: ApiError) => e.code === "PAYMENT_IDENTITY_CONFLICT");
  await assert.rejects(settlement.settle(cashierId, pay(f.saved)), (e: ApiError) => e.code === "SETTLEMENT_NOT_ALLOWED");
  await assert.rejects(settlement.outcomes(adminId, { bookingCode: f.saved.bookingCode, revision: results[0].revision, services: f.saved.services.map(s => ({ id: s.id, outcome: "NOT_PERFORMED" })) }));
  const view = await settlement.lookup(adminId, f.saved.bookingCode); assert.equal(view.commissions?.length, 1);
  assert.equal((await settlement.lookup(cashierId, f.saved.bookingCode)).commissions, undefined);
});

test("no-service closure retries create no payment receipt or commission and preserve fee", async () => {
  const f = await recorded("NOT_PERFORMED"); const original = await fee(f.booking.id);
  await Promise.all([settlement.close(adminId, { bookingCode: f.saved.bookingCode, revision: f.saved.revision }), settlement.close(adminId, { bookingCode: f.saved.bookingCode, revision: f.saved.revision })].map(p => p));
  assert.equal(await prisma.payment.count({ where: { appointmentId: f.booking.id } }), 1);
  assert.deepEqual(await prisma.payment.findUnique({ where: { id: original.id } }), original);
  assert.equal(await prisma.commissionRecord.count({ where: { appointmentId: f.booking.id } }), 0);
  assert.equal(await prisma.receipt.count({ where: { payment: { appointmentId: f.booking.id } } }), 0);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.booking.id } }), 1);
});

test("service settlement generates receipt references automatically for all methods and retains retry protection", async () => {
  const references = new Set<string>();
  for (const method of ["CASH", "GCASH", "OTHER"] as const) {
    const f = await recorded();
    const { externalReference: _unused, ...base } = pay(f.saved);
    const input = { ...base, method };
    await Promise.all([settlement.settle(cashierId, input), settlement.settle(cashierId, input)]);
    const saved = await prisma.payment.findFirstOrThrow({ where: { appointmentId: f.booking.id, type: "SERVICE_PAYMENT" }, include: { receipt: true } });
    assert.match(saved.externalReference!, /^SALON-SERVICE-[a-f0-9-]{36}$/);
    assert.equal((saved.receipt!.receiptSnapshot as { externalReference: string }).externalReference, saved.externalReference);
    references.add(saved.externalReference!);
    assert.equal(await prisma.payment.count({ where: { appointmentId: f.booking.id, type: "SERVICE_PAYMENT" } }), 1);
    assert.equal(await prisma.receipt.count({ where: { paymentId: saved.id } }), 1);
    await assert.rejects(settlement.settle(cashierId, { ...input, amount: "121.00" }), { code: "PAYMENT_IDENTITY_CONFLICT" });
  }
  assert.equal(references.size, 3);
});

test("outcome recording, corrections, stale review, full amount and role boundaries", async () => {
  const f = await fixture(); const row = await settlement.lookup(cashierId, f.booking.bookingCode);
  const input = { bookingCode: row.bookingCode, revision: row.revision, services: row.services.map(s => ({ id: s.id, outcome: "PERFORMED" as const })) };
  await assert.rejects(settlement.settle(cashierId, pay(row)), (e: ApiError) => e.code === "OUTCOMES_REQUIRED");
  const saved = await settlement.outcomes(adminId, input);
  await assert.rejects(settlement.settle(adminId, pay(saved)), (e: ApiError) => e.status === 403);
  await assert.rejects(settlement.settle(cashierId, { ...pay(saved), amount: "100.00" }), (e: ApiError) => e.code === "AMOUNT_MISMATCH");
  await assert.rejects(settlement.close(adminId, { bookingCode: saved.bookingCode, revision: saved.revision }));
  const change = { ...input, revision: saved.revision, services: input.services.map(s => ({ ...s, outcome: "NOT_PERFORMED" as const })) };
  const corrected = await settlement.outcomes(cashierId, change);
  await assert.rejects(settlement.settle(cashierId, pay(saved)), (e: ApiError) => e.code === "STALE_SETTLEMENT");
  await assert.rejects(settlement.close(cashierId, { bookingCode: corrected.bookingCode, revision: corrected.revision }), (e: ApiError) => e.status === 403);
  assert.equal((await settlement.close(adminId, { bookingCode: corrected.bookingCode, revision: corrected.revision })).status, "COMPLETED");
});

test("mixed outcomes exclude removed and not-performed rows; snapshots survive configuration changes", async () => {
  const f = await fixture(); const first = f.booking.appointmentServices[0]!;
  const { id, ...copy } = first;
  const second = await prisma.appointmentService.create({ data: { ...copy, sequenceNo: 2, priceSnapshot: "300.00" } });
  const removed = await prisma.appointmentService.create({ data: { ...copy, membershipStatus: "REMOVED", removedAt: new Date() } });
  let row = await settlement.lookup(cashierId, f.booking.bookingCode);
  await assert.rejects(settlement.outcomes(adminId, { bookingCode: row.bookingCode, revision: row.revision, services: [{ id: first.id, outcome: "PERFORMED" }, { id: removed.id, outcome: "PERFORMED" }] }));
  await assert.rejects(settlement.outcomes(adminId, { bookingCode: row.bookingCode, revision: row.revision, services: [{ id: first.id, outcome: "PERFORMED" }, { id: first.id, outcome: "PERFORMED" }] }));
  row = await settlement.outcomes(adminId, { bookingCode: row.bookingCode, revision: row.revision, services: [{ id: first.id, outcome: "PERFORMED" }, { id: second.id, outcome: "NOT_PERFORMED" }] });
  await prisma.service.update({ where: { id: f.item.id }, data: { price: "999.00", name: "Changed" } });
  await prisma.staffService.update({ where: { id: f.qualification.id }, data: { commissionRate: "0.9000" } });
  await settlement.settle(cashierId, pay(row));
  const commission = await prisma.commissionRecord.findFirstOrThrow({ where: { appointmentId: f.booking.id } });
  assert.equal(commission.serviceAmount.toFixed(2), "120.00"); assert.equal(commission.commissionRate.toFixed(4), "0.4000");
  assert.equal(await prisma.commissionRecord.count({ where: { appointmentId: f.booking.id } }), 1);
  assert.equal((await prisma.appointmentService.findUniqueOrThrow({ where: { id: removed.id } })).outcome, "SCHEDULED");
});

test("eligible carried credit allocates once; refunded and reconciliation money is excluded", async () => {
  const original = await fixture(); await prisma.appointment.update({ where: { id: original.booking.id }, data: { status: "NO_SHOW" } });
  const credit = await fee(original.booking.id);
  const f = await recorded(); await prisma.appointment.update({ where: { id: f.booking.id }, data: { recoveryOfAppointmentId: original.booking.id, carriedAppointmentFeePaymentId: credit.id } });
  let row = await settlement.lookup(cashierId, f.saved.bookingCode); await settlement.settle(cashierId, pay(row));
  assert.equal((await prisma.commissionRecord.findFirstOrThrow({ where: { appointmentId: f.booking.id } })).allocatedAppointmentFee.toFixed(2), "100.00");
  assert.equal(await prisma.payment.count({ where: { appointmentId: f.booking.id, type: "APPOINTMENT_FEE" } }), 0);
  for (const extra of [{ status: "REFUNDED", refundedAt: new Date() }, { satisfiesObligation: false, reconciliationStatus: "REQUIRED" }]) {
    const f2 = await recorded(); await fee(f2.booking.id, "100.00", extra); row = await settlement.lookup(cashierId, f2.saved.bookingCode);
    await settlement.settle(cashierId, pay(row));
    assert.equal((await prisma.commissionRecord.findFirstOrThrow({ where: { appointmentId: f2.booking.id } })).allocatedAppointmentFee.toFixed(2), "0.00");
  }
});

test("concurrent distinct collections and competing correction cannot finalize twice", async () => {
  const f = await recorded(); const results = await Promise.allSettled([settlement.settle(cashierId, pay(f.saved)), settlement.settle(cashierId, pay(f.saved))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const f2 = await recorded(); const correction = { bookingCode: f2.saved.bookingCode, revision: f2.saved.revision, services: f2.saved.services.map(s => ({ id: s.id, outcome: "NOT_PERFORMED" as const })) };
  const race = await Promise.allSettled([settlement.settle(cashierId, pay(f2.saved)), settlement.outcomes(adminId, correction)]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
});

test("outbox failure rolls back payment, receipt, commissions and finalization", async () => {
  const f = await recorded();
  await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_phase8_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_phase8_notification BEFORE INSERT ON "NotificationQueue" FOR EACH ROW EXECUTE FUNCTION reject_phase8_notification()`);
  try { await assert.rejects(settlement.settle(cashierId, pay(f.saved))); }
  finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_phase8_notification ON "NotificationQueue"'); await prisma.$executeRawUnsafe('DROP FUNCTION reject_phase8_notification()'); }
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).status, "CONFIRMED");
  assert.equal(await prisma.payment.count({ where: { appointmentId: f.booking.id } }), 0);
  assert.equal(await prisma.commissionRecord.count({ where: { appointmentId: f.booking.id } }), 0);
  assert.equal((await prisma.appointmentService.findFirstOrThrow({ where: { appointmentId: f.booking.id } })).outcomeFinalizedAt, null);
});

test("HTTP authentication, CSRF, role enforcement, and deactivated accounts protect settlement", async () => {
  const config = parseEnv({ NODE_ENV: "test", DATABASE_URL: url.toString(), JWT_SECRET: "phase8-test-jwt-secret-at-least-32-characters", TRUSTED_ORIGINS: "http://localhost:5173" });
  const app = createApp(createApiRouter(prisma, config)); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  const tokens = createTokenService(config.JWT_SECRET);
  const cashierToken = await tokens.sign({ userId: cashierId, role: "CASHIER" });
  const adminToken = await tokens.sign({ userId: adminId, role: "ADMIN" });
  const f = await recorded();
  async function request(path: string, body: unknown, token?: string, origin = "http://localhost:5173") {
    return fetch(`http://127.0.0.1:${port}/api/settlement/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Cookie: `salon_session=${token}` } : {}) }, body: JSON.stringify(body) });
  }
  try {
    assert.equal((await request("lookup", { bookingCode: f.saved.bookingCode })).status, 401);
    assert.equal((await request("lookup", { bookingCode: f.saved.bookingCode }, cashierToken, "https://evil.test")).status, 403);
    assert.equal((await request("pay", pay(f.saved), adminToken)).status, 403);
    assert.equal((await request("lookup", { bookingCode: f.saved.bookingCode }, cashierToken)).status, 200);
    assert.equal((await request("pay", { ...pay(f.saved), amount: 120 }, cashierToken)).status, 400);
    const outcomeInput = { bookingCode: f.saved.bookingCode, revision: f.saved.revision, services: f.saved.services.map(s => ({ id: s.id, outcome: "PERFORMED" as const })) };
    assert.equal((await request("outcomes", outcomeInput, cashierToken, "https://evil.test")).status, 403);
    assert.equal((await request("outcomes", { ...outcomeInput, actorUserId: adminId }, cashierToken)).status, 400);
    assert.equal((await request("close", { bookingCode: f.saved.bookingCode, revision: f.saved.revision }, cashierToken)).status, 403);
    assert.equal((await request("outcomes", outcomeInput, cashierToken)).status, 200);
    const current = await settlement.lookup(cashierId, f.saved.bookingCode);
    assert.equal((await request("pay", pay(current), cashierToken)).status, 200);
    await prisma.user.update({ where: { id: cashierId }, data: { isActive: false } });
    assert.equal((await request("lookup", { bookingCode: f.saved.bookingCode }, cashierToken)).status, 401);
    await assert.rejects(settlement.settle(cashierId, pay(f.saved)), (e: ApiError) => e.status === 401);
    assert.equal((await request("outcomes", outcomeInput, cashierToken)).status, 401);
    await assert.rejects(settlement.outcomes(cashierId, outcomeInput), (e: ApiError) => e.status === 401);
  } finally { await prisma.user.update({ where: { id: cashierId }, data: { isActive: true } }); server.close(); await once(server, "close"); }
});

test("persisted multi-service totals reconcile and receipt snapshots stay immutable", async () => {
  const f = await fixture(); const first = f.booking.appointmentServices[0]!;
  await prisma.appointmentService.update({ where: { id: first.id }, data: { priceSnapshot: "500.00" } });
  const { id, ...copy } = first;
  await prisma.appointmentService.create({ data: { ...copy, sequenceNo: 2, priceSnapshot: "1000.00" } });
  const initial = await settlement.lookup(cashierId, f.booking.bookingCode);
  const row = await settlement.outcomes(adminId, { bookingCode: initial.bookingCode, revision: initial.revision, services: initial.services.map(s => ({ id: s.id, outcome: "PERFORMED" })) });
  await fee(f.booking.id); await settlement.settle(cashierId, pay(row));
  const totals = await prisma.commissionRecord.aggregate({ where: { appointmentId: f.booking.id }, _sum: { serviceAmount: true, allocatedAppointmentFee: true, commissionBase: true, commissionAmount: true } });
  assert.equal(totals._sum.serviceAmount?.toFixed(2), "1500.00"); assert.equal(totals._sum.allocatedAppointmentFee?.toFixed(2), "100.00");
  assert.equal(totals._sum.commissionBase?.toFixed(2), "1600.00"); assert.equal(totals._sum.commissionAmount?.toFixed(2), "640.00");
  const receipt = await prisma.receipt.findFirstOrThrow({ where: { payment: { appointmentId: f.booking.id, type: "SERVICE_PAYMENT" } } });
  await prisma.customer.update({ where: { id: f.booking.customerId }, data: { firstName: "New name" } });
  await prisma.service.update({ where: { id: f.item.id }, data: { name: "New service", price: "999.00" } });
  assert.deepEqual((await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).receiptSnapshot, receipt.receiptSnapshot);
});

test("no-service outbox failure rolls back closure and leaves outcomes editable by Admin", async () => {
  const f = await recorded("NOT_PERFORMED");
  await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_phase8_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_phase8_close BEFORE INSERT ON "NotificationQueue" FOR EACH ROW EXECUTE FUNCTION reject_phase8_close()`);
  try { await assert.rejects(settlement.close(adminId, { bookingCode: f.saved.bookingCode, revision: f.saved.revision })); }
  finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_phase8_close ON "NotificationQueue"'); await prisma.$executeRawUnsafe('DROP FUNCTION reject_phase8_close()'); }
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).completionType, null);
  assert.equal((await prisma.appointmentService.findFirstOrThrow({ where: { appointmentId: f.booking.id } })).outcomeFinalizedAt, null);
  const row = await settlement.lookup(adminId, f.saved.bookingCode);
  await settlement.outcomes(adminId, { bookingCode: row.bookingCode, revision: row.revision, services: row.services.map(s => ({ id: s.id, outcome: "PERFORMED" })) });
});


test("Cashier records and corrects outcomes with audit attribution and cannot edit finalized services", async () => {
  const f = await fixture();
  const initial = await settlement.lookup(cashierId, f.booking.bookingCode);
  const input = { bookingCode: initial.bookingCode, revision: initial.revision, services: initial.services.map(s => ({ id: s.id, outcome: "NOT_PERFORMED" as const })) };
  const saved = await settlement.outcomes(cashierId, input);
  assert.equal(saved.services[0]!.outcome, "NOT_PERFORMED");
  const corrected = await settlement.outcomes(cashierId, { ...input, revision: saved.revision, services: input.services.map(s => ({ ...s, outcome: "PERFORMED" as const })) });
  assert.equal(corrected.services[0]!.outcome, "PERFORMED");
  assert.equal("commissions" in corrected, false);
  const audits = await prisma.auditLog.findMany({ where: { entityId: f.booking.id, action: "SERVICE_OUTCOMES_RECORDED" } });
  assert.equal(audits.length, 2);
  assert.ok(audits.every(a => a.actorType === "CASHIER" && a.actorUserId === cashierId));
  await assert.rejects(settlement.outcomes(cashierId, input), { code: "STALE_SETTLEMENT" });
  await settlement.settle(cashierId, pay(corrected));
  const completed = await settlement.lookup(cashierId, corrected.bookingCode);
  await assert.rejects(settlement.outcomes(cashierId, { ...input, revision: completed.revision }));
});
