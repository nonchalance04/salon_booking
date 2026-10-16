import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { before, after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { Temporal } from "@js-temporal/polyfill";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createDatabasePool } from "../../src/database/pool.js";
import { createReportsService } from "../../src/modules/reports/reports.service.js";
import { createAppointmentChangesService } from "../../src/modules/appointments/appointment-changes.service.js";
import { appointmentListQuery } from "../../src/modules/appointments/appointments.schema.js";
import { confirmedServicesQuery, reportQuery } from "../../src/modules/reports/reports.schema.js";
import { createApp } from "../../src/app/app.js";
import { createApiRouter } from "../../src/app/routes.js";
import { createTokenService } from "../../src/modules/auth/auth.token.js";
import { parseEnv } from "../../src/config/env.schema.js";
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
after(async () => {
  await prisma.$disconnect(); await pool.end();
  try {
    if (created) {
      for (let i = 0; i < 100 && (await adminPool.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [dbName])).rowCount; i++) await delay(20);
      await adminPool.query(`DROP DATABASE "${dbName}"`);
    }
  } finally { await adminPool.end(); }
});
const reports = createReportsService(prisma, "Asia/Manila");
const q = reportQuery.parse({ from: "2026-10-04", to: "2026-10-04" });
const day = new Date("2026-10-04T00:00:00Z");
async function actor(role: "ADMIN" | "CASHIER" = "ADMIN") { return prisma.user.findFirstOrThrow({ where: { role } }); }
async function appointment(extra: object = {}) {
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow();
  return prisma.appointment.create({ data: { bookingCode: randomUUID(), customer: { create: { firstName: "Test", lastName: "Guest", phone: "0" } }, bookingPolicyVersion: { connect: { id: policy.id } }, status: "CONFIRMED", startAt: day, endAt: new Date(+day + 1800000), appointmentFeeAmount: "100.00", guestAccessTokenHash: "never-expose", ...extra } });
}
async function payment(appointmentId: string, amount: string, extra: object = {}) {
  return prisma.payment.create({ data: { appointmentId, amount, type: "APPOINTMENT_FEE", method: "CASH", status: "SUCCEEDED", provider: "manual", idempotencyKey: randomUUID(), externalReference: randomUUID(), paidAt: day, createdAt: day, ...extra } });
}

test("collections reconcile exact capture/refund movement without counting carried credits or failed attempts", async () => {
  const admin = await actor(); const original = await appointment({ status: "NO_SHOW" });
  const fee = await payment(original.id, "100.10", { satisfiesObligation: true });
  await appointment({ recoveryOfAppointment: { connect: { id: original.id } }, carriedAppointmentFeePayment: { connect: { id: fee.id } } });
  await payment(original.id, "20.20", { reconciliationStatus: "REQUIRED", reconciliationReason: "Late capture" });
  await payment(original.id, "3.03", { reconciliationStatus: "RESOLVED" });
  await payment(original.id, "500.00", { status: "FAILED", paidAt: null });
  await payment(original.id, "600.00", { status: "PENDING", paidAt: null });
  await payment(original.id, "4.04", { status: "REFUNDED", refundedAt: day });
  await payment(original.id, "5.05", { status: "REFUNDED", paidAt: new Date("2026-10-02T00:00Z"), refundedAt: day });
  await payment(original.id, "6.06", { status: "REFUNDED", refundedAt: new Date("2026-10-06T00:00Z") });
  // Inclusive local start, exclusive next-day start.
  await payment(original.id, "0.01", { paidAt: new Date("2026-10-03T16:00Z") });
  await payment(original.id, "900.00", { paidAt: new Date("2026-10-04T16:00Z") });
  await payment(original.id, "800.00", { paidAt: new Date("2026-10-03T15:59:59.999Z") });
  const result = await reports.collections(admin.id, q);
  assert.deepEqual(result.totals, [{ currency: "PHP", captured: "133.44", refunded: "9.09", netCashMovement: "124.35", successfulApplied: "100.10", successfulUnapplied: "23.24", reconciliationRequired: "20.20" }]);
  const cashier = await actor("CASHIER");
  assert.deepEqual(await reports.collections(cashier.id, q), result);
  assert.equal(JSON.stringify(result).includes("never-expose"), false);
});

test("reports preserve service, receipt and commission snapshots after catalog changes", async () => {
  const admin = await actor(); const a = await appointment();
  const staff = await prisma.staff.create({ data: { firstName: "Historical", lastName: "Staff" } });
  const service = await prisma.service.create({ data: { name: "Old service", price: "50.00", durationMinutes: 30 } });
  const item = await prisma.appointmentService.create({ data: { appointmentId: a.id, staffId: staff.id, serviceId: service.id, assignmentMode: "SPECIFIC", sequenceNo: 1, serviceNameSnapshot: "Old service", priceSnapshot: "50.00", durationMinutesSnapshot: 30, bufferMinutesSnapshot: 0, commissionRateSnapshot: "0.4", scheduledStartAt: a.startAt, scheduledEndAt: a.endAt, reservedUntilAt: a.endAt, outcome: "PERFORMED", actualChargedAmount: "50.00" } });
  const p = await payment(a.id, "50.00", { type: "SERVICE_PAYMENT", satisfiesObligation: true, paidAt: new Date("2026-11-01T00:00Z") });
  await prisma.receipt.create({ data: { paymentId: p.id, receiptNumber: randomUUID(), issuedByUserId: admin.id, issuedAt: day, receiptSnapshot: { name: "Old service", amount: "50.00" } } });
  await prisma.commissionRecord.create({ data: { appointmentId: a.id, appointmentServiceId: item.id, staffId: staff.id, sourcePaymentId: p.id, serviceAmount: "50.00", allocatedAppointmentFee: "0.00", commissionBase: "50.00", commissionRate: "0.4", commissionAmount: "20.00", finalizedByUserId: admin.id, finalizedAt: day } });
  await prisma.service.update({ where: { id: service.id }, data: { name: "New name", price: "999.00", isActive: false } });
  for (const kind of ["appointments", "receipts", "commissions"] as const) {
    const result = await reports.list(admin.id, kind, q);
    assert.match(JSON.stringify(result.rows), /Old service/); assert.doesNotMatch(JSON.stringify(result.rows), /New name|never-expose|"999(?:\.00)?"/);
  }
  const dashboard = await reports.dashboard(admin.id, q);
  assert.equal(dashboard.finalizedCommissions, "20.00");
  const first = await reports.list(admin.id, "payments", { ...q, pageSize: 1 });
  const second = await reports.list(admin.id, "payments", { ...q, pageSize: 1, page: 2 });
  assert.equal(first.rows.length, 1); assert.notDeepEqual(first.rows, second.rows); assert.equal(first.total, second.total);
});

test("cashier queue uses salon dates, paginates and only exposes settlement information", async () => {
  const cashier = await actor("CASHIER");
  const queueQuery = reportQuery.parse({ from: "2026-10-07", to: "2026-10-07", pageSize: 1 });
  await appointment({ startAt: new Date("2026-10-06T16:00Z"), status: "CONFIRMED" });
  await appointment({ startAt: new Date("2026-10-07T00:00Z"), status: "COMPLETED", completionType: "NO_SERVICE_CLOSURE" });
  await appointment({ startAt: new Date("2026-10-07T16:00Z"), status: "CONFIRMED" });
  await appointment({ startAt: new Date("2026-10-07T00:00Z"), status: "CANCELLED" });
  const first = await reports.cashierQueue(cashier.id, queueQuery);
  const second = await reports.cashierQueue(cashier.id, { ...queueQuery, page: 2 });
  assert.equal(first.total, 2); assert.equal(first.awaitingSettlement, 1); assert.equal(first.completed, 1);
  assert.equal(first.rows.length, 1); assert.notEqual(first.rows[0]!.bookingCode, second.rows[0]!.bookingCode);
  assert.doesNotMatch(JSON.stringify(first), /guestAccess|commission|password|phone|email/);
  await prisma.user.update({ where: { id: cashier.id }, data: { isActive: false } });
  try { await assert.rejects(reports.cashierQueue(cashier.id, queueQuery), { code: "UNAUTHORIZED" }); }
  finally { await prisma.user.update({ where: { id: cashier.id }, data: { isActive: true } }); }
});

test("confirmed services load across all dates for both roles, with search, pagination and current status", async () => {
  const admin = await actor(); const cashier = await actor("CASHIER");
  const prefix = `confirmed-${randomUUID()}`;
  const first = await appointment({ bookingCode: `${prefix}-past`, startAt: new Date("2025-01-01T00:00Z"), customer: { create: { firstName: "QueueJamie", lastName: "QueueSantos", phone: "private-phone" } } });
  const second = await appointment({ bookingCode: `${prefix}-future`, startAt: new Date("2028-01-01T00:00Z") });
  for (const status of ["COMPLETED", "CANCELLED", "PENDING_PAYMENT", "NO_SHOW", "EXPIRED"] as const) await appointment({ bookingCode: `${prefix}-${status}`, status });
  const staff = await prisma.staff.create({ data: { firstName: "Queue", lastName: "Stylist" } });
  const service = await prisma.service.create({ data: { name: "Confirmed haircut", price: "50.00", durationMinutes: 30 } });
  const serviceData = { appointmentId: first.id, staffId: staff.id, serviceId: service.id, assignmentMode: "SPECIFIC" as const, sequenceNo: 1, serviceNameSnapshot: "Confirmed haircut", priceSnapshot: "50.00", durationMinutesSnapshot: 30, bufferMinutesSnapshot: 0, commissionRateSnapshot: "0.4", scheduledStartAt: first.startAt, scheduledEndAt: new Date(+first.startAt + 1800000), reservedUntilAt: new Date(+first.startAt + 1800000) };
  await prisma.appointmentService.create({ data: serviceData });
  await prisma.appointmentService.create({ data: { ...serviceData, sequenceNo: 2, membershipStatus: "REMOVED", serviceNameSnapshot: "Removed service" } });
  const query = confirmedServicesQuery.parse({ search: prefix, pageSize: 1 });
  const result = await reports.confirmedServices(cashier.id, query);
  assert.deepEqual(await reports.confirmedServices(admin.id, query), result);
  assert.equal(result.total, 2); assert.equal(result.rows[0]!.bookingCode, first.bookingCode);
  assert.equal(result.rows[0]!.appointmentServices.length, 1);
  assert.equal(result.rows[0]!.appointmentServices[0]!.priceSnapshot, "50.00");
  assert.equal(result.rows[0]!.appointmentServices[0]!.staff.lastName, "Stylist");
  assert.equal((await reports.confirmedServices(cashier.id, { ...query, page: 2 })).rows[0]!.bookingCode, second.bookingCode);
  assert.equal((await reports.confirmedServices(cashier.id, { ...query, search: "queuejamie queuesantos" })).rows[0]!.bookingCode, first.bookingCode);
  assert.doesNotMatch(JSON.stringify(result), /private-phone|guestAccess|commission|password|Removed service/);
  const paymentQuery = { ...query, paymentReady: "true" as const };
  assert.equal((await reports.confirmedServices(cashier.id, paymentQuery)).total, 0);
  await prisma.appointmentService.updateMany({ where: { appointmentId: first.id, membershipStatus: "ACTIVE" }, data: { outcome: "NOT_PERFORMED", actualChargedAmount: "0" } });
  assert.equal((await reports.confirmedServices(cashier.id, paymentQuery)).total, 0);
  await prisma.appointmentService.updateMany({ where: { appointmentId: first.id, membershipStatus: "ACTIVE" }, data: { outcome: "PERFORMED", actualChargedAmount: "50" } });
  const ready = await reports.confirmedServices(cashier.id, paymentQuery);
  assert.equal(ready.total, 1); assert.equal(ready.rows[0]!.bookingCode, first.bookingCode);
  const pending = await prisma.appointmentService.create({ data: { ...serviceData, sequenceNo: 3 } });
  assert.equal((await reports.confirmedServices(cashier.id, paymentQuery)).total, 0);
  await prisma.appointmentService.update({ where: { id: pending.id }, data: { outcome: "NOT_PERFORMED", actualChargedAmount: "0" } });
  assert.equal((await reports.confirmedServices(cashier.id, paymentQuery)).total, 1);
  await prisma.appointment.update({ where: { id: first.id }, data: { status: "COMPLETED", completionType: "NO_SERVICE_CLOSURE", completedAt: new Date() } });
  assert.equal((await reports.confirmedServices(cashier.id, query)).total, 1);
  await prisma.user.update({ where: { id: cashier.id }, data: { isActive: false } });
  try { await assert.rejects(reports.confirmedServices(cashier.id, query), { code: "UNAUTHORIZED" }); }
  finally { await prisma.user.update({ where: { id: cashier.id }, data: { isActive: true } }); }
});

test("cashier method totals subtract refunds by refund date and original method", async () => {
  const cashier = await actor("CASHIER"); const a = await appointment();
  const current = new Date("2026-10-08T00:00Z"); const previous = new Date("2026-10-07T00:00Z");
  await payment(a.id, "100.10", { paidAt: current, satisfiesObligation: true });
  await payment(a.id, "200.20", { paidAt: current, type: "SERVICE_PAYMENT", method: "GCASH", satisfiesObligation: true });
  await payment(a.id, "10.05", { paidAt: previous, status: "REFUNDED", refundedAt: current });
  await payment(a.id, "20.10", { paidAt: previous, status: "REFUNDED", refundedAt: current, method: "GCASH" });
  await payment(a.id, "999.00", { paidAt: null, status: "FAILED" });
  const result = await reports.collections(cashier.id, reportQuery.parse({ from: "2026-10-08", to: "2026-10-08" }));
  assert.equal(result.totals[0]!.refunded, "30.15"); assert.equal(result.totals[0]!.netCashMovement, "270.15");
  assert.deepEqual(result.methodTotals.map(t => [t.method, t.captured, t.refunded, t.netCashMovement]), [
    ["CASH", "100.10", "10.05", "90.05"], ["GCASH", "200.20", "20.10", "180.10"], ["OTHER", "0.00", "0.00", "0.00"],
  ]);
  assert.deepEqual(result.typeTotals.map(t => [t.type, t.captured, t.count]), [["APPOINTMENT_FEE", "100.10", 1], ["SERVICE_PAYMENT", "200.20", 1]]);
});

test("Admin audit view redacts legacy secrets and report services reject Cashier/private access", async () => {
  const admin = await actor(); const cashier = await actor("CASHIER");
  await prisma.auditLog.create({ data: { actorType: "ADMIN", actorUserId: admin.id, action: "TEST", entityType: "Appointment", entityId: randomUUID(), createdAt: day, beforeData: { guestAccessTokenHash: "secret", nested: { passwordHash: "secret", amount: "1.00" } } } });
  const audit = await reports.list(admin.id, "audit", q);
  assert.doesNotMatch(JSON.stringify(audit), /secret|passwordHash|guestAccessToken/);
  for (const kind of ["appointments", "payments", "receipts", "commissions", "audit"] as const) await assert.rejects(reports.list(cashier.id, kind, q), { code: "FORBIDDEN" });
  await assert.rejects(reports.dashboard(cashier.id, q), { code: "FORBIDDEN" });
  await prisma.user.update({ where: { id: cashier.id }, data: { isActive: false } });
  try { await assert.rejects(reports.collections(cashier.id, q), { code: "UNAUTHORIZED" }); } finally { await prisma.user.update({ where: { id: cashier.id }, data: { isActive: true } }); }
});

test("report HTTP authorization, cache controls, validation and public chatbot boundary", async () => {
  const config = parseEnv({ NODE_ENV: "test", DATABASE_URL: url.toString(), JWT_SECRET: "phase10-test-secret-with-at-least-32-characters", TRUSTED_ORIGINS: "http://localhost:5173" });
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}/api`;
  const admin = await actor(); const cashier = await actor("CASHIER"); const tokens = createTokenService(config.JWT_SECRET);
  const cookie = async (id: string, role: "ADMIN" | "CASHIER") => `salon_session=${await tokens.sign({ userId: id, role })}`;
  const adminCookie = await cookie(admin.id, "ADMIN");
  // Stale ADMIN claim must never promote a current Cashier.
  const cashierCookie = await cookie(cashier.id, "ADMIN");
  const query = "?from=2026-10-04&to=2026-10-04";
  try {
    assert.equal((await fetch(`${base}/reports/collections${query}`)).status, 401);
    assert.equal((await fetch(`${base}/reports/cashier-queue${query}`)).status, 401);
    assert.equal((await fetch(`${base}/reports/confirmed-services`)).status, 401);
    assert.equal((await fetch(`${base}/reports/waiting-queue`)).status, 401);
    for (const token of [adminCookie, cashierCookie]) {
      const confirmed = await fetch(`${base}/reports/confirmed-services`, { headers: { Cookie: token } });
      assert.equal(confirmed.status, 200); assert.equal(confirmed.headers.get("cache-control"), "no-store");
      const waiting = await fetch(`${base}/reports/waiting-queue`, { headers: { Cookie: token } });
      assert.equal(waiting.status, 200); assert.equal(waiting.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(`${base}/reports/confirmed-services?pageSize=101`, { headers: { Cookie: cashierCookie } })).status, 400);
    assert.equal((await fetch(`${base}/reports/waiting-queue?pageSize=101`, { headers: { Cookie: cashierCookie } })).status, 400);
    assert.equal((await fetch(`${base}/reports/waiting-queue?unknown=true`, { headers: { Cookie: cashierCookie } })).status, 400);
    for (const kind of ["dashboard", "appointments", "payments", "receipts", "commissions", "audit"]) assert.equal((await fetch(`${base}/reports/${kind}${query}`, { headers: { Cookie: cashierCookie } })).status, 403);
    const summary = await fetch(`${base}/reports/collections${query}`, { headers: { Cookie: cashierCookie } }); assert.equal(summary.status, 200); assert.equal(summary.headers.get("cache-control"), "no-store");
    const queue = await fetch(`${base}/reports/cashier-queue${query}`, { headers: { Cookie: cashierCookie } }); assert.equal(queue.status, 200); assert.equal(queue.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/reports/cashier-queue?from=bad`, { headers: { Cookie: cashierCookie } })).status, 400);
    assert.equal((await fetch(`${base}/reports/payments?from=bad`, { headers: { Cookie: adminCookie } })).status, 400);
    const chat = await fetch(`${base}/chatbot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "services and prices" }) });
    assert.equal(chat.status, 200); const reply = await chat.json(); assert.equal(reply.mode, "guided"); assert.doesNotMatch(reply.answer, /New name/);
    const counts = await prisma.appointment.count();
    await fetch(`${base}/chatbot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "confirm an available booking without payment" }) });
    assert.equal(await prisma.appointment.count(), counts);
    const invalid = await fetch(`${base}/chatbot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi", guestToken: "secret" }) }); assert.equal(invalid.status, 400);
  } finally { server.close(); await once(server, "close"); }
});


test("admin attention excludes expired holds and resolved captures and shows upcoming schedule windows", async () => {
  const admin = await actor(); const before = await reports.dashboard(admin.id, q);
  const now = Date.now();
  await appointment({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(now + 3600000) });
  await appointment({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(now - 3600000) });
  const capture = await appointment();
  await payment(capture.id, "10.00", { reconciliationStatus: "REQUIRED" });
  await payment(capture.id, "10.00", { reconciliationStatus: "REQUIRED", status: "REFUNDED" });
  const closure = await prisma.salonClosure.create({ data: { startsAt: new Date(now + 3600000), endsAt: new Date(now + 7200000), createdByUserId: admin.id, reason: "Dashboard closure" } });
  const result = await reports.dashboard(admin.id, q);
  assert.equal(result.attention.pendingFees, before.attention.pendingFees + 1);
  assert.equal(result.attention.reconciliation, before.attention.reconciliation + 1);
  assert.ok(result.scheduling.closures.some(row => row.id === closure.id));
  assert.doesNotMatch(JSON.stringify(result), /guestAccessToken|passwordHash/);
});

test("admin appointment filters cover full pagination, salon-date boundaries, names, staff and active holds", async () => {
  const admin = await actor(); const cashier = await actor("CASHIER");
  const service = createAppointmentChangesService(prisma, "Asia/Manila");
  const label = `Filter${randomUUID().slice(0, 8)}`;
  const start = new Date("2030-06-11T16:00:00Z");
  const items = [];
  for (let i = 0; i < 52; i++) items.push(await appointment({ startAt: start, endAt: new Date(+start + 1800000), customer: { create: { firstName: label, lastName: "Guest", phone: "0" } } }));
  await appointment({ startAt: new Date("2030-06-12T16:00:00Z"), customer: { create: { firstName: label, lastName: "Guest", phone: "0" } } });
  const filters = appointmentListQuery.parse({ from: "2030-06-12", to: "2030-06-12", status: "CONFIRMED", search: `${label} Guest` });
  const first = await service.list(admin.id, undefined, filters);
  assert.equal(first.appointments.length, 50); assert.ok(first.nextCursor);
  const second = await service.list(admin.id, first.nextCursor!, filters);
  assert.equal(second.appointments.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.appointments, ...second.appointments].map(row => row.bookingCode)).size, 52);
  const staff = await prisma.staff.findFirstOrThrow(); const catalog = await prisma.service.findFirstOrThrow(); const a = items[0]!;
  await prisma.appointmentService.create({ data: { appointmentId: a.id, staffId: staff.id, serviceId: catalog.id, assignmentMode: "SPECIFIC", sequenceNo: 1, serviceNameSnapshot: "Filter service", priceSnapshot: "50", durationMinutesSnapshot: 30, bufferMinutesSnapshot: 0, commissionRateSnapshot: "0.4", scheduledStartAt: start, scheduledEndAt: a.endAt, reservedUntilAt: a.endAt } });
  assert.equal((await service.list(admin.id, undefined, { ...filters, staffId: staff.id })).appointments.length, 1);
  const active = await appointment({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() + 3600000), customer: { create: { firstName: label, lastName: "Guest", phone: "0" } } });
  await appointment({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() - 3600000), customer: { create: { firstName: label, lastName: "Guest", phone: "0" } } });
  const pending = await service.list(admin.id, undefined, { search: label, attention: "pending-fees" });
  assert.deepEqual(pending.appointments.map(row => row.bookingCode), [active.bookingCode]);
  await assert.rejects(service.list(cashier.id, undefined, filters), { code: "FORBIDDEN" });
  assert.equal(appointmentListQuery.safeParse({ from: "2030-06-13", to: "2030-06-12" }).success, false);
  assert.equal(appointmentListQuery.safeParse({ status: "MADE_UP" }).success, false);
});

test("waiting queue includes only checked-in visits without active outcomes, oldest first across dates", async () => {
  const admin = await actor(); const cashier = await actor("CASHIER");
  const search = randomUUID();
  const createWaiting = async (minutes: number) => {
    const a = await appointment({ bookingCode: `${search}-${randomUUID()}`, status: "CONFIRMED", checkedInAt: new Date(Date.now() - minutes * 60_000), checkedInByUser: { connect: { id: cashier.id } } });
    const staff = await prisma.staff.create({ data: { firstName: "Waiting", lastName: "Stylist" } });
    const service = await prisma.service.create({ data: { name: "Current catalog name", price: "90", durationMinutes: 30 } });
    const item = await prisma.appointmentService.create({ data: { appointmentId: a.id, staffId: staff.id, serviceId: service.id, assignmentMode: "SPECIFIC", sequenceNo: 1,
      serviceNameSnapshot: "Booked haircut", priceSnapshot: "70", durationMinutesSnapshot: 30, bufferMinutesSnapshot: 15, commissionRateSnapshot: "0.4",
      scheduledStartAt: a.startAt, scheduledEndAt: a.endAt, reservedUntilAt: a.endAt } });
    return { a, item };
  };
  const oldest = await createWaiting(80); const newer = await createWaiting(10);
  const performed = await createWaiting(30); const finalized = await createWaiting(40);
  const absent = await createWaiting(60); const cancelled = await createWaiting(70);
  const completed = await createWaiting(90); const noShow = await createWaiting(100);
  const noActive = await createWaiting(110); const pending = await createWaiting(120);
  await prisma.appointmentService.update({ where: { id: performed.item.id }, data: { outcome: "PERFORMED" } });
  await prisma.appointmentService.update({ where: { id: finalized.item.id }, data: { outcomeFinalizedAt: new Date() } });
  await prisma.appointmentService.update({ where: { id: noActive.item.id }, data: { membershipStatus: "REMOVED" } });
  await prisma.appointment.update({ where: { id: absent.a.id }, data: { checkedInAt: null, checkedInByUserId: null } });
  await prisma.appointment.update({ where: { id: cancelled.a.id }, data: { status: "CANCELLED" } });
  await prisma.appointment.update({ where: { id: completed.a.id }, data: { completedAt: new Date() } });
  await prisma.appointment.update({ where: { id: noShow.a.id }, data: { status: "NO_SHOW" } });
  await prisma.appointment.update({ where: { id: pending.a.id }, data: { status: "PENDING_PAYMENT" } });
  // Removed historical activity must not hide the current active visit.
  await prisma.appointmentService.create({ data: { ...newer.item, id: randomUUID(), sequenceNo: 2, membershipStatus: "REMOVED", outcome: "PERFORMED" } });
  const q = { page: 1, pageSize: 1, search };
  const first = await reports.waitingQueue(cashier.id, q);
  const second = await reports.waitingQueue(admin.id, { ...q, page: 2 });
  assert.equal(first.total, 2); assert.equal(first.rows[0]!.bookingCode, oldest.a.bookingCode);
  assert.equal(second.rows[0]!.bookingCode, newer.a.bookingCode);
  assert.ok(first.rows[0]!.minutesSinceCheckIn >= 80);
  assert.equal(first.rows[0]!.needsReview, oldest.a.endAt <= new Date(first.serverTime));
  assert.equal(first.rows[0]!.appointmentServices[0]!.serviceNameSnapshot, "Booked haircut");
  assert.ok(first.rows[0]!.checkedInByUser);
  assert.doesNotMatch(JSON.stringify(first), /guestAccess|password|phone|email|commission|priceSnapshot/);
  const empty = await reports.waitingQueue(cashier.id, { ...q, search: "no-such-waiting-customer" });
  assert.equal(empty.total, 0);
  await prisma.appointmentService.update({ where: { id: newer.item.id }, data: { outcome: "NOT_PERFORMED" } });
  assert.equal((await reports.waitingQueue(cashier.id, q)).total, 1);
  await prisma.user.update({ where: { id: cashier.id }, data: { isActive: false } });
  try { await assert.rejects(reports.waitingQueue(cashier.id, q)); }
  finally { await prisma.user.update({ where: { id: cashier.id }, data: { isActive: true } }); }
});


test("cashier arrival list uses today's salon date, active outcomes and bounded search/pagination", async () => {
  const cashier = await actor("CASHIER");
  const prefix = `arrival-${randomUUID()}`;
  const today = Temporal.Now.zonedDateTimeISO("Asia/Manila").startOfDay();
  const start = new Date(today.epochMilliseconds);
  const next = new Date(today.add({ days: 1 }).epochMilliseconds);
  const staff = await prisma.staff.create({ data: { firstName: "Arrival", lastName: "Stylist" } });
  const service = await prisma.service.create({ data: { name: "Arrival service", price: "50", durationMinutes: 30 } });
  async function visit(suffix: string, extra: object = {}) {
    const a = await appointment({ bookingCode: `${prefix}-${suffix}`, startAt: start, endAt: new Date(+start + 1800000), ...extra });
    const item = await prisma.appointmentService.create({ data: {
      appointmentId: a.id, serviceId: service.id, staffId: staff.id, assignmentMode: "SPECIFIC", sequenceNo: 1,
      serviceNameSnapshot: "Arrival service", priceSnapshot: "50", durationMinutesSnapshot: 30,
      bufferMinutesSnapshot: 0, commissionRateSnapshot: "0.4", scheduledStartAt: a.startAt,
      scheduledEndAt: new Date(+a.startAt + 1800000), reservedUntilAt: new Date(+a.startAt + 1800000),
    } });
    return { a, item };
  }
  const first = await visit("eligible");
  const arrived = await visit("arrived", { startAt: new Date(+next - 1), checkedInAt: new Date(), checkedInByUser: { connect: { id: cashier.id } } });
  await visit("yesterday", { startAt: new Date(+start - 1) });
  await visit("tomorrow", { startAt: next });
  await visit("cancelled", { status: "CANCELLED" });
  await visit("pending", { status: "PENDING_PAYMENT" });
  await visit("completed", { completedAt: new Date() });
  const performed = await visit("performed");
  await prisma.appointmentService.update({ where: { id: performed.item.id }, data: { outcome: "PERFORMED" } });
  const finalized = await visit("finalized");
  await prisma.appointmentService.update({ where: { id: finalized.item.id }, data: { outcomeFinalizedAt: new Date() } });
  const removed = await visit("removed");
  await prisma.appointmentService.update({ where: { id: removed.item.id }, data: { membershipStatus: "REMOVED" } });
  await prisma.appointmentService.create({ data: {
    ...first.item, id: randomUUID(), sequenceNo: 2, membershipStatus: "REMOVED", outcome: "PERFORMED",
  } });
  const query = confirmedServicesQuery.parse({ search: prefix, arrivalToday: "true", pageSize: 1 });
  const result = await reports.confirmedServices(cashier.id, query);
  assert.equal(result.total, 2);
  assert.equal(result.rows[0]!.bookingCode, first.a.bookingCode);
  const page2 = await reports.confirmedServices(cashier.id, { ...query, page: 2 });
  assert.equal(page2.rows[0]!.bookingCode, arrived.a.bookingCode);
  assert.equal(page2.rows[0]!.checkedInByUser!.firstName, cashier.firstName);
  assert.equal((await reports.confirmedServices(cashier.id, { ...query, paymentReady: "true" })).total, 0);
});
