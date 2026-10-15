import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createConfigurationService } from "../src/modules/configuration/configuration.service.js";

function fixture({ active = true, missing = false, role = "ADMIN", authorized = true, reserved = false } = {}) {
  const staff = { id: "staff-id", firstName: "Jamie", lastName: "Santos", isActive: active, phone: "09123456789" };
  const audits: unknown[] = [];
  let updates = 0;
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ epochMs: Date.now() }],
    user: { findUnique: async () => ({ isActive: authorized, role }) },
    staff: {
      findUnique: async () => missing ? null : { ...staff },
      update: async ({ data }: { data: { isActive: boolean } }) => { updates++; return Object.assign(staff, data); },
    },
    appointmentService: { findMany: async () => reserved ? [{
      id: "reservation-id", appointmentId: "appointment-id", appointment: { bookingCode: "BOOKING", status: "CONFIRMED" },
      scheduledStartAt: new Date(Date.now() + 60_000), reservedUntilAt: new Date(Date.now() + 120_000),
    }] : [] },
    auditLog: { create: async (entry: unknown) => { audits.push(entry); } },
  };
  const prisma = { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
  return { service: createConfigurationService(prisma, "Asia/Manila"), staff, audits, updates: () => updates };
}

test("staff deletion deactivates the record without changing staff details and audits the change", async () => {
  const f = fixture();
  await f.service.removeStaff("admin-id", f.staff.id);
  assert.deepEqual(f.staff, { id: "staff-id", firstName: "Jamie", lastName: "Santos", isActive: false, phone: "09123456789" });
  assert.equal(f.audits.length, 1);
  const audit = f.audits[0] as { data: { beforeData: { isActive: boolean }; afterData: { isActive: boolean }; entityType: string } };
  assert.equal(audit.data.entityType, "Staff");
  assert.equal(audit.data.beforeData.isActive, true);
  assert.equal(audit.data.afterData.isActive, false);
  await f.service.removeStaff("admin-id", f.staff.id);
  assert.equal(f.updates(), 1);
  assert.equal(f.audits.length, 1);
});

test("staff deletion rejects blocking reservations without changing or auditing staff", async () => {
  const f = fixture({ reserved: true });
  await assert.rejects(f.service.removeStaff("admin-id", f.staff.id), { code: "RESERVATION_CONFLICT" });
  assert.equal(f.staff.isActive, true);
  assert.equal(f.updates(), 0);
  assert.equal(f.audits.length, 0);
});

test("staff deletion requires an active administrator", async () => {
  for (const [options, code] of [[{ role: "CASHIER" }, "FORBIDDEN"], [{ authorized: false }, "UNAUTHORIZED"]] as const) {
    const f = fixture(options);
    await assert.rejects(f.service.removeStaff("actor-id", f.staff.id), { code });
    assert.equal(f.updates(), 0);
    assert.equal(f.audits.length, 0);
  }
});

test("staff deletion reports missing records and leaves already inactive staff unchanged", async () => {
  const missing = fixture({ missing: true });
  await assert.rejects(missing.service.removeStaff("admin-id", "missing-id"), { code: "NOT_FOUND" });
  const inactive = fixture({ active: false });
  await inactive.service.removeStaff("admin-id", inactive.staff.id);
  assert.equal(inactive.updates(), 0);
  assert.equal(inactive.audits.length, 0);
});
