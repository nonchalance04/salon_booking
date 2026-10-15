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
import { createTokenService } from "../../src/modules/auth/auth.token.js";
import { parseEnv } from "../../src/config/env.schema.js";
import { ApiError } from "../../src/shared/http.js";
import { days } from "../../src/modules/configuration/configuration.schema.js";
import { SALON_COORDINATION_KEY, freshTime } from "../../src/modules/scheduling/coordination.js";

import { createAvailabilityService } from "../../src/modules/availability/availability.service.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL is required for disposable PostgreSQL tests.");
const dbName = `salon_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl); url.pathname = `/${dbName}`; url.searchParams.delete("schema");
const adminPool = new Pool({ connectionString: adminUrl });
const pool = createDatabasePool(url.toString(), { application_name: "phase3-configuration" });
const observer = new Pool({ connectionString: url.toString(), application_name: "phase3-observer" });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const service = createConfigurationService(prisma, "Asia/Manila");
const run = promisify(execFile);
let adminId = "";
let cashierId = "";
let created = false;
before(async () => {
  await adminPool.query(`CREATE DATABASE "${dbName}"`); created = true;
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url.toString(), SEED_ADMIN_EMAIL: "admin@example.test", SEED_ADMIN_PASSWORD: "phase3-admin-password", SEED_CASHIER_EMAIL: "cashier@example.test", SEED_CASHIER_PASSWORD: "phase3-cashier-password" };
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
  await waitUntil(async () => (await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = 'phase3-configuration' AND wait_event_type = 'Lock'", [dbName])).rowCount! > 0);
}

test("profile stays singular and configuration changes keep historical snapshots", async () => {
  const f = await fixture();
  const old = await prisma.salonProfile.findFirstOrThrow();
  await Promise.all([
    service.saveProfile(adminId, { name: "Salon A", address: "Address", phone: null, email: null }),
    service.saveProfile(adminId, { name: "Salon B", address: "Address", phone: null, email: null }),
  ]);
  assert.equal(await prisma.salonProfile.count(), 1);
  assert.equal((await prisma.salonProfile.findFirstOrThrow()).id, old.id);
  await service.saveService(adminId, { name: "New name", description: null, price: "200.00", durationMinutes: 60, bufferMinutes: 0, isActive: true }, f.item.id);
  await service.saveQualification(adminId, { staffId: f.staff.id, serviceId: f.item.id, commissionRate: "0.5000", isActive: true }, f.qualification.id);
  const historical = await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.booking.appointmentServices[0]!.id } });
  assert.equal(historical.priceSnapshot.toFixed(2), "120.00");
  assert.equal(historical.bufferMinutesSnapshot, 15); assert.equal(historical.durationMinutesSnapshot, 30);
  assert.equal(historical.commissionRateSnapshot.toFixed(4), "0.4000");
  assert.equal(historical.serviceNameSnapshot, "Fixture service");
  assert.ok(await prisma.auditLog.count({ where: { entityId: f.item.id } }));
});

test("deleting staff preserves historical records, is audited, and can be repeated", async () => {
  const f = await fixture();
  const historical = await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.booking.appointmentServices[0]!.id } });
  await expectConflict(service.removeStaff(adminId, f.staff.id), f.booking.id);
  assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: f.staff.id } })).isActive, true);
  assert.equal(await prisma.auditLog.count({ where: { entityType: "Staff", entityId: f.staff.id } }), 0);
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "COMPLETED" } });
  await service.removeStaff(adminId, f.staff.id);
  assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: f.staff.id } })).isActive, false);
  assert.deepEqual(await prisma.appointmentService.findUniqueOrThrow({ where: { id: historical.id } }), historical);
  assert.ok(await prisma.staffService.findUnique({ where: { id: f.qualification.id } }));
  assert.ok(await prisma.staffSchedule.findUnique({ where: { id: f.schedule.id } }));
  assert.ok(!(await createAvailabilityService(prisma, "Asia/Manila").catalog()).staff.some(row => row.id === f.staff.id));
  await service.removeStaff(adminId, f.staff.id);
  assert.equal(await prisma.auditLog.count({ where: { entityType: "Staff", entityId: f.staff.id } }), 1);
  await assert.rejects(service.removeStaff(adminId, randomUUID()), { code: "NOT_FOUND" });
});

test("staff, service, and qualification deactivation roll back when reservations would be invalidated", async () => {
  const f = await fixture(); const count = await prisma.auditLog.count();
  await expectConflict(service.saveStaff(adminId, { firstName: "Fixture", lastName: "Changed", phone: null, isActive: false }, f.staff.id), f.booking.id);
  await expectConflict(service.saveService(adminId, { name: f.item.name, description: null, price: "120.00", durationMinutes: 30, bufferMinutes: 15, isActive: false }, f.item.id), f.booking.id);
  await expectConflict(service.saveQualification(adminId, { staffId: f.staff.id, serviceId: f.item.id, commissionRate: "0.4000", isActive: false }, f.qualification.id), f.booking.id);
  assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: f.staff.id } })).isActive, true);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: f.item.id } })).isActive, true);
  assert.equal(await prisma.auditLog.count(), count);
});

test("grouped skills save atomically, retain qualification identities and historical commissions", async () => {
  const f = await fixture();
  const nail = await prisma.service.create({ data: { name: "Manicure", category: "Nails", price: "100", durationMinutes: 30 } });
  const input = { services: [{ serviceId: nail.id, commissionRate: "0.35" }] };
  const auditCount = await prisma.auditLog.count();
  await expectConflict(service.saveStaffSkills(adminId, f.staff.id, input), f.booking.id);
  assert.equal(await prisma.auditLog.count(), auditCount);
  assert.equal(await prisma.staffService.count({ where: { staffId: f.staff.id } }), 1);
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "COMPLETED" } });
  await service.saveStaffSkills(adminId, f.staff.id, input);
  const old = await prisma.staffService.findUniqueOrThrow({ where: { id: f.qualification.id } });
  assert.equal(old.isActive, false);
  const added = await prisma.staffService.findUniqueOrThrow({ where: { staffId_serviceId: { staffId: f.staff.id, serviceId: nail.id } } });
  assert.equal(added.commissionRate.toFixed(4), "0.3500");
  await service.saveStaffSkills(adminId, f.staff.id, { services: [{ serviceId: f.item.id, commissionRate: "0.5" }] });
  assert.equal((await prisma.staffService.findUniqueOrThrow({ where: { id: old.id } })).isActive, true);
  assert.equal((await prisma.staffService.findUniqueOrThrow({ where: { id: added.id } })).isActive, false);
  assert.equal((await prisma.appointmentService.findUniqueOrThrow({ where: { id: f.booking.appointmentServices[0]!.id } })).commissionRateSnapshot.toFixed(4), "0.4000");
  await service.saveStaffSkills(adminId, f.staff.id, { services: [] });
  assert.equal(await prisma.staffService.count({ where: { staffId: f.staff.id, isActive: true } }), 0);
  assert.equal(await prisma.staffService.count({ where: { staffId: f.staff.id } }), 2);
});

test("nail-only staff cannot be assigned hair or unselected nail services", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "CANCELLED" } });
  await prisma.service.update({ where: { id: f.item.id }, data: { category: "Nails" } });
  const hair = await prisma.service.create({ data: { name: "Haircut", category: "Hair", price: "120", durationMinutes: 30 } });
  const otherNail = await prisma.service.create({ data: { name: "Gel extensions", category: "Nails", price: "250", durationMinutes: 30 } });
  await service.saveStaffSkills(adminId, f.staff.id, { services: [{ serviceId: f.item.id, commissionRate: "0.4" }] });
  const availability = createAvailabilityService(prisma, "Asia/Manila");
  const date = Temporal.Instant.fromEpochMilliseconds(+f.startAt).toZonedDateTimeISO("Asia/Manila").toPlainDate().toString();
  const search = (serviceId: string, assignmentMode: "SPECIFIC" | "ANY_AVAILABLE") => availability.search({ date, startAt: f.startAt.toISOString(), services: [assignmentMode === "SPECIFIC" ? { serviceId, assignmentMode, staffId: f.staff.id } : { serviceId, assignmentMode }] });
  assert.equal((await search(f.item.id, "SPECIFIC")).slots.length, 1);
  for (const item of [hair, otherNail]) {
    assert.equal((await search(item.id, "SPECIFIC")).slots.length, 0);
    assert.equal((await search(item.id, "ANY_AVAILABLE")).slots.length, 0);
  }
  assert.deepEqual((await availability.catalog()).staff.find(row => row.id === f.staff.id)!.serviceIds, [f.item.id]);
  const auditCount = await prisma.auditLog.count();
  await assert.rejects(service.saveStaffSkills(adminId, f.staff.id, { services: [{ serviceId: randomUUID(), commissionRate: "0.4" }] }), { code: "INVALID_REFERENCE" });
  await prisma.service.update({ where: { id: hair.id }, data: { isActive: false } });
  await assert.rejects(service.saveStaffSkills(adminId, f.staff.id, { services: [{ serviceId: hair.id, commissionRate: "0.4" }] }), { code: "SERVICE_UNAVAILABLE" });
  await assert.rejects(service.saveStaffSkills(cashierId, f.staff.id, { services: [] }), { code: "FORBIDDEN" });
  assert.equal(await prisma.auditLog.count(), auditCount);
  assert.equal((await prisma.staffService.findUniqueOrThrow({ where: { id: f.qualification.id } })).isActive, true);
});

test("hours and schedules cover the full reservation including buffer, dates, and alternative shifts", async () => {
  const f = await fixture();
  const hours = await prisma.salonOperatingHour.findFirstOrThrow({ where: { dayOfWeek: f.weekday } });
  await expectConflict(service.saveHours(adminId, { dayOfWeek: f.weekday, openTime: "08:00", closeTime: "09:30", isActive: true }, hours.id), f.booking.id);
  const input = { staffId: f.staff.id, dayOfWeek: f.weekday, startTime: "08:00", endTime: "09:30", effectiveFrom: null, effectiveTo: null, isActive: true };
  await expectConflict(service.saveSchedule(adminId, input, f.schedule.id), f.booking.id);
  await service.saveSchedule(adminId, { ...input, startTime: "09:30", endTime: "10:00" });
  await service.saveSchedule(adminId, input, f.schedule.id);
  await expectConflict(service.saveSchedule(adminId, { ...input, effectiveFrom: "9999-01-01" }, f.schedule.id), f.booking.id);
});

test("closures/time off reject buffer overlaps but permit adjacent periods; removal preserves audit history", async () => {
  const f = await fixture();
  const input = { startsAt: new Date(f.endAt.getTime() + 60_000), endsAt: new Date(f.reservedUntilAt.getTime() + 60_000), reason: "Test closure" };
  await expectConflict(service.saveClosure(adminId, input), f.booking.id);
  await expectConflict(service.saveUnavailability(adminId, { ...input, staffId: f.staff.id }), f.booking.id);
  const row = await service.saveClosure(adminId, { ...input, startsAt: f.reservedUntilAt });
  await service.removeClosure(adminId, row.id);
  assert.equal(await prisma.salonClosure.findUnique({ where: { id: row.id } }), null);
  assert.equal(await prisma.auditLog.count({ where: { entityId: row.id } }), 2);
  const absence = await service.saveUnavailability(adminId, { ...input, startsAt: f.reservedUntilAt, staffId: f.staff.id });
  await service.removeUnavailability(adminId, absence.id);
  assert.equal(await prisma.auditLog.count({ where: { entityId: absence.id } }), 2);
});

test("expired holds and terminal/removed reservations do not prevent prospective configuration", async () => {
  const f = await fixture("PENDING_PAYMENT", new Date(Date.now() - 1000));
  await service.saveStaff(adminId, { firstName: f.staff.firstName, lastName: f.staff.lastName, phone: null, isActive: false }, f.staff.id);
  const g = await fixture();
  await prisma.appointmentService.updateMany({ where: { appointmentId: g.booking.id }, data: { membershipStatus: "REMOVED", removedAt: new Date() } });
  await service.saveStaff(adminId, { firstName: "Removed", lastName: "History", phone: null, isActive: false }, g.staff.id);
  assert.equal(await prisma.appointmentService.count({ where: { appointmentId: g.booking.id } }), 1);
});

test("fresh database clock preserves the instant in a non-UTC PostgreSQL session", async () => {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Manila'`;
    const time = await freshTime(tx);
    const actual = (await observer.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    assert.ok(Math.abs(actual.getTime() - time.getTime()) < 2000);
  });
});

test("Prisma persists the actual instant rather than a server-local wall time", async () => {
  const f = await fixture();
  const stored = (await observer.query('SELECT "startAt", "holdExpiresAt" FROM "Appointment" WHERE id=$1', [f.booking.id])).rows[0];
  assert.equal(stored.startAt.toISOString(), f.startAt.toISOString());
  assert.equal(stored.holdExpiresAt.toISOString(), f.booking.holdExpiresAt!.toISOString());
  assert.equal((await pool.query('SHOW TimeZone')).rows[0].TimeZone, "UTC");
});

test("an active payment hold prevents configuration changes before its deadline", async () => {
  const f = await fixture("PENDING_PAYMENT", new Date(Date.now() + 60_000));
  await expectConflict(service.saveClosure(adminId, { startsAt: f.startAt, endsAt: f.reservedUntilAt, reason: null }), f.booking.id);
});

test("policy versions are prospective, fixed-fee, unique, and leave existing references unchanged", async () => {
  const f = await fixture(); const original = f.booking.bookingPolicyVersionId;
  const input = { appointmentFeeType: "FIXED" as const, appointmentFeeAmount: "150.00", bookingHoldMinutes: 10, defaultBufferMinutes: 20, maxReschedules: 2, rescheduleCutoffHours: 4, cancellationCutoffHours: 4, noShowGraceHours: 72, advanceBookingDays: 30, minimumBookingLeadMinutes: 60, effectiveFrom: null };
  const row = await service.createPolicy(adminId, input);
  assert.ok(row.version > f.policy.version);
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: f.booking.id } })).bookingPolicyVersionId, original);
  await assert.rejects(service.createPolicy(adminId, { ...input, effectiveFrom: new Date(0) }), { code: "POLICY_IN_PAST" });
  const when = new Date(Date.now() + 60_000);
  await service.createPolicy(adminId, { ...input, effectiveFrom: when });
  await assert.rejects(service.createPolicy(adminId, { ...input, effectiveFrom: when }), { code: "CONFIGURATION_EXISTS" });
});

test("an exclusive configuration writer waits for a reservation and sees its committed state", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "CANCELLED" } });
  const blocker = await observer.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock_shared($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    await blocker.query('UPDATE "Appointment" SET status=\'CONFIRMED\' WHERE id=$1', [f.booking.id]);
    pending = expectConflict(service.saveClosure(adminId, { startsAt: f.startAt, endsAt: f.reservedUntilAt, reason: "Concurrent" }), f.booking.id);
    await writerBlocked(); await blocker.query("COMMIT"); await pending;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
});

test("Staff lock waits use a fresh database clock after hold expiration", async () => {
  const f = await fixture("PENDING_PAYMENT");
  const blocker = await observer.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock_shared($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    await prisma.appointment.update({ where: { id: f.booking.id }, data: { holdExpiresAt: new Date(Date.now() + 1500) } });
    pending = service.saveStaff(adminId, { firstName: "Expired", lastName: "Hold", phone: null, isActive: false }, f.staff.id);
    await writerBlocked();
    assert.equal((await observer.query('SELECT "holdExpiresAt" > clock_timestamp() AS active FROM "Appointment" WHERE id=$1', [f.booking.id])).rows[0].active, true);
    await waitUntil(async () => (await observer.query('SELECT "holdExpiresAt" < clock_timestamp() AS expired FROM "Appointment" WHERE id=$1', [f.booking.id])).rows[0].expired);
    await blocker.query("COMMIT"); await pending;
    assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: f.staff.id } })).isActive, false);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
});

test("public APIs expose only public configuration; Admin API enforces roles, CSRF, and immutable policies", async () => {
  const config = parseEnv({ DATABASE_URL: url.toString(), JWT_SECRET: "phase3-test-secret-at-least-32-characters", NODE_ENV: "test" });
  const tokens = createTokenService(config.JWT_SECRET);
  const adminCookie = `salon_session=${await tokens.sign({ userId: adminId, role: "ADMIN" })}`;
  const cashierCookie = `salon_session=${await tokens.sign({ userId: cashierId, role: "CASHIER" })}`;
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, method = "GET", cookie = "", body?: unknown, origin = "http://localhost:5173") => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const catalog = await request("/services"); assert.equal(catalog.status, 200);
    const publicData = await catalog.text(); assert.ok(!publicData.includes("commissionRate"));
    const salon = await (await request("/salon")).json(); assert.equal(salon.timeZone, "Asia/Manila"); assert.ok(!JSON.stringify(salon).includes("createdByUserId"));
    assert.equal((await request("/configuration")).status, 401);
    assert.equal((await request("/configuration", "GET", cashierCookie)).status, 403);
    assert.equal((await request("/configuration", "GET", adminCookie)).status, 200);
    const body = { name: "API service", price: "120.00", description: null, durationMinutes: 30, bufferMinutes: 0, isActive: true };
    assert.equal((await request("/configuration/services", "POST", cashierCookie, body)).status, 403);
    assert.equal((await request("/configuration/services", "POST", adminCookie, body, "https://evil.example")).status, 403);
    assert.equal((await request("/configuration/services", "POST", adminCookie, { ...body, price: 120 })).status, 400);
    const created = await request("/configuration/services", "POST", adminCookie, body); assert.equal(created.status, 201);
    const id = (await created.json()).record.id;
    assert.equal((await request(`/configuration/services/${id}`, "PUT", adminCookie, { ...body, isActive: false })).status, 200);
    assert.ok(!(await (await request("/services")).json()).services.some((s: { id: string }) => s.id === id));
    assert.equal((await request(`/configuration/services/${id}`, "DELETE", adminCookie)).status, 404);
    const policy = await prisma.bookingPolicyVersion.findFirstOrThrow();
    assert.equal((await request(`/configuration/policies/${policy.id}`, "PUT", adminCookie, {})).status, 404);
    const f = await fixture();
    const deletePath = `/configuration/staff/${f.staff.id}`;
    assert.equal((await request(deletePath, "DELETE")).status, 401);
    assert.equal((await request(deletePath, "DELETE", cashierCookie)).status, 403);
    assert.equal((await request(deletePath, "DELETE", adminCookie, undefined, "https://evil.example")).status, 403);
    assert.equal((await request("/configuration/staff/invalid", "DELETE", adminCookie)).status, 400);
    assert.equal((await request(`/configuration/staff/${randomUUID()}`, "DELETE", adminCookie)).status, 404);
    assert.equal((await request(deletePath, "DELETE", adminCookie)).status, 409);
    const deletableStaff = await prisma.staff.create({ data: { firstName: "Delete", lastName: "Test" } });
    assert.equal((await request(`/configuration/staff/${deletableStaff.id}`, "DELETE", adminCookie)).status, 204);
    assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: deletableStaff.id } })).isActive, false);
    const skillsPath = `/configuration/staff/${f.staff.id}/skills`;
    const skills = { services: [{ serviceId: f.item.id, commissionRate: "0.4" }] };
    assert.equal((await request(skillsPath, "PUT", "", skills)).status, 401);
    assert.equal((await request(skillsPath, "PUT", cashierCookie, skills)).status, 403);
    assert.equal((await request(skillsPath, "PUT", adminCookie, skills, "https://evil.example")).status, 403);
    assert.equal((await request(skillsPath, "PUT", adminCookie, { services: [skills.services[0], skills.services[0]] })).status, 400);
    assert.equal((await request(skillsPath, "PUT", adminCookie, skills)).status, 200);
    assert.equal((await request(skillsPath, "PUT", adminCookie, { services: [] })).status, 409);
    const publicProfile = { title: "Stylist", bio: "Public bio", photoUrl: null, languages: [], portfolio: [], reviews: [] };
    const profilePath = `/configuration/staff/${f.staff.id}/profile`;
    assert.equal((await request(profilePath, "PUT", "", publicProfile)).status, 401);
    assert.equal((await request(profilePath, "PUT", cashierCookie, publicProfile)).status, 403);
    assert.equal((await request(profilePath, "PUT", adminCookie, publicProfile, "https://evil.example")).status, 403);
    assert.equal((await request(profilePath, "PUT", adminCookie, { ...publicProfile, photoUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await request(profilePath, "PUT", adminCookie, publicProfile)).status, 200);
    assert.deepEqual((await (await request("/availability/staff")).json()).staff.find((row: { id: string }) => row.id === f.staff.id).publicProfile, publicProfile);
    const conflict = await request("/configuration/closures", "POST", adminCookie, { startsAt: f.startAt.toISOString(), endsAt: f.reservedUntilAt.toISOString(), reason: null });
    assert.equal(conflict.status, 409); assert.ok((await conflict.json()).error.details.appointments.some((a: { appointmentId: string }) => a.appointmentId === f.booking.id));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


// Phase 4 uses the same isolated database and reservation fixtures to verify
// the boundary between configuration coordination and advisory reads.
test("availability uses persisted blocking states, public data and effective policy without creating reservations", async () => {
  const f = await fixture();
  const availability = createAvailabilityService(prisma, "Asia/Manila");
  const date = Temporal.Instant.fromEpochMilliseconds(+f.startAt).toZonedDateTimeISO("Asia/Manila").toPlainDate().toString();
  const input = { date, startAt: f.startAt.toISOString(), services: [{ serviceId: f.item.id, assignmentMode: "SPECIFIC" as const, staffId: f.staff.id }] };
  const before = await prisma.appointment.count();
  assert.equal((await availability.search(input)).slots.length, 0);
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "COMPLETED" } });
  assert.equal((await availability.search(input)).slots.length, 0);
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() - 1) } });
  const result = await availability.search(input);
  assert.equal(result.slots.length, 1); assert.equal(result.advisory, true);
  assert.equal(result.slots[0]!.services[0]!.bufferMinutes, 15);
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow({ where: { effectiveFrom: { lte: new Date(result.generatedAt) } }, orderBy: { effectiveFrom: "desc" } });
  assert.equal(result.policyVersion, policy.version);
  assert.equal(await prisma.appointment.count(), before);
  assert.ok(!JSON.stringify(result).includes("commissionRate"));
  assert.ok(!JSON.stringify(result).includes(f.booking.bookingCode));
  const people = await availability.catalog();
  assert.ok(people.staff.some(s => s.id === f.staff.id && s.serviceIds.includes(f.item.id)));
  assert.ok(!JSON.stringify(people).includes("phone"));
  await prisma.staffService.update({ where: { id: f.qualification.id }, data: { isActive: false } });
  assert.equal((await availability.search(input)).slots.length, 0);
  await prisma.staffService.update({ where: { id: f.qualification.id }, data: { isActive: true } });
  await prisma.staff.update({ where: { id: f.staff.id }, data: { isActive: false } });
  assert.equal((await availability.search(input)).slots.length, 0);
  assert.ok(!(await availability.catalog()).staff.some(s => s.id === f.staff.id));
  await prisma.staff.update({ where: { id: f.staff.id }, data: { isActive: true } });
  await prisma.service.update({ where: { id: f.item.id }, data: { isActive: false } });
  await assert.rejects(availability.search(input), { code: "SERVICE_UNAVAILABLE" });
});

test("availability reads fresh state and clock after waiting for configuration locks", async () => {
  const f = await fixture("PENDING_PAYMENT");
  const availability = createAvailabilityService(prisma, "Asia/Manila");
  const date = Temporal.Instant.fromEpochMilliseconds(+f.startAt).toZonedDateTimeISO("Asia/Manila").toPlainDate().toString();
  const input = { date, startAt: f.startAt.toISOString(), services: [{ serviceId: f.item.id, assignmentMode: "SPECIFIC" as const, staffId: f.staff.id }] };
  const blocker = await observer.connect();
  let pending: ReturnType<typeof availability.search> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock_shared($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('SELECT id FROM "Staff" WHERE id=$1 FOR UPDATE', [f.staff.id]);
    await prisma.appointment.update({ where: { id: f.booking.id }, data: { holdExpiresAt: new Date(Date.now() + 1500) } });
    pending = availability.search(input);
    await writerBlocked();
    await waitUntil(async () => (await observer.query('SELECT "holdExpiresAt" < clock_timestamp() AS expired FROM "Appointment" WHERE id=$1', [f.booking.id])).rows[0].expired);
    await blocker.query("COMMIT");
    assert.equal((await pending).slots.length, 1);
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1)", [SALON_COORDINATION_KEY]);
    await blocker.query('UPDATE "Service" SET "isActive"=false WHERE id=$1', [f.item.id]);
    const rejected = assert.rejects(availability.search(input), { code: "SERVICE_UNAVAILABLE" });
    await writerBlocked(); await blocker.query("COMMIT"); await rejected;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); if (pending) await pending; }
});

test("public availability HTTP validates plans, returns no-store results, and handles local dates", async () => {
  const f = await fixture();
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "CANCELLED" } });
  const config = parseEnv({ DATABASE_URL: url.toString(), JWT_SECRET: "phase4-test-secret-at-least-32-characters", NODE_ENV: "test" });
  const server = createApp(createApiRouter(prisma, config)).listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api/availability`;
  const post = (body: unknown) => fetch(root, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const date = Temporal.Instant.fromEpochMilliseconds(+f.startAt).toZonedDateTimeISO("Asia/Manila").toPlainDate().toString();
  const input = { date, services: [{ serviceId: f.item.id, assignmentMode: "ANY_AVAILABLE" }] };
  try {
    assert.equal((await fetch(`${root}/staff`)).status, 200);
    assert.equal((await post({ ...input, date: "2026-02-30" })).status, 400);
    assert.equal((await post({ ...input, services: [] })).status, 400);
    assert.equal((await post({ ...input, startAt: "2020-01-01T00:00:00Z" })).status, 400);
    const response = await post(input); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json(); assert.ok(body.slots.length > 0); assert.equal(body.timeZone, "Asia/Manila");
    assert.ok(body.slots.some((s: { startAt: string }) => s.startAt === f.startAt.toISOString()));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("staff profiles persist, are audited, and expose only public details with performed-visit counts", async () => {
  const f = await fixture();
  const profile = { title: "Senior stylist", bio: "Precision cuts", photoUrl: "https://example.com/stylist.jpg", languages: ["English", "Tagalog"], portfolio: [{ title: "Bob", imageUrl: "https://example.com/bob.jpg", caption: "Soft finish" }], reviews: [{ author: "Client A", rating: 5, text: "Lovely service" }] };
  await assert.rejects(service.saveStaffPublicProfile(cashierId, f.staff.id, profile), (error: unknown) => error instanceof ApiError && error.status === 403);
  await service.saveStaffPublicProfile(adminId, f.staff.id, profile);
  assert.deepEqual((await prisma.staff.findUniqueOrThrow({ where: { id: f.staff.id } })).publicProfile, profile);
  assert.equal(await prisma.auditLog.count({ where: { entityType: "StaffPublicProfile", entityId: f.staff.id } }), 1);
  const catalog = createAvailabilityService(prisma, "Asia/Manila");
  const publicStaff = () => catalog.catalog().then(result => result.staff.find(row => row.id === f.staff.id)!);
  assert.deepEqual((await publicStaff()).statistics, { appointmentsCompleted: 0, clientsServed: 0 });
  await prisma.appointment.update({ where: { id: f.booking.id }, data: { status: "COMPLETED" } });
  assert.deepEqual((await publicStaff()).statistics, { appointmentsCompleted: 0, clientsServed: 0 });
  await prisma.appointmentService.update({ where: { id: f.booking.appointmentServices[0]!.id }, data: { outcome: "PERFORMED", actualChargedAmount: "120.00", outcomeFinalizedAt: new Date(), outcomeFinalizedByUserId: adminId } });
  const person = await publicStaff();
  assert.deepEqual(person.publicProfile, profile);
  assert.deepEqual(person.statistics, { appointmentsCompleted: 1, clientsServed: 1 });
  assert.equal("phone" in person, false); assert.equal("commissionRate" in person, false);
  await service.saveStaff(adminId, { firstName: "Updated", lastName: f.staff.lastName, phone: null, isActive: true }, f.staff.id);
  assert.deepEqual((await publicStaff()).publicProfile, profile);
  await service.saveStaffPublicProfile(adminId, f.staff.id, { ...profile, photoUrl: null, portfolio: [], reviews: [] });
  assert.deepEqual((await publicStaff()).publicProfile, { ...profile, photoUrl: null, portfolio: [], reviews: [] });
  await prisma.staff.update({ where: { id: f.staff.id }, data: { isActive: false } });
  assert.equal(await publicStaff(), undefined);
});
