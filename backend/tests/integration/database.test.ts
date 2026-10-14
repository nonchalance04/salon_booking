import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { createDatabasePool } from "../../src/database/pool.js";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";
import { PrismaClient } from "../../generated/prisma/client.js";
import { once } from "node:events";
import { SignJWT } from "jose";
import { createApp } from "../../src/app/app.js";
import { createAuthRouter } from "../../src/modules/auth/auth.routes.js";
import { parseEnv } from "../../src/config/env.schema.js";

const run = promisify(execFile);
// Intentionally never load .env or fall back to DATABASE_URL.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_ADMIN_URL is required; use a dedicated local/CI PostgreSQL server with CREATEDB permission.");
const databaseName = `salon_test_${randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
testUrl.searchParams.delete("schema");
const admin = new Pool({ connectionString: adminUrl });
const pool = createDatabasePool(testUrl.toString());
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
let created = false;
const fixtureEnv = {
  ...process.env, DATABASE_URL: testUrl.toString(), NODE_ENV: "test",
  SEED_ADMIN_EMAIL: "admin@example.test", SEED_ADMIN_PASSWORD: "test-admin-password",
  SEED_CASHIER_EMAIL: "cashier@example.test", SEED_CASHIER_PASSWORD: "test-cashier-password",
};

async function cli(args: string[], env = fixtureEnv) {
  // Avoid leaking child-process environment or connection strings on failure.
  try {
    return await run(process.execPath, args, { env, timeout: 60_000 });
  } catch {
    throw new Error("Database fixture command failed. Run the documented migration/seed commands against a disposable database to diagnose.");
  }
}

const seed = () => cli(["--import", "tsx", "prisma/seed.ts"]);
before(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await cli(["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma7.config.ts"]);
  await seed();
}, { timeout: 90_000 });

after(async () => {
  await prisma.$disconnect();
  await pool.end();
  try {
    // Only remove the uniquely named database created by this test invocation.
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

async function appointment() {
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow();
  return prisma.appointment.create({ data: {
    bookingCode: randomUUID(), bookingPolicyVersion: { connect: { id: policy.id } },
    customer: { create: { firstName: "Test", lastName: "Guest", phone: "09000000000" } },
    status: "PENDING_PAYMENT", startAt: new Date("2026-10-10T01:00:00Z"),
    endAt: new Date("2026-10-10T01:30:00Z"), appointmentFeeAmount: "100.00",
    guestAccessTokenHash: "test-hash", holdExpiresAt: new Date("2026-10-09T01:10:00Z"),
  } });
}

test("migrations apply and development seeding is repeatable with hashed passwords", async () => {
  await seed();
  assert.deepEqual(await Promise.all([
    prisma.user.count(), prisma.salonProfile.count(), prisma.bookingPolicyVersion.count(),
    prisma.salonOperatingHour.count(), prisma.service.count(), prisma.staff.count(),
    prisma.staffService.count(), prisma.staffSchedule.count(),
  ]), [2, 1, 1, 7, 30, 5, 125, 35]);
  const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: fixtureEnv.SEED_ADMIN_EMAIL } });
  assert.ok(await bcrypt.compare(fixtureEnv.SEED_ADMIN_PASSWORD, adminUser.passwordHash));
  const policy = await prisma.bookingPolicyVersion.findFirstOrThrow();
  assert.equal(policy.appointmentFeeAmount.toFixed(2), "100.00");
  assert.equal(policy.effectiveFrom.toISOString(), "2026-09-30T16:00:00.000Z");
  const migrations = await pool.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL');
  assert.equal(migrations.rowCount, 8);
  const categoryCounts = await prisma.service.groupBy({ by: ["category"], _count: true });
  assert.deepEqual(Object.fromEntries(categoryCounts.map(row => [row.category, row._count])), {
    "Hair Services": 9, "Hair Color & Styling": 9, "Hair Treatments": 4,
    "Nail Services": 6, "Spa & Relaxation": 2,
  });
});

test("seed configures Mildred for explicit nail services and reconciles stale qualifications on rerun", async () => {
  const mildred = await prisma.staff.findFirstOrThrow({ where: { firstName: "Mildred" } });
  const active = () => prisma.staffService.findMany({ where: { staffId: mildred.id, isActive: true }, include: { service: true } });
  const expected = ["Manicure", "Pedicure", "Manicure & Pedicure", "Gel Polish", "Nail Art"].sort();
  assert.deepEqual((await active()).map(row => row.service.name).sort(), expected);
  const hair = await prisma.service.findFirstOrThrow({ where: { category: "Hair Services" } });
  const stale = await prisma.staffService.create({ data: { staffId: mildred.id, serviceId: hair.id, commissionRate: "0.4" } });
  const manicure = (await active()).find(row => row.service.name === "Manicure")!;
  await prisma.staffService.update({ where: { id: manicure.id }, data: { isActive: false, commissionRate: "0.5" } });
  await seed();
  assert.deepEqual((await active()).map(row => row.service.name).sort(), expected);
  assert.equal((await prisma.staffService.findUniqueOrThrow({ where: { id: stale.id } })).isActive, false);
  const restored = await prisma.staffService.findUniqueOrThrow({ where: { id: manicure.id } });
  assert.equal(restored.isActive, true);
  assert.equal(restored.commissionRate.toFixed(4), "0.4000");
  await seed();
  assert.equal(await prisma.staffService.count({ where: { staffId: mildred.id } }), 6);
});

test("seed refuses production execution and rolls back when another salon profile exists", async () => {
  await assert.rejects(cli(["--import", "tsx", "prisma/seed.ts"], { ...fixtureEnv, NODE_ENV: "production" }));
  const extra = await prisma.salonProfile.create({ data: { name: "Other", address: "Test" } });
  try {
    await assert.rejects(seed());
    assert.equal(await prisma.user.count(), 2);
  } finally {
    await prisma.salonProfile.delete({ where: { id: extra.id } });
  }
});

test("database enforces positive service values, commission range, and schedule ordering", async () => {
  const service = await prisma.service.findFirstOrThrow();
  for (const data of [{ price: "0.00" }, { durationMinutes: 0 }, { bufferMinutes: -1 }]) {
    await assert.rejects(prisma.service.update({ where: { id: service.id }, data }));
  }
  const qualification = await prisma.staffService.findFirstOrThrow();
  for (const commissionRate of ["-0.0001", "1.0001"]) {
    await assert.rejects(prisma.staffService.update({ where: { id: qualification.id }, data: { commissionRate } }));
  }
  const schedule = await prisma.staffSchedule.findFirstOrThrow();
  await assert.rejects(prisma.staffSchedule.update({ where: { id: schedule.id }, data: { endTime: schedule.startTime } }));
  const hours = await prisma.salonOperatingHour.findFirstOrThrow();
  await assert.rejects(prisma.salonOperatingHour.update({ where: { id: hours.id }, data: { closeTime: hours.openTime } }));
});

test("active service sequences are unique while removed history can retain a sequence", async () => {
  const booking = await appointment();
  const qualification = await prisma.staffService.findFirstOrThrow();
  const data = {
    appointmentId: booking.id, serviceId: qualification.serviceId, staffId: qualification.staffId,
    assignmentMode: "SPECIFIC" as const, sequenceNo: 1, serviceNameSnapshot: "Test",
    priceSnapshot: "120.00", durationMinutesSnapshot: 30, bufferMinutesSnapshot: 15,
    commissionRateSnapshot: "0.4000", scheduledStartAt: booking.startAt, scheduledEndAt: booking.endAt,
    reservedUntilAt: new Date("2026-10-10T01:45:00Z"),
  };
  await prisma.appointmentService.create({ data });
  await assert.rejects(prisma.appointmentService.create({ data }), { code: "P2002" });
  await prisma.appointmentService.create({ data: { ...data, membershipStatus: "REMOVED", removedAt: new Date() } });
  await assert.rejects(prisma.appointmentService.create({ data: { ...data, sequenceNo: 2, priceSnapshot: "0.00" } }));
  await assert.rejects(prisma.staff.delete({ where: { id: qualification.staffId } }), { code: "P2003" });
});

test("fee obligation and successful service payment uniqueness match their predicates", async () => {
  const booking = await appointment();
  const payment = (type: "APPOINTMENT_FEE" | "SERVICE_PAYMENT", status: "SUCCEEDED" | "FAILED", satisfiesObligation: boolean) =>
    prisma.payment.create({ data: {
      appointmentId: booking.id, type, status, satisfiesObligation, amount: "100.00",
      provider: "TEST", method: "CASH", idempotencyKey: randomUUID(),
    } });
  await payment("APPOINTMENT_FEE", "SUCCEEDED", true);
  await assert.rejects(payment("APPOINTMENT_FEE", "SUCCEEDED", true), { code: "P2002" });
  await payment("APPOINTMENT_FEE", "SUCCEEDED", false);
  await payment("APPOINTMENT_FEE", "FAILED", false);
  await payment("SERVICE_PAYMENT", "SUCCEEDED", true);
  await assert.rejects(payment("SERVICE_PAYMENT", "SUCCEEDED", false), { code: "P2002" });
  await payment("SERVICE_PAYMENT", "FAILED", false);
});

test("multi-record Prisma transactions roll back atomically", async () => {
  const id = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.customer.create({ data: { id, firstName: "Rollback", lastName: "Test", phone: "0" } });
    await tx.service.create({ data: { name: "Invalid", price: "-1", durationMinutes: 30 } });
  }));
  assert.equal(await prisma.customer.findUnique({ where: { id } }), null);
});

test("seed refuses to rewrite configuration after appointments exist", async () => {
  await appointment();
  const beforeSeed = await prisma.user.findUniqueOrThrow({ where: { email: fixtureEnv.SEED_ADMIN_EMAIL } });
  await assert.rejects(seed());
  const afterSeed = await prisma.user.findUniqueOrThrow({ where: { email: fixtureEnv.SEED_ADMIN_EMAIL } });
  assert.equal(afterSeed.passwordHash, beforeSeed.passwordHash);
});

test("money, instant storage, required partial indexes, and restrictive references exist", async () => {
  const money = await pool.query("SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'Payment' AND column_name = 'amount'");
  assert.deepEqual(money.rows[0], { data_type: "numeric", numeric_precision: 12, numeric_scale: 2 });
  const instant = await pool.query("SELECT data_type, datetime_precision FROM information_schema.columns WHERE table_name = 'Appointment' AND column_name = 'startAt'");
  assert.deepEqual(instant.rows[0], { data_type: "timestamp with time zone", datetime_precision: 3 });
  const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '% WHERE %'");
  assert.deepEqual(indexes.rows.map((row) => row.indexname).sort(), [
    "AppointmentService_active_sequence_unique", "Payment_appointment_fee_obligation_unique", "Payment_successful_service_payment_unique",
  ]);
  const foreignKeys = await pool.query("SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace");
  assert.ok(foreignKeys.rowCount && foreignKeys.rowCount > 0);
  const ephemeralGuestReferences = new Set(["AppointmentOtpChallenge_appointmentId_fkey", "AppointmentGuestSession_appointmentId_fkey"]);
  assert.ok(foreignKeys.rows.every((row) => row.confdeltype === (ephemeralGuestReferences.has(row.conname) ? "c" : "r")));
});

test("authentication and account management enforce browser and database permissions", async context => {
  const secret = "integration-auth-secret-at-least-32-characters";
  const origin = "http://localhost:5173";
  const app = createApp(createAuthRouter(prisma, parseEnv({
    DATABASE_URL: testUrl.toString(), JWT_SECRET: secret, NODE_ENV: "test", TRUSTED_ORIGINS: origin,
  })));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (path: string, method = "GET", body?: unknown, cookie?: string, headers: Record<string, string> = {}) => {
    const outgoing: Record<string, string> = { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers };
    // Test helper sentinel for a truly absent Origin header.
    if (outgoing.Origin === "__omit__") delete outgoing.Origin;
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method, headers: outgoing,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };
  const login = (email: string, password: string) => request("/auth/login", "POST", { email, password });
  let adminCookie = "";
  let cashierCookie = "";
  let newId = "";
  try {
    await context.test("login sets an HttpOnly bounded cookie, returns no secrets, restores current user", async () => {
      for (const [email, password] of [[fixtureEnv.SEED_ADMIN_EMAIL, "wrong"], ["missing@example.test", "wrong"]]) {
        const response = await login(email!, password!);
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error.code, "INVALID_CREDENTIALS");
      }
      const adminResponse = await login(fixtureEnv.SEED_ADMIN_EMAIL.toUpperCase(), fixtureEnv.SEED_ADMIN_PASSWORD);
      assert.equal(adminResponse.status, 200);
      const setCookie = adminResponse.headers.get("set-cookie")!;
      assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); assert.match(setCookie, /Max-Age=28800/);
      adminCookie = setCookie.split(";")[0]!;
      const result = await adminResponse.json();
      assert.equal(result.user.role, "ADMIN");
      assert.ok(!JSON.stringify(result).includes("password"));
      assert.ok(result.user.lastLoginAt);
      assert.equal((await request("/auth/me", "GET", undefined, adminCookie)).status, 200);
      assert.equal((await request("/auth/me")).status, 401);
      const cashier = await login(fixtureEnv.SEED_CASHIER_EMAIL, fixtureEnv.SEED_CASHIER_PASSWORD);
      assert.equal(cashier.status, 200);
      cashierCookie = cashier.headers.get("set-cookie")!.split(";")[0]!;
    });
    await context.test("CSRF, Referer fallback, and credentialed CORS reject untrusted or missing sources", async () => {
      for (const value of ["http://localhost:5173.evil.test", "null", "", "__omit__"]) {
        assert.equal((await request("/auth/logout", "POST", undefined, adminCookie, { Origin: value })).status, 403);
      }
      assert.equal((await request("/auth/logout", "POST", undefined, adminCookie, { Origin: "__omit__", Referer: `${origin}/workspace` })).status, 204);
      assert.equal((await request("/auth/logout", "POST", undefined, adminCookie, { Origin: "", Referer: origin })).status, 403);
      assert.equal((await request("/auth/logout", "POST", undefined, adminCookie, { Origin: "https://evil.test", Referer: origin })).status, 403);
      const preflight = await request("/users", "OPTIONS");
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
      assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
      const denied = await request("/users", "OPTIONS", undefined, undefined, { Origin: "https://evil.test" });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
    });
    await context.test("Cashier cannot list or mutate user accounts; Admin creates and edits with safe audit", async () => {
      const input = { email: "new@example.test", password: "new-account-password", firstName: "New", lastName: "Account", role: "CASHIER" };
      assert.equal((await request("/users", "GET", undefined, cashierCookie)).status, 403);
      assert.equal((await request("/users", "POST", input, cashierCookie)).status, 403);
      const created = await request("/users", "POST", input, adminCookie);
      assert.equal(created.status, 201);
      newId = (await created.json()).user.id;
      assert.equal((await request("/users", "POST", input, adminCookie)).status, 409);
      assert.equal((await request(`/users/${newId}`, "PATCH", { role: "ADMIN" }, cashierCookie)).status, 403);
      assert.equal((await request(`/users/${newId}`, "PATCH", { role: "STYLIST" }, adminCookie)).status, 400);
      assert.equal((await request(`/users/${newId}`, "PATCH", { firstName: "Updated", password: "replacement-password" }, adminCookie)).status, 200);
      const record = await prisma.user.findUniqueOrThrow({ where: { id: newId } });
      assert.ok(await bcrypt.compare("replacement-password", record.passwordHash));
      const audits = await prisma.auditLog.findMany({ where: { entityId: newId } });
      assert.equal(audits.length, 2);
      assert.ok(!JSON.stringify(audits).includes(record.passwordHash));
      assert.ok(!JSON.stringify(audits).includes("replacement-password"));
      assert.equal((await request(`/users/${newId}`, "DELETE", undefined, adminCookie)).status, 404);
    });
    await context.test("stale JWT role and deactivated accounts cannot retain access", async () => {
      assert.equal((await request(`/users/${newId}`, "PATCH", { role: "ADMIN" }, adminCookie)).status, 200);
      const response = await login("new@example.test", "replacement-password");
      const oldAdminCookie = response.headers.get("set-cookie")!.split(";")[0]!;
      assert.equal((await request("/users", "GET", undefined, oldAdminCookie)).status, 200);
      await request(`/users/${newId}`, "PATCH", { role: "CASHIER" }, adminCookie);
      assert.equal((await request("/users", "GET", undefined, oldAdminCookie)).status, 403);
      const me = await request("/auth/me", "GET", undefined, oldAdminCookie);
      assert.equal((await me.json()).user.role, "CASHIER");
      await request(`/users/${newId}`, "PATCH", { isActive: false }, adminCookie);
      assert.equal((await request("/auth/me", "GET", undefined, oldAdminCookie)).status, 401);
      assert.equal((await login("new@example.test", "replacement-password")).status, 401);
      await request(`/users/${newId}`, "PATCH", { firstName: "Still inactive" }, adminCookie);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: newId } })).isActive, false);
    });
    await context.test("expired and forged tokens fail and logout clears the matching cookie", async () => {
      const token = await new SignJWT({ role: "ADMIN" }).setProtectedHeader({ alg: "HS256" }).setSubject(newId).setIssuedAt().setExpirationTime("0s").sign(new TextEncoder().encode(secret));
      for (const cookie of [`salon_session=${token}`, "salon_session=forged", "salon_session=%invalid"]) {
        assert.equal((await request("/auth/me", "GET", undefined, cookie)).status, 401);
      }
      const logout = await request("/auth/logout", "POST", undefined, adminCookie);
      assert.equal(logout.status, 204);
      assert.match(logout.headers.get("set-cookie")!, /salon_session=;/);
      assert.match(logout.headers.get("set-cookie")!, /Path=\/api/);
      assert.equal((await request("/auth/me")).status, 401);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
