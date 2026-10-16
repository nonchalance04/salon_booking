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
import { createConfigurationService } from "../../src/modules/configuration/configuration.service.js";
import { createApiRouter } from "../../src/app/routes.js";
import { createApp } from "../../src/app/app.js";
import { parseEnv } from "../../src/config/env.schema.js";
import { ApiError } from "../../src/shared/http.js";
import { days } from "../../src/modules/configuration/configuration.schema.js";
import { SALON_COORDINATION_KEY } from "../../src/modules/scheduling/coordination.js";

import { createAvailabilityService } from "../../src/modules/availability/availability.service.js";
import { createAppointmentsService } from "../../src/modules/appointments/appointments.service.js";
import type { BookingInput } from "../../src/modules/appointments/appointments.schema.js";
import { tokenHash } from "../../src/modules/appointments/appointments.security.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL is required for disposable PostgreSQL tests.");
const dbName = `salon_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl); url.pathname = `/${dbName}`; url.searchParams.delete("schema");
const adminPool = new Pool({ connectionString: adminUrl });
const pool = createDatabasePool(url.toString(), { application_name: "phase5-configuration" });
const observer = new Pool({ connectionString: url.toString(), application_name: "phase5-observer" });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const configuration = createConfigurationService(prisma, "Asia/Manila");
const run = promisify(execFile);
let adminId = "";
let cashierId = "";
let created = false;
before(async () => {
  await adminPool.query(`CREATE DATABASE "${dbName}"`); created = true;
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url.toString(), SEED_ADMIN_EMAIL: "admin@example.test", SEED_ADMIN_PASSWORD: "phase5-admin-password", SEED_CASHIER_EMAIL: "cashier@example.test", SEED_CASHIER_PASSWORD: "phase5-cashier-password" };
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
  await waitUntil(async () => (await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = 'phase5-configuration' AND wait_event_type = 'Lock'", [dbName])).rowCount! > 0);
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

test("booking atomically snapshots sequential services, fixed fee, hold, and hashed guest credentials", async () => {
  const f = await bookingFixture();
  const secondService = await prisma.service.create({ data: { name: "Nail fixture", category: "Nails", price: "120.00", durationMinutes: 30, bufferMinutes: 15 } });
  await prisma.staffService.create({ data: { staffId: f.staff.id, serviceId: secondService.id, commissionRate: "0.4000" } });
  const result = await bookings.book({ ...f.input, services: [...f.input.services, { ...f.input.services[0]!, serviceId: secondService.id }] });
  const row = await prisma.appointment.findUniqueOrThrow({ where: { bookingCode: result.appointment.bookingCode }, include: { appointmentServices: { orderBy: { sequenceNo: "asc" } }, bookingPolicyVersion: true } });
  assert.equal(row.status, "PENDING_PAYMENT");
  assert.equal(row.guestAccessTokenHash, tokenHash(result.guestToken));
  assert.equal(row.appointmentFeeAmount.toString(), row.bookingPolicyVersion.appointmentFeeAmount.toString());
  assert.ok(row.holdExpiresAt! > new Date(result.appointment.serverTime));
  const [first, second] = row.appointmentServices;
  assert.equal(first!.priceSnapshot.toFixed(2), "120.00");
  assert.equal(first!.commissionRateSnapshot.toFixed(4), "0.4000");
  assert.equal(first!.serviceNameSnapshot, f.item.name);
  assert.equal(+second!.scheduledStartAt, +first!.reservedUntilAt);
  assert.equal(+row.endAt, +second!.scheduledEndAt);
  assert.equal(+second!.reservedUntilAt - +row.endAt, 15 * 60_000);
  const audit = await prisma.auditLog.findMany({ where: { entityId: row.id } });
  assert.equal(audit.length, 1); assert.equal(audit[0]!.action, "BOOKING_CREATED");
  assert.ok(!JSON.stringify(audit).includes(result.guestToken));
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: row.id } }), 0);
  const safe = JSON.stringify(result.appointment);
  assert.ok(!safe.includes("guestAccessTokenHash")); assert.ok(!safe.includes("commissionRate"));
  assert.deepEqual((await bookings.retrieve(row.bookingCode, result.guestToken)).appointment.customer, result.appointment.customer);
  await assert.rejects(bookings.retrieve(row.bookingCode, "x".repeat(43)), { code: "APPOINTMENT_NOT_FOUND" });
  await assert.rejects(bookings.retrieve("SL-" + "0".repeat(24), result.guestToken), { code: "APPOINTMENT_NOT_FOUND" });
});

test("direct requests allow haircut, color and treatment together but reject two color variants", async () => {
  const f = await bookingFixture();
  await prisma.service.update({ where: { id: f.item.id }, data: { category: "Hair Services" } });
  const extras = [];
  for (const category of ["Hair Color & Styling", "Hair Treatments"]) {
    const service = await prisma.service.create({ data: { name: category, category, price: "200.00", durationMinutes: 30, bufferMinutes: 15 } });
    await prisma.staffService.create({ data: { staffId: f.staff.id, serviceId: service.id, commissionRate: "0.4" } });
    extras.push({ ...f.input.services[0]!, serviceId: service.id });
  }
  const request = { ...f.input, services: [...f.input.services, ...extras] };
  const availability = createAvailabilityService(prisma, "Asia/Manila");
  assert.ok((await availability.search(request)).slots.length > 0);
  const alternate = await prisma.service.create({ data: { name: "Long color", category: " hair color & styling ", price: "300.00", durationMinutes: 30 } });
  const duplicate = { ...request, services: [...request.services, { serviceId: alternate.id, assignmentMode: "ANY_AVAILABLE" as const }] };
  await assert.rejects(availability.search(duplicate), { code: "DUPLICATE_SERVICE_CATEGORY" });
  await assert.rejects(bookings.book(duplicate), { code: "DUPLICATE_SERVICE_CATEGORY" });
  const result = await bookings.book(request);
  assert.equal(result.appointment.appointmentServices.length, 3);
});

test("direct booking and availability requests reject duplicate services and categories without writes", async () => {
  const f = await bookingFixture();
  const other = await prisma.service.create({ data: { name: "Same category", category: " other ", price: "120.00", durationMinutes: 30 } });
  const customers = await prisma.customer.count();
  const appointments = await prisma.appointment.count();
  const audits = await prisma.auditLog.count();
  const availability = createAvailabilityService(prisma, "Asia/Manila");
  for (const [serviceId, code] of [[f.item.id, "DUPLICATE_SERVICE"], [other.id, "DUPLICATE_SERVICE_CATEGORY"]]) {
    const request = { ...f.input, services: [...f.input.services, { serviceId: serviceId!, assignmentMode: "ANY_AVAILABLE" as const }] };
    await assert.rejects(bookings.book(request), { status: 400, code });
    await assert.rejects(availability.search(request), { status: 400, code });
  }
  assert.equal(await prisma.customer.count(), customers);
  assert.equal(await prisma.appointment.count(), appointments);
  assert.equal(await prisma.auditLog.count(), audits);
});

test("competing specific-staff requests commit exactly one complete booking", async () => {
  const f = await bookingFixture(); const customers = await prisma.customer.count();
  const results = await Promise.allSettled([bookings.book(f.input), bookings.book(f.input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "SLOT_UNAVAILABLE");
  assert.equal(await prisma.customer.count(), customers + 1);
  assert.equal(await prisma.appointment.count({ where: { status: "PENDING_PAYMENT" } }), 1);
});

test("ANY_AVAILABLE reassigns against fresh workload and supports parallel staff", async () => {
  const f = await bookingFixture();
  const other = await prisma.staff.create({ data: { firstName: "Other", lastName: "Staff" } });
  await prisma.staffService.create({ data: { staffId: other.id, serviceId: f.item.id, commissionRate: "0.25" } });
  await prisma.staffSchedule.create({ data: { staffId: other.id, dayOfWeek: f.weekday, startTime: new Date("1970-01-01T08:00Z"), endTime: new Date("1970-01-01T22:00Z") } });
  const input = { ...f.input, services: [{ serviceId: f.item.id, assignmentMode: "ANY_AVAILABLE" as const }] };
  const first = await bookings.book(input); const second = await bookings.book(input);
  const rows = await prisma.appointmentService.findMany({ where: { appointment: { bookingCode: { in: [first.appointment.bookingCode, second.appointment.bookingCode] } } } });
  assert.equal(new Set(rows.map(r => r.staffId)).size, 2);
  const firstRow = await prisma.appointmentService.findFirstOrThrow({ where: { appointment: { bookingCode: first.appointment.bookingCode } } });
  assert.equal(firstRow.staffId, [f.staff.id, other.id].sort()[0]);
});

test("infeasible later service leaves no customer, reservation, or audit fragments", async () => {
  const f = await bookingFixture(); const customers = await prisma.customer.count(); const audit = await prisma.auditLog.count();
  const unqualified = await prisma.staff.create({ data: { firstName: "No", lastName: "Qualification" } });
  const secondService = await prisma.service.create({ data: { name: "Unqualified nail fixture", category: "Nails", price: "120.00", durationMinutes: 30 } });
  await assert.rejects(bookings.book({ ...f.input, services: [...f.input.services, { serviceId: secondService.id, assignmentMode: "SPECIFIC", staffId: unqualified.id }] }), { code: "SLOT_UNAVAILABLE" });
  assert.equal(await prisma.customer.count(), customers); assert.equal(await prisma.auditLog.count(), audit);
});

test("booking waits for salon configuration and rejects fresh service deactivation", async () => {
  const f = await bookingFixture(); const blocker = await observer.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('UPDATE "Service" SET "isActive"=false WHERE id=$1', [f.item.id]);
    const rejected = assert.rejects(bookings.book(f.input), { code: "SERVICE_UNAVAILABLE" });
    await writerBlocked(); await blocker.query("COMMIT"); await rejected;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

test("committed booking protects its intervals from later configuration writes", async () => {
  const f = await bookingFixture(); const result = await bookings.book(f.input);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { bookingCode: result.appointment.bookingCode } });
  await expectConflict(configuration.saveStaff(adminId, { firstName: f.staff.firstName, lastName: f.staff.lastName, phone: null, isActive: false }, f.staff.id), row.id);
});

test("booking waiting on staff observes policy activation and an expired competing hold", async () => {
  const f = await bookingFixture();
  const latest = await prisma.bookingPolicyVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
  const { id: _id, createdAt: _created, ...values } = latest;
  const activates = new Date(Date.now() + 1400);
  const policy = await prisma.bookingPolicyVersion.create({ data: { ...values, version: latest.version + 1, effectiveFrom: activates, appointmentFeeAmount: "123.45", bookingHoldMinutes: 7, defaultBufferMinutes: 20 } });
  await prisma.service.update({ where: { id: f.item.id }, data: { bufferMinutes: null } });
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "PENDING_PAYMENT", holdExpiresAt: activates } });
  const blocker = await observer.connect(); let pending: ReturnType<typeof bookings.book> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock_shared($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    pending = bookings.book(f.input); await writerBlocked();
    await waitUntil(async () => (await observer.query('SELECT clock_timestamp() > $1 AS ready', [activates])).rows[0].ready);
    await blocker.query("COMMIT"); const result = await pending;
    const row = await prisma.appointment.findUniqueOrThrow({ where: { bookingCode: result.appointment.bookingCode }, include: { appointmentServices: true } });
    assert.equal(row.bookingPolicyVersionId, policy.id); assert.equal(row.appointmentFeeAmount.toFixed(2), "123.45");
    assert.equal(row.appointmentServices[0]!.bufferMinutesSnapshot, 20);
    assert.ok(+row.holdExpiresAt! - Date.parse(result.appointment.serverTime) > 6.9 * 60_000);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
});

test("new staff discovered after lock wait triggers rollback and a complete ordered retry", async () => {
  const f = await bookingFixture(); const blocker = await observer.connect(); let pending: ReturnType<typeof bookings.book> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    pending = bookings.book(f.input); await writerBlocked();
    const newStaff = await prisma.staff.create({ data: { firstName: "New", lastName: "Candidate" } });
    await blocker.query("COMMIT"); const result = await pending;
    assert.equal(result.appointment.status, "PENDING_PAYMENT");
    // The new candidate can be locked by a later transaction (no abandoned locks).
    await prisma.$transaction(async tx => { await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`; await tx.$queryRaw`SELECT id FROM "Staff" WHERE id=${newStaff.id}::uuid FOR UPDATE`; });
    assert.equal(await prisma.auditLog.count({ where: { action: "BOOKING_CREATED", entityId: (await prisma.appointment.findUniqueOrThrow({ where: { bookingCode: result.appointment.bookingCode } })).id } }), 1);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
});

test("expired guest status is immediate and competing cleanup workers audit once without removing history", async () => {
  const f = await bookingFixture(); const result = await bookings.book(f.input);
  const row = await prisma.appointment.update({ where: { bookingCode: result.appointment.bookingCode }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await bookings.retrieve(row.bookingCode, result.guestToken)).appointment.status, "EXPIRED");
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: row.id } })).status, "PENDING_PAYMENT");
  await Promise.all([bookings.expireHolds(), bookings.expireHolds()]);
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: row.id } })).status, "EXPIRED");
  assert.equal(await prisma.auditLog.count({ where: { entityId: row.id, action: "BOOKING_HOLD_EXPIRED" } }), 1);
  assert.equal(await prisma.appointmentService.count({ where: { appointmentId: row.id, membershipStatus: "ACTIVE" } }), 1);
  assert.equal((await bookings.book(f.input)).appointment.status, "PENDING_PAYMENT");
});

test("cleanup reloads status after locks and cannot overwrite a confirmed appointment", async () => {
  const f = await bookingFixture(); const result = await bookings.book(f.input);
  const row = await prisma.appointment.update({ where: { bookingCode: result.appointment.bookingCode }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  const blocker = await observer.connect(); let pending: Promise<number> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock_shared($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    await blocker.query('SELECT id FROM "Appointment" WHERE id=$1 FOR UPDATE', [row.id]);
    pending = bookings.expireHolds(); await writerBlocked();
    // Simulate an already-authorized confirmation owning the standard lock set.
    await blocker.query('UPDATE "Appointment" SET status=\'CONFIRMED\' WHERE id=$1', [row.id]);
    await blocker.query("COMMIT"); assert.equal(await pending, 0);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: row.id } })).status, "CONFIRMED");
    assert.equal(await prisma.auditLog.count({ where: { entityId: row.id, action: "BOOKING_HOLD_EXPIRED" } }), 0);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
});

test("booking HTTP validates input and guest access requires the private token and trusted origin", async () => {
  const f = await bookingFixture(); const config = parseEnv({ DATABASE_URL: url.toString(), JWT_SECRET: "phase5-test-secret-at-least-32-characters", NODE_ENV: "test" });
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api/appointments`;
  const post = (path: string, body: unknown, origin = "http://localhost:5173") => fetch(root + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("", f.input, "https://attacker.test")).status, 403);
    assert.equal((await post("", { ...f.input, appointmentFeeAmount: "0" })).status, 400);
    assert.equal((await post("", { ...f.input, customer: { ...f.input.customer, phone: "<script>" } })).status, 400);
    const response = await post("", f.input); assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json(); const bookingCode = body.appointment.bookingCode;
    assert.equal((await post("/access", { bookingCode })).status, 400);
    assert.equal((await post("/access", { bookingCode, token: "a".repeat(43) })).status, 404);
    assert.equal((await post("/access", { bookingCode, token: body.guestToken })).status, 200);
    assert.equal((await fetch(root + "/" + bookingCode)).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("policy activation during insertion rolls back snapshots and restarts the full booking transaction", async () => {
  const f = await bookingFixture(); const before = await prisma.customer.count();
  const latest = await prisma.bookingPolicyVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
  const { id: _id, createdAt: _created, ...values } = latest;
  const policy = await prisma.bookingPolicyVersion.create({ data: { ...values, version: latest.version + 1, effectiveFrom: new Date(Date.now() + 700), appointmentFeeAmount: "175.25", defaultBufferMinutes: 5, bookingHoldMinutes: 8 } });
  await prisma.service.update({ where: { id: f.item.id }, data: { bufferMinutes: null } });
  // A real database insert wait forces activation between pre-write validation
  // and finalization. Both attempts exercise actual rollback, locks, and writes.
  await observer.query(`CREATE FUNCTION phase5_delay_booking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
  await observer.query(`CREATE TRIGGER phase5_delay_booking BEFORE INSERT ON "Appointment" FOR EACH ROW EXECUTE FUNCTION phase5_delay_booking()`);
  try {
    const result = await bookings.book(f.input);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { bookingCode: result.appointment.bookingCode }, include: { appointmentServices: true } });
    assert.equal(row.bookingPolicyVersionId, policy.id); assert.equal(row.appointmentFeeAmount.toFixed(2), "175.25");
    assert.equal(row.appointmentServices[0]!.bufferMinutesSnapshot, 5);
    assert.equal(await prisma.customer.count(), before + 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: row.id, action: "BOOKING_CREATED" } }), 1);
  } finally {
    await observer.query('DROP TRIGGER phase5_delay_booking ON "Appointment"');
    await observer.query('DROP FUNCTION phase5_delay_booking()');
  }
});

test("a lead-time boundary crossed during a staff lock wait cannot commit a stale slot", async () => {
  const f = await bookingFixture();
  const latest = await prisma.bookingPolicyVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
  const { id: _id, createdAt: _created, ...values } = latest;
  await prisma.bookingPolicyVersion.create({ data: { ...values, version: latest.version + 1, effectiveFrom: new Date(), minimumBookingLeadMinutes: 60 } });
  const start = Temporal.Now.zonedDateTimeISO("Asia/Manila").add({ days: 7 }).with({ hour: 9, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  // Put the lead boundary 1.5 seconds ahead while leaving the appointment at a
  // known valid salon time. Policy lead minutes are integral, so adjust start.
  const now = Date.now();
  const leadMinutes = Math.floor((start.epochMilliseconds - now) / 60_000);
  const target = new Date(now + leadMinutes * 60_000 + 1500);
  const targetLocal = Temporal.Instant.fromEpochMilliseconds(+target).toZonedDateTimeISO("Asia/Manila");
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
  await prisma.bookingPolicyVersion.update({ where: { id: policy.id }, data: { minimumBookingLeadMinutes: leadMinutes } });
  const blocker = await observer.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    const rejected = assert.rejects(bookings.book({ ...f.input, date: targetLocal.toPlainDate().toString(), startAt: target.toISOString() }), { code: "SLOT_UNAVAILABLE" });
    await writerBlocked();
    await waitUntil(async () => (await observer.query('SELECT clock_timestamp() > $1 AS ready', [new Date(now + 1600)])).rows[0].ready);
    await blocker.query("COMMIT"); await rejected;
    assert.equal(await prisma.appointment.count({ where: { status: "PENDING_PAYMENT" } }), 0);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

test("hold expiration during insertion recomputes ANY_AVAILABLE assignment before committing", async () => {
  const f = await bookingFixture();
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
  const { id: _id, createdAt: _created, ...values } = policy;
  await prisma.bookingPolicyVersion.create({ data: { ...values, version: policy.version + 1, effectiveFrom: new Date(), minimumBookingLeadMinutes: 60 } });
  const other = await prisma.staff.create({ data: { id: "ffffffff-ffff-4fff-bfff-ffffffffffff", firstName: "Second", lastName: "Candidate" } });
  await prisma.staffService.create({ data: { staffId: other.id, serviceId: f.item.id, commissionRate: "0.3" } });
  await prisma.staffSchedule.create({ data: { staffId: other.id, dayOfWeek: f.weekday, startTime: new Date("1970-01-01T08:00Z"), endTime: new Date("1970-01-01T22:00Z") } });
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() + 700) } });
  await observer.query(`CREATE FUNCTION phase5_delay_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
  await observer.query(`CREATE TRIGGER phase5_delay_assignment BEFORE INSERT ON "Appointment" FOR EACH ROW EXECUTE FUNCTION phase5_delay_assignment()`);
  try {
    const result = await bookings.book({ ...f.input, services: [{ serviceId: f.item.id, assignmentMode: "ANY_AVAILABLE" }] });
    const row = await prisma.appointmentService.findFirstOrThrow({ where: { appointment: { bookingCode: result.appointment.bookingCode } } });
    assert.equal(row.staffId, f.staff.id);
    assert.equal(await prisma.appointment.count({ where: { customer: { firstName: "Guest", lastName: "Booking" }, status: "PENDING_PAYMENT" } }), 1);
  } finally {
    await observer.query('DROP TRIGGER phase5_delay_assignment ON "Appointment"');
    await observer.query('DROP FUNCTION phase5_delay_assignment()');
  }
});

// Phase 7 uses this suite's disposable database, fixture, and lock observer.
import { createAppointmentChangesService } from "../../src/modules/appointments/appointment-changes.service.js";
import type { ChangeInput } from "../../src/modules/appointments/appointments.schema.js";
const changes = createAppointmentChangesService(prisma, "Asia/Manila");
async function changeFixture() {
  const f = await bookingFixture();
  const booked = await bookings.book(f.input);
  const appointment = await prisma.appointment.update({ where: { bookingCode: booked.appointment.bookingCode }, data: { status: "CONFIRMED", confirmedAt: new Date() }, include: { appointmentServices: true } });
  const input: ChangeInput = { bookingCode: appointment.bookingCode, token: booked.guestToken, recovery: false,
    date: f.input.date, startAt: f.input.startAt, services: [{ ...f.input.services[0]!, appointmentServiceId: appointment.appointmentServices[0]!.id }] };
  return { ...f, policy: await prisma.bookingPolicyVersion.findUniqueOrThrow({ where: { id: appointment.bookingPolicyVersionId } }), appointment, booked, change: input };
}
test("reschedule ignores only its own interval, preserves snapshots, and writes complete immutable history", async () => {
  const f = await changeFixture();
  await prisma.service.update({ where: { id: f.item.id }, data: { isActive: false, price: "999.00", durationMinutes: 80, name: "Changed" } });
  const updated = await changes.change(f.change);
  assert.equal(updated.appointment.status, "CONFIRMED");
  assert.equal(updated.appointment.rescheduleCount, 1);
  assert.equal(updated.appointment.appointmentServices[0]!.priceSnapshot, "120.00");
  assert.equal(updated.appointment.appointmentServices[0]!.durationMinutesSnapshot, 30);
  const history = await prisma.appointmentRescheduleHistory.findFirstOrThrow({ where: { appointmentId: f.appointment.id } });
  assert.equal(history.snapshotSchemaVersion, 1);
  assert.ok(JSON.stringify(history.beforeSnapshot).includes('"commissionRateSnapshot":"0.4000"'));
  assert.ok(!JSON.stringify(history).includes(f.booked.guestToken));
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.appointment.id, eventType: "BOOKING_RESCHEDULED" } }), 1);
  await assert.rejects(changes.change({ ...f.change, services: [...f.change.services, { serviceId: f.item.id, assignmentMode: "ANY_AVAILABLE" }] }));
  await assert.rejects(changes.change({ ...f.change, token: "a".repeat(43) }));
});
test("reschedule retains removed rows and snapshots new services; concurrent changes enforce count", async () => {
  const f = await changeFixture();
  const added = await prisma.service.create({ data: { name: "New addition", price: "333.21", durationMinutes: 20 } });
  await prisma.staffService.create({ data: { staffId: f.staff.id, serviceId: added.id, commissionRate: "0.2300" } });
  const result = await changes.change({ ...f.change, services: [{ serviceId: added.id, assignmentMode: "SPECIFIC", staffId: f.staff.id }] });
  assert.equal(result.appointment.appointmentServices[0]!.priceSnapshot, "333.21");
  const removed = await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.change.services[0]!.appointmentServiceId } });
  assert.equal(removed.membershipStatus, "REMOVED"); assert.equal(removed.outcome, "SCHEDULED");
  assert.ok(removed.removedAt);
  const request = { ...f.change, services: [{ serviceId: added.id, appointmentServiceId: result.appointment.appointmentServices[0]!.id, assignmentMode: "SPECIFIC" as const, staffId: f.staff.id }] };
  const attempts = await Promise.allSettled([changes.change(request), changes.change(request)]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id } })).rescheduleCount, 2);
});
test("failed conflicting reschedule preserves the original schedule and cannot beat a competing booking", async () => {
  const f = await changeFixture();
  const target = new Date(+f.startAt + 2 * 3_600_000).toISOString();
  const results = await Promise.allSettled([changes.change({ ...f.change, startAt: target }), bookings.book({ ...f.input, startAt: target })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  if (results[0]!.status === "rejected") {
    const unchanged = await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id } });
    assert.equal(+unchanged.startAt, +f.startAt); assert.equal(unchanged.rescheduleCount, 0);
  }
});
test("cancellation is authorized, releases time, preserves payments and records one notification", async () => {
  const f = await changeFixture();
  await assert.rejects(changes.cancel(f.appointment.bookingCode, "a".repeat(43)));
  await changes.cancel(f.appointment.bookingCode, f.booked.guestToken);
  await changes.cancel(f.appointment.bookingCode, f.booked.guestToken);
  assert.equal(await prisma.appointmentService.count({ where: { appointmentId: f.appointment.id } }), 1);
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: f.appointment.id, eventType: "BOOKING_CANCELLED" } }), 1);
  await bookings.book(f.input);
});
async function missedFixture(credit: boolean) {
  const f = await changeFixture();
  const past = new Date(Date.now() - 3_600_000);
  await prisma.appointment.update({ where: { id: f.appointment.id }, data: { startAt: past, endAt: new Date(+past + 30 * 60_000) } });
  await assert.rejects(changes.markNoShow(cashierId, f.appointment.bookingCode));
  await changes.markNoShow(adminId, f.appointment.bookingCode);
  if (credit) await prisma.payment.create({ data: { appointmentId: f.appointment.id, type: "APPOINTMENT_FEE", status: "SUCCEEDED", amount: f.appointment.appointmentFeeAmount,
    currency: "PHP", method: "CASH", provider: "manual", idempotencyKey: randomUUID(), satisfiesObligation: true, paidAt: new Date() } });
  const request: ChangeInput = { ...f.change, recovery: true, services: f.input.services };
  return { ...f, request, past };
}
test("no-show recovery consumes one original fee atomically, retains policy/history, and cannot duplicate credit", async () => {
  const f = await missedFixture(true);
  const attempts = await Promise.allSettled([changes.change(f.request), changes.change(f.request)]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  const original = await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id } });
  assert.equal(original.status, "NO_SHOW"); assert.equal(+original.noShowGraceExpiresAt!, +f.past + f.policy.noShowGraceHours * 3_600_000);
  const replacement = await prisma.appointment.findUniqueOrThrow({ where: { recoveryOfAppointmentId: original.id } });
  assert.equal(replacement.status, "CONFIRMED"); assert.equal(replacement.holdExpiresAt, null);
  assert.equal(replacement.bookingPolicyVersionId, original.bookingPolicyVersionId); assert.equal(replacement.rescheduleCount, 1);
  assert.ok(replacement.carriedAppointmentFeePaymentId);
  assert.equal(await prisma.payment.count({ where: { appointmentId: replacement.id } }), 0);
  assert.equal(await prisma.payment.count({ where: { appointmentId: original.id } }), 1);
  const history = await prisma.appointmentRescheduleHistory.findFirstOrThrow({ where: { appointmentId: original.id } });
  assert.ok(JSON.stringify(history.afterSnapshot).includes(replacement.id));
  assert.equal(await prisma.notificationQueue.count({ where: { appointmentId: replacement.id, eventType: "BOOKING_CONFIRMED" } }), 1);
});
test("recovery without eligible credit creates a normal payment hold and grace/count cannot be bypassed", async () => {
  const f = await missedFixture(false);
  const result = await changes.change(f.request);
  assert.equal(result.appointment.status, "PENDING_PAYMENT"); assert.ok(result.appointment.holdExpiresAt); assert.ok(result.guestToken);
  const late = await missedFixture(false);
  await prisma.appointment.update({ where: { id: late.appointment.id }, data: { startAt: new Date(Date.now() - 73 * 3_600_000) } });
  await assert.rejects(changes.change(late.request));
  const full = await missedFixture(false);
  await prisma.appointment.update({ where: { id: full.appointment.id }, data: { rescheduleCount: full.policy.maxReschedules } });
  await assert.rejects(changes.change(full.request));
});
test("fresh post-lock cutoff rejects reschedule and cancellation without partial changes", async () => {
  for (const operation of ["change", "cancel"] as const) {
    const f = await changeFixture();
    const hours = operation === "change" ? f.policy.rescheduleCutoffHours : f.policy.cancellationCutoffHours;
    await prisma.appointment.update({ where: { id: f.appointment.id }, data: { startAt: new Date(Date.now() + hours * 3_600_000 + 700) } });
    const blocker = await observer.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
      const result = operation === "change" ? changes.change(f.change) : changes.cancel(f.appointment.bookingCode, f.booked.guestToken);
      const rejected = assert.rejects(result);
      await writerBlocked(); await delay(850); await blocker.query("COMMIT"); await rejected;
      assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id } })).status, "CONFIRMED");
      assert.equal(await prisma.appointmentRescheduleHistory.count({ where: { appointmentId: f.appointment.id } }), 0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  }
});
test("refunded and insufficient fees never become carried credit", async () => {
  for (const invalid of ["refunded", "insufficient"] as const) {
    const f = await missedFixture(true);
    await prisma.payment.updateMany({ where: { appointmentId: f.appointment.id }, data: invalid === "refunded" ? { status: "REFUNDED", refundedAt: new Date() } : { amount: "0.01" } });
    const result = await changes.change(f.request);
    assert.equal(result.appointment.status, "PENDING_PAYMENT"); assert.equal(result.appointment.carriedAppointmentFeePaymentId, null);
  }
});
test("outbox failure rolls back schedule, history and recovery credit allocation", async () => {
  for (const recovery of [false, true]) {
    const f = recovery ? await missedFixture(true) : await changeFixture();
    const input: ChangeInput = recovery ? { ...f.change, recovery: true, services: f.input.services } : f.change;
    await observer.query(`CREATE FUNCTION phase7_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$`);
    await observer.query(`CREATE TRIGGER phase7_fail_outbox BEFORE INSERT ON "NotificationQueue" FOR EACH ROW EXECUTE FUNCTION phase7_fail_outbox()`);
    try {
      await assert.rejects(changes.change(input));
      assert.equal(await prisma.appointmentRescheduleHistory.count({ where: { appointmentId: f.appointment.id } }), 0);
      assert.equal(await prisma.appointment.count({ where: { recoveryOfAppointmentId: f.appointment.id } }), 0);
      assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id } })).rescheduleCount, 0);
      assert.equal((await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.appointment.appointmentServices[0]!.id } })).membershipStatus, "ACTIVE");
    } finally {
      await observer.query('DROP TRIGGER phase7_fail_outbox ON "NotificationQueue"'); await observer.query('DROP FUNCTION phase7_fail_outbox()');
    }
  }
});
test("no-show rejects early marking, inactive admins and recorded outcomes; Admin reads omit guest credentials", async () => {
  const f = await changeFixture();
  await assert.rejects(changes.markNoShow(adminId, f.appointment.bookingCode)); await assert.rejects(changes.list(cashierId));
  const list = await changes.list(adminId);
  assert.ok(!JSON.stringify(list).includes("guestAccessTokenHash")); assert.ok(!JSON.stringify(list).includes(f.booked.guestToken));
  await prisma.appointment.update({ where: { id: f.appointment.id }, data: { startAt: new Date(Date.now() - 60_000) } });
  await prisma.appointmentService.update({ where: { id: f.appointment.appointmentServices[0]!.id }, data: { outcome: "PERFORMED" } });
  await assert.rejects(changes.markNoShow(adminId, f.appointment.bookingCode));
  await prisma.user.update({ where: { id: adminId }, data: { isActive: false } });
  try { await assert.rejects(changes.markNoShow(adminId, f.appointment.bookingCode)); }
  finally { await prisma.user.update({ where: { id: adminId }, data: { isActive: true } }); }
});
test("change HTTP routes enforce guest authentication, strict requests, browser origin, and Admin role", async () => {
  const f = await changeFixture();
  const config = parseEnv({ DATABASE_URL: url.toString(), JWT_SECRET: "phase7-test-secret-at-least-32-characters", NODE_ENV: "test" });
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api`;
  const post = (path: string, body: unknown, cookie = "", origin = "http://localhost:5173") => fetch(root + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/appointments/change", f.change, "", "https://attacker.test")).status, 403);
    assert.equal((await post("/appointments/change", { ...f.change, token: "a".repeat(43) })).status, 404);
    assert.equal((await post("/appointments/change", { ...f.change, rescheduleCount: 0 })).status, 400);
    const { startAt: _startAt, ...search } = f.change;
    const available = await post("/appointments/change-options", search); assert.equal(available.status, 200);
    assert.equal(available.headers.get("cache-control"), "no-store"); assert.ok((await available.json()).slots.length);
    assert.equal((await post("/appointments/change", f.change)).status, 200);
    assert.equal((await post("/appointments/no-show", { bookingCode: f.appointment.bookingCode })).status, 401);
    const login = await post("/auth/login", { email: "cashier@example.test", password: "phase5-cashier-password" });
    assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post("/appointments/no-show", { bookingCode: f.appointment.bookingCode }, cookie)).status, 403);
    assert.equal((await fetch(root + "/appointments", { headers: { Cookie: cookie } })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("check-in records one server arrival and actor across concurrent Admin/Cashier requests, protecting present customers", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date() } });
  const results = await Promise.all([changes.checkIn(cashierId, f.booking.bookingCode), changes.checkIn(adminId, f.booking.bookingCode)]);
  assert.equal(+results[0]!.checkedInAt!, +results[1]!.checkedInAt!);
  assert.equal(results[0]!.checkedInByUserId, results[1]!.checkedInByUserId);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
  assert.equal(row.status, "CONFIRMED"); assert.equal(row.completedAt, null);
  assert.ok(row.checkedInAt); assert.ok([adminId, cashierId].includes(row.checkedInByUserId!));
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: row.id, action: "BOOKING_CHECKED_IN" } });
  assert.equal(audit.actorUserId, row.checkedInByUserId);
  assert.equal(audit.actorType, row.checkedInByUserId === cashierId ? "CASHIER" : "ADMIN");
  const service = await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.booking.appointmentServices[0]!.id } });
  assert.equal(service.outcome, "SCHEDULED"); assert.equal(service.outcomeFinalizedAt, null);
  assert.equal(await prisma.payment.count({ where: { appointmentId: row.id } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { entityId: row.id, action: "BOOKING_CHECKED_IN" } }), 1);
  await assert.rejects(changes.markNoShow(adminId, row.bookingCode));
  const reports = (await import("../../src/modules/reports/reports.service.js")).createReportsService(prisma, "Asia/Manila");
  const list = await reports.confirmedServices(cashierId, { page: 1, pageSize: 25, search: row.bookingCode });
  assert.ok(list.rows[0]!.checkedInAt); assert.ok(list.rows[0]!.checkedInByUser);
});

test("check-in rejects another salon date, invalid status, recorded outcomes and inactive accounts", async () => {
  for (const checkInActorId of [adminId, cashierId]) {
    const f = await fixture();
    await assert.rejects(changes.checkIn(checkInActorId, f.booking.bookingCode));
    await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date() } });
    for (const status of ["PENDING_PAYMENT", "CANCELLED", "NO_SHOW", "EXPIRED", "COMPLETED"] as const) {
      await prisma.appointment.update({ where: { id: f.booking.id }, data: { status } });
      await assert.rejects(changes.checkIn(checkInActorId, f.booking.bookingCode));
    }
    await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "CONFIRMED" } });
    await prisma.appointmentService.update({ where: { id: f.booking.appointmentServices[0]!.id }, data: { outcome: "PERFORMED" } });
    await assert.rejects(changes.checkIn(checkInActorId, f.booking.bookingCode));
    await prisma.appointmentService.update({ where: { id: f.booking.appointmentServices[0]!.id }, data: { outcome: "SCHEDULED" } });
    await prisma.user.update({ where: { id: checkInActorId }, data: { isActive: false } });
    try { await assert.rejects(changes.checkIn(checkInActorId, f.booking.bookingCode)); }
    finally { await prisma.user.update({ where: { id: checkInActorId }, data: { isActive: true } }); }
    assert.equal(await prisma.auditLog.count({ where: { entityId: f.booking.id, action: "BOOKING_CHECKED_IN" } }), 0);
  }
});

test("check-in HTTP rejects guest access, forged arrival fields and untrusted origins", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date() } });
  const config = parseEnv({ DATABASE_URL: url.toString(), JWT_SECRET: "check-in-test-secret-at-least-32-characters", NODE_ENV: "test" });
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const post = (path: string, body: unknown, cookie = "", origin = "http://localhost:5173") => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  const input = { bookingCode: f.booking.bookingCode };
  try {
    assert.equal((await post("/appointments/check-in", input)).status, 401);
    const login = await post("/auth/login", { email: "cashier@example.test", password: "phase5-cashier-password" });
    assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post("/appointments/check-in", input, cookie, "https://attacker.test")).status, 403);
    for (const forged of [{ checkedInAt: new Date().toISOString() }, { checkedInByUserId: adminId }]) {
      assert.equal((await post("/appointments/check-in", { ...input, ...forged }, cookie)).status, 400);
    }
    const arrival = await post("/appointments/check-in", input, cookie);
    assert.equal(arrival.status, 200);
    assert.equal((await arrival.json()).checkedInByUserId, cashierId);
    const adminLogin = await post("/auth/login", { email: "admin@example.test", password: "phase5-admin-password" });
    const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post("/appointments/check-in", { ...input, checkedInAt: new Date().toISOString() }, adminCookie)).status, 400);
    assert.equal((await post("/appointments/check-in", input, adminCookie)).status, 200);
    await prisma.user.update({ where: { id: cashierId }, data: { isActive: false } });
    try { assert.equal((await post("/appointments/check-in", input, cookie)).status, 401); }
    finally { await prisma.user.update({ where: { id: cashierId }, data: { isActive: true } }); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("automatic no-show marks only overdue absent visits and competing workers audit once", async () => {
  const overdue = await fixture(); const withinGrace = await fixture();
  const arrived = await fixture(); const performed = await fixture();
  const finalized = await fixture(); const pending = await fixture("PENDING_PAYMENT");
  const completed = await fixture(); const cancelled = await fixture();
  for (const f of [overdue, arrived, performed, finalized, pending, completed, cancelled]) {
    await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date(Date.now() - 16 * 60_000) } });
  }
  await prisma.appointment.update({ where: { id: withinGrace.booking.id }, data: { startAt: new Date(Date.now() - 14 * 60_000) } });
  await prisma.appointment.update({ where: { id: arrived.booking.id }, data: { checkedInAt: new Date(), checkedInByUserId: cashierId } });
  await prisma.appointment.update({ where: { id: completed.booking.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  await prisma.appointment.update({ where: { id: cancelled.booking.id }, data: { status: "CANCELLED" } });
  await prisma.appointmentService.update({ where: { id: performed.booking.appointmentServices[0]!.id }, data: { outcome: "PERFORMED" } });
  await prisma.appointmentService.update({ where: { id: finalized.booking.appointmentServices[0]!.id }, data: { outcomeFinalizedAt: new Date() } });
  const results = await Promise.all([changes.markOverdueNoShows(1), changes.markOverdueNoShows(1)]);
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id: overdue.booking.id } });
  assert.equal(row.status, "NO_SHOW"); assert.ok(row.noShowAt);
  assert.equal(+row.noShowGraceExpiresAt!, +row.startAt + overdue.policy.noShowGraceHours * 3_600_000);
  const audits = await prisma.auditLog.findMany({ where: { entityId: row.id, action: "BOOKING_NO_SHOW" } });
  assert.equal(audits.length, 1); assert.equal(audits[0]!.actorType, "SYSTEM");
  for (const f of [withinGrace, arrived, performed, finalized]) {
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).status, "CONFIRMED");
  }
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: pending.booking.id } })).status, "PENDING_PAYMENT");
  assert.equal(await changes.markOverdueNoShows(), 0);
});

test("automatic marking reloads arrival after waiting for the appointment lock", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date(Date.now() - 16 * 60_000) } });
  const blocker = await observer.connect();
  let marking: Promise<number> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query('SELECT id FROM "Appointment" WHERE id=$1 FOR UPDATE', [f.booking.id]);
    marking = changes.markOverdueNoShows();
    await writerBlocked();
    // Simulate an arrival committed after candidate selection but before the worker acquires its row lock.
    await blocker.query('UPDATE "Appointment" SET "checkedInAt"=clock_timestamp(), "checkedInByUserId"=$2 WHERE id=$1', [f.booking.id, cashierId]);
    await blocker.query("COMMIT");
    assert.equal(await marking, 0);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).status, "CONFIRMED");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await marking?.catch(() => {}); }
});

test("check-in and automatic marking are mutually exclusive, including a late arrival after marking", async t => {
  const f = await fixture();
  const now = new Date();
  // Keep the appointment on today's salon date even when the test runs shortly after midnight.
  const dayStart = Temporal.Instant.fromEpochMilliseconds(+now).toZonedDateTimeISO("Asia/Manila").startOfDay().epochMilliseconds;
  if (+now - dayStart < 16 * 60_000) { t.skip("Arrival check-in requires the same salon date; grace has not elapsed today yet."); return; }
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date(+now - 16 * 60_000) } });
  const [arrival, marking] = await Promise.allSettled([changes.checkIn(adminId, f.booking.bookingCode), changes.markOverdueNoShows()]);
  assert.equal(marking.status, "fulfilled");
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
  if (arrival.status === "fulfilled") {
    assert.equal(row.status, "CONFIRMED"); assert.ok(row.checkedInAt); assert.equal(row.noShowAt, null);
  } else {
    assert.equal(row.status, "NO_SHOW"); assert.equal(row.checkedInAt, null);
    await assert.rejects(changes.checkIn(adminId, f.booking.bookingCode));
  }
});

test("automatic no-show and its audit roll back together on audit failure", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt: new Date(Date.now() - 16 * 60_000) } });
  await observer.query(`CREATE FUNCTION fail_auto_no_show_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'BOOKING_NO_SHOW' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await observer.query('CREATE TRIGGER fail_auto_no_show_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_auto_no_show_audit()');
  try {
    await assert.rejects(changes.markOverdueNoShows());
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
    assert.equal(row.status, "CONFIRMED"); assert.equal(row.noShowAt, null);
  } finally {
    await observer.query('DROP TRIGGER fail_auto_no_show_audit ON "AuditLog"');
    await observer.query('DROP FUNCTION fail_auto_no_show_audit()');
  }
});

async function correctionFixture(t: import("node:test").TestContext) {
  const now = Temporal.Now.zonedDateTimeISO("Asia/Manila");
  if (now.hour === 23 || (now.hour === 0 && now.minute < 2)) {
    t.skip("Original thirty-minute visit and buffer must fit in today's salon date."); return;
  }
  const f = await fixture();
  const startAt = new Date(Date.now() - 60_000);
  const endAt = new Date(+startAt + 30 * 60_000);
  const reservedUntilAt = new Date(+endAt + 15 * 60_000);
  const weekday = days[now.dayOfWeek - 1]!;
  await prisma.salonOperatingHour.create({ data: { dayOfWeek: weekday, openTime: new Date("1970-01-01T00:00Z"), closeTime: new Date("1970-01-01T23:59Z") } });
  await prisma.staffSchedule.update({ where: { id: f.schedule.id }, data: { dayOfWeek: weekday, startTime: new Date("1970-01-01T00:00Z"), endTime: new Date("1970-01-01T23:59Z") } });
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { startAt, endAt } });
  await prisma.appointmentService.update({ where: { id: f.booking.appointmentServices[0]!.id }, data: { scheduledStartAt: startAt, scheduledEndAt: endAt, reservedUntilAt } });
  await changes.markNoShow(adminId, f.booking.bookingCode);
  return { ...f, startAt, endAt, reservedUntilAt, correction: { bookingCode: f.booking.bookingCode, reason: "Customer arrived; original no-show recorded in error", customerPresent: true as const } };
}

test("Admin correction restores and checks in without changing snapshots or finances; duplicate requests audit once", async t => {
  const f = await correctionFixture(t); if (!f) return;
  const before = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
  const outcomes = await Promise.allSettled([changes.correctNoShow(adminId, f.correction), changes.correctNoShow(adminId, f.correction)]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
  assert.equal(row.status, "CONFIRMED"); assert.ok(row.checkedInAt); assert.equal(row.checkedInByUserId, adminId);
  assert.equal(row.noShowAt, null); assert.equal(row.noShowGraceExpiresAt, null);
  assert.equal(+row.startAt, +before.startAt); assert.equal(+row.endAt, +before.endAt);
  assert.equal(row.rescheduleCount, before.rescheduleCount); assert.equal(row.bookingPolicyVersionId, before.bookingPolicyVersionId);
  assert.equal(row.appointmentFeeAmount.toString(), before.appointmentFeeAmount.toString());
  assert.equal(await prisma.payment.count({ where: { appointmentId: row.id } }), 0);
  assert.equal((await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.booking.appointmentServices[0]!.id } })).outcome, "SCHEDULED");
  const audits = await prisma.auditLog.findMany({ where: { entityId: row.id, action: "BOOKING_NO_SHOW_CORRECTED" } });
  assert.equal(audits.length, 1); assert.equal(audits[0]!.actorUserId, adminId);
  assert.ok(JSON.stringify(audits[0]!.beforeData).includes(before.noShowAt!.toISOString()));
  assert.ok(JSON.stringify(audits[0]!.afterData).includes(f.correction.reason));
  assert.equal(await changes.markOverdueNoShows(), 0);
});

test("correction rejects occupied intervals including live payment holds, inactive staff and missing qualifications", async t => {
  const f = await correctionFixture(t); if (!f) return;
  const other = await fixture("PENDING_PAYMENT", new Date(Date.now() + 60_000));
  await prisma.appointmentService.update({ where: { id: other.booking.appointmentServices[0]!.id }, data: {
    staffId: f.staff.id, scheduledStartAt: f.startAt, scheduledEndAt: f.endAt, reservedUntilAt: f.reservedUntilAt,
  } });
  await assert.rejects(changes.correctNoShow(cashierId, f.correction));
  await prisma.appointment.update({ where: { id: other.booking.id }, data: { status: "CONFIRMED" } });
  await assert.rejects(changes.correctNoShow(cashierId, f.correction));
  await prisma.appointment.update({ where: { id: other.booking.id }, data: { status: "CANCELLED" } });
  await prisma.staff.update({ where: { id: f.staff.id }, data: { isActive: false } });
  await assert.rejects(changes.correctNoShow(cashierId, f.correction));
  await prisma.staff.update({ where: { id: f.staff.id }, data: { isActive: true } });
  await prisma.staffService.update({ where: { id: f.qualification.id }, data: { isActive: false } });
  await assert.rejects(changes.correctNoShow(cashierId, f.correction));
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).status, "NO_SHOW");
  assert.equal(await prisma.auditLog.count({ where: { entityId: f.booking.id, action: "BOOKING_NO_SHOW_CORRECTED" } }), 0);
});

test("correction rejects replacements, ended visits, inactive accounts and blank reasons", async t => {
  const f = await correctionFixture(t); if (!f) return;
  await assert.rejects(changes.correctNoShow(cashierId, { ...f.correction, reason: "  " }));
  await prisma.user.update({ where: { id: cashierId }, data: { isActive: false } });
  try { await assert.rejects(changes.correctNoShow(cashierId, f.correction), { code: "UNAUTHORIZED" }); }
  finally { await prisma.user.update({ where: { id: cashierId }, data: { isActive: true } }); }
  await assert.rejects(changes.correctNoShow(adminId, { ...f.correction, reason: "  " }));
  await prisma.user.update({ where: { id: adminId }, data: { isActive: false } });
  try { await assert.rejects(changes.correctNoShow(adminId, f.correction)); }
  finally { await prisma.user.update({ where: { id: adminId }, data: { isActive: true } }); }
  const replacement = await fixture();
  await prisma.appointment.update({ where: { id: replacement.booking.id }, data: { recoveryOfAppointmentId: f.booking.id } });
  await assert.rejects(changes.correctNoShow(adminId, f.correction));
  await prisma.appointment.update({ where: { id: replacement.booking.id }, data: { recoveryOfAppointmentId: null } });
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { endAt: new Date(Date.now() - 1) } });
  await assert.rejects(changes.correctNoShow(adminId, f.correction));
});

test("correction refuses new occupancy committed while it waits for locks", async t => {
  const f = await correctionFixture(t); if (!f) return;
  const other = await fixture();
  const blocker = await observer.connect(); let correction: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    correction = changes.correctNoShow(adminId, f.correction);
    const rejected = assert.rejects(correction);
    await writerBlocked();
    await blocker.query('UPDATE "AppointmentService" SET "staffId"=$1, "scheduledStartAt"=$2, "scheduledEndAt"=$3, "reservedUntilAt"=$4 WHERE id=$5', [f.staff.id, f.startAt, f.endAt, f.reservedUntilAt, other.booking.appointmentServices[0]!.id]);
    await blocker.query("COMMIT"); await rejected;
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).status, "NO_SHOW");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await correction?.catch(() => {}); }
});

test("correction restores nothing when its audit insert fails", async t => {
  const f = await correctionFixture(t); if (!f) return;
  await observer.query(`CREATE FUNCTION fail_correction_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'BOOKING_NO_SHOW_CORRECTED' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await observer.query('CREATE TRIGGER fail_correction_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_correction_audit()');
  try {
    await assert.rejects(changes.correctNoShow(adminId, f.correction));
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
    assert.equal(row.status, "NO_SHOW"); assert.equal(row.checkedInAt, null); assert.ok(row.noShowAt);
  } finally {
    await observer.query('DROP TRIGGER fail_correction_audit ON "AuditLog"'); await observer.query('DROP FUNCTION fail_correction_audit()');
  }
});

test("correction HTTP allows Cashier/Admin and requires authentication, trusted origin and explicit presence", async t => {
  const f = await correctionFixture(t); if (!f) return;
  const config = parseEnv({ DATABASE_URL: url.toString(), JWT_SECRET: "correction-test-secret-at-least-32-characters", NODE_ENV: "test" });
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const post = (path: string, body: unknown, cookie = "", origin = "http://localhost:5173") => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  const path = "/appointments/no-show/correct";
  try {
    assert.equal((await post(path, f.correction)).status, 401);
    const cashierLogin = await post("/auth/login", { email: "cashier@example.test", password: "phase5-cashier-password" });
    const cashierCookie = cashierLogin.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post(path, f.correction, cashierCookie, "https://attacker.test")).status, 403);
    assert.equal((await post(path, { ...f.correction, customerPresent: false }, cashierCookie)).status, 400);
    const login = await post("/auth/login", { email: "admin@example.test", password: "phase5-admin-password" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post(path, f.correction, cookie, "https://attacker.test")).status, 403);
    assert.equal((await post(path, { ...f.correction, customerPresent: false }, cookie)).status, 400);
    assert.equal((await post(path, { ...f.correction, checkedInAt: new Date().toISOString() }, cookie)).status, 400);
    assert.equal((await post(path, f.correction, cashierCookie)).status, 200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: f.booking.id, action: "BOOKING_NO_SHOW_CORRECTED" } });
    assert.equal(audit.actorType, "CASHIER"); assert.equal(audit.actorUserId, cashierId);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("rescheduling and recovery reject duplicate services and categories without changing history", async () => {
  for (const recovery of [false, true]) {
    const f = recovery ? await missedFixture(true) : await changeFixture();
    const request = { ...f.change, recovery, services: f.input.services };
    const other = await prisma.service.create({ data: { name: "Other service in category", category: "Other", price: "120.00", durationMinutes: 30 } });
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id }, include: { appointmentServices: true } });
    const count = await prisma.appointment.count();
    for (const [serviceId, code] of [[f.item.id, "DUPLICATE_SERVICE"], [other.id, "DUPLICATE_SERVICE_CATEGORY"]]) {
      const invalid = { ...request, services: [...request.services, { serviceId: serviceId!, assignmentMode: "ANY_AVAILABLE" as const }] };
      await assert.rejects(changes.search(invalid), { status: 400, code });
      await assert.rejects(changes.change(invalid), { status: 400, code });
    }
    assert.deepEqual(await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointment.id }, include: { appointmentServices: true } }), before);
    assert.equal(await prisma.appointment.count(), count);
  }
});


test("concurrent Cashier and Admin no-show corrections restore once and retain the winning actor", async t => {
  const f = await correctionFixture(t); if (!f) return;
  const results = await Promise.allSettled([changes.correctNoShow(cashierId, f.correction), changes.correctNoShow(adminId, f.correction)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } });
  assert.equal(row.status, "CONFIRMED"); assert.ok(row.checkedInAt);
  const audits = await prisma.auditLog.findMany({ where: { entityId: row.id, action: "BOOKING_NO_SHOW_CORRECTED" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actorUserId, row.checkedInByUserId);
  assert.equal(audits[0]!.actorType, row.checkedInByUserId === cashierId ? "CASHIER" : "ADMIN");
});
