import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { ApiError } from "../../shared/http.js";
import { lockSalon, lockStaff, freshTime } from "../scheduling/coordination.js";
import { coversReservation, overlaps } from "../scheduling/coverage.js";
import type { StaffSkillsInput, StaffPublicProfileInput, ProfileInput, ServiceInput, StaffInput, QualificationInput, HoursInput, ScheduleInput, ClosureInput, UnavailabilityInput, PolicyInput } from "./configuration.schema.js";

type Tx = Prisma.TransactionClient;
const time = (value: string) => new Date(`1970-01-01T${value.length === 5 ? `${value}:00` : value}Z`);
const date = (value: string | null) => value ? new Date(`${value}T00:00:00Z`) : null;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const required = <T>(value: T | null): T => {
  if (value === null) throw new ApiError(404, "NOT_FOUND", "Configuration record not found.");
  return value;
};

async function audit(tx: Tx, actorId: string, entity: string, id: string, before: unknown, after: unknown) {
  await tx.auditLog.create({ data: {
    actorType: "ADMIN", actorUserId: actorId, action: after === null ? "CONFIGURATION_REMOVED" : before === null ? "CONFIGURATION_CREATED" : "CONFIGURATION_UPDATED",
    entityType: entity, entityId: id,
    ...(before === null ? {} : { beforeData: json(before) }),
    ...(after === null ? {} : { afterData: json(after) }),
  } });
}

export function createConfigurationService(prisma: PrismaClient, timeZone: string) {
  async function write<T>(actorId: string, mode: "shared" | "exclusive", staffIds: string[], operation: (tx: Tx) => Promise<T>) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await lockSalon(tx, mode);
        await lockStaff(tx, staffIds);
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId}::uuid FOR SHARE`;
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor?.isActive) throw new ApiError(401, "UNAUTHORIZED", "Please sign in again.");
        if (actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Administrator access is required.");
        return operation(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") throw new ApiError(409, "CONFIGURATION_EXISTS", "This qualification or policy effective time already exists.");
        if (error.code === "P2003") throw new ApiError(400, "INVALID_REFERENCE", "Select an existing staff member or service.");
        if (error.code === "P2025") throw new ApiError(404, "NOT_FOUND", "Configuration record not found.");
        if (["P2028", "P2034"].includes(error.code) || String(error.meta?.code) === "55P03") {
          throw new ApiError(409, "CONFIGURATION_BUSY", "Another change is in progress. Please try again.");
        }
      }
      throw error;
    }
  }

  // Validate only the dimension being changed. Current prices, durations, and
  // commission rates must never replace an existing reservation's snapshots.
  async function protect(tx: Tx, where: Prisma.AppointmentServiceWhereInput,
    invalid: (row: Prisma.AppointmentServiceGetPayload<{ include: { appointment: true } }>) => boolean) {
    const now = await freshTime(tx);
    const reservations = await tx.appointmentService.findMany({
      where: { AND: [where, { membershipStatus: "ACTIVE", reservedUntilAt: { gt: now }, appointment: {
        OR: [{ status: "CONFIRMED" }, { status: "PENDING_PAYMENT", holdExpiresAt: { gte: now } }],
      } }] }, include: { appointment: true },
      orderBy: [{ scheduledStartAt: "asc" }, { id: "asc" }],
    });
    const conflicts = reservations.filter(invalid).map(row => ({
      appointmentId: row.appointmentId, bookingCode: row.appointment.bookingCode,
      status: row.appointment.status, appointmentServiceId: row.id,
      startAt: row.scheduledStartAt.toISOString(), reservedUntilAt: row.reservedUntilAt.toISOString(),
    }));
    if (conflicts.length) throw new ApiError(409, "RESERVATION_CONFLICT",
      "This change would invalidate existing reservations. Resolve the listed appointments first.", { appointments: conflicts });
  }

  return {
    async snapshot() {
      const [profile, services, staff, qualifications, hours, closures, schedules, unavailability, policies] = await prisma.$transaction([
        prisma.salonProfile.findFirst(), prisma.service.findMany({ orderBy: { name: "asc" } }),
        prisma.staff.findMany({ orderBy: [{ firstName: "asc" }, { id: "asc" }] }),
        prisma.staffService.findMany({ orderBy: { id: "asc" } }),
        prisma.salonOperatingHour.findMany({ orderBy: { openTime: "asc" } }),
        prisma.salonClosure.findMany({ orderBy: { startsAt: "asc" } }),
        prisma.staffSchedule.findMany({ orderBy: { startTime: "asc" } }),
        prisma.staffUnavailability.findMany({ orderBy: { startsAt: "asc" } }),
        prisma.bookingPolicyVersion.findMany({ orderBy: { effectiveFrom: "desc" } }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return { timeZone, profile, services, staff, qualifications, hours, closures, schedules, unavailability, policies };
    },
    publicPolicy() {
      return prisma.bookingPolicyVersion.findFirst({ where: { effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: "desc" }, select: { version: true, appointmentFeeType: true, appointmentFeeAmount: true, bookingHoldMinutes: true, maxReschedules: true, rescheduleCutoffHours: true, cancellationCutoffHours: true, noShowGraceHours: true, advanceBookingDays: true, minimumBookingLeadMinutes: true } });
    },
    async publicSalon() {
      const [profile, hours, closures] = await Promise.all([
        prisma.salonProfile.findFirst({ select: { name: true, phone: true, email: true, address: true } }),
        prisma.salonOperatingHour.findMany({ where: { isActive: true }, select: { dayOfWeek: true, openTime: true, closeTime: true }, orderBy: { openTime: "asc" } }),
        prisma.salonClosure.findMany({ where: { endsAt: { gt: new Date() } }, select: { startsAt: true, endsAt: true }, orderBy: { startsAt: "asc" } }),
      ]);
      return { profile, timeZone, hours, closures };
    },
    publicServices() {
      return prisma.service.findMany({ where: { isActive: true }, select: {
        id: true, name: true, category: true, description: true, price: true, durationMinutes: true,
      }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    },
    saveProfile(actorId: string, input: ProfileInput) {
      return write(actorId, "exclusive", [], async tx => {
        const profiles = await tx.salonProfile.findMany();
        if (profiles.length > 1) throw new ApiError(409, "PROFILE_INVARIANT", "The database contains more than one salon profile.");
        const before = profiles[0] ?? null;
        const row = before ? await tx.salonProfile.update({ where: { id: before.id }, data: input }) : await tx.salonProfile.create({ data: input });
        await audit(tx, actorId, "SalonProfile", row.id, before, row);
        return row;
      });
    },
    saveService(actorId: string, input: ServiceInput, id?: string) {
      return write(actorId, "exclusive", [], async tx => {
        const before = id ? required(await tx.service.findUnique({ where: { id } })) : null;
        const row = id ? await tx.service.update({ where: { id }, data: input }) : await tx.service.create({ data: input });
        if (before?.isActive && !row.isActive) await protect(tx, { serviceId: row.id }, () => true);
        await audit(tx, actorId, "Service", row.id, before, row);
        return row;
      });
    },
    saveStaff(actorId: string, input: StaffInput, id?: string) {
      return write(actorId, "shared", id ? [id] : [], async tx => {
        const before = id ? required(await tx.staff.findUnique({ where: { id } })) : null;
        const row = id ? await tx.staff.update({ where: { id }, data: input }) : await tx.staff.create({ data: input });
        if (before?.isActive && !row.isActive) await protect(tx, { staffId: row.id }, () => true);
        await audit(tx, actorId, "Staff", row.id, before, row);
        return row;
      });
    },
    removeStaff(actorId: string, id: string) {
      return write(actorId, "shared", [id], async tx => {
        const before = required(await tx.staff.findUnique({ where: { id } }));
        if (!before.isActive) return;
        await protect(tx, { staffId: id }, () => true);
        const row = await tx.staff.update({ where: { id }, data: { isActive: false } });
        await audit(tx, actorId, "Staff", id, before, row);
      });
    },
    saveStaffPublicProfile(actorId: string, id: string, input: StaffPublicProfileInput) {
      return write(actorId, "shared", [id], async tx => {
        const before = required(await tx.staff.findUnique({ where: { id } }));
        const row = await tx.staff.update({ where: { id }, data: { publicProfile: json(input) } });
        await audit(tx, actorId, "StaffPublicProfile", id, before.publicProfile, row.publicProfile);
        return row;
      });
    },
    saveQualification(actorId: string, input: QualificationInput, id?: string) {
      return write(actorId, "shared", [input.staffId], async tx => {
        const before = id ? required(await tx.staffService.findUnique({ where: { id } })) : null;
        if (before && (before.staffId !== input.staffId || before.serviceId !== input.serviceId)) {
          throw new ApiError(400, "INVALID_REFERENCE", "Deactivate the old qualification and create a new one to change its staff or service.");
        }
        const row = id ? await tx.staffService.update({ where: { id }, data: input }) : await tx.staffService.create({ data: input });
        if (before?.isActive && !row.isActive) await protect(tx, { staffId: row.staffId, serviceId: row.serviceId }, () => true);
        await audit(tx, actorId, "StaffService", row.id, before, row);
        return row;
      });
    },
    saveStaffSkills(actorId: string, staffId: string, input: StaffSkillsInput) {
      return write(actorId, "shared", [staffId], async tx => {
        required(await tx.staff.findUnique({ where: { id: staffId } }));
        const existing = await tx.staffService.findMany({ where: { staffId } });
        const selected = new Map(input.services.map(row => [row.serviceId, row]));
        const services = await tx.service.findMany({ where: { id: { in: [...selected.keys()] } } });
        if (services.length !== selected.size) throw new ApiError(400, "INVALID_REFERENCE", "Select existing services.");
        // Existing qualifications for inactive menu items can be retained, but
        // inactive services cannot be newly enabled through the skills editor.
        if (services.some(row => !row.isActive && !existing.some(q => q.serviceId === row.id && q.isActive))) {
          throw new ApiError(400, "SERVICE_UNAVAILABLE", "Inactive services cannot be newly assigned.");
        }
        const removed = existing.filter(row => row.isActive && !selected.has(row.serviceId));
        if (removed.length) await protect(tx, { staffId, serviceId: { in: removed.map(row => row.serviceId) } }, () => true);
        for (const before of removed) {
          const row = await tx.staffService.update({ where: { id: before.id }, data: { isActive: false } });
          await audit(tx, actorId, "StaffService", row.id, before, row);
        }
        for (const item of input.services) {
          const before = existing.find(row => row.serviceId === item.serviceId) ?? null;
          if (before?.isActive && before.commissionRate.equals(item.commissionRate)) continue;
          const data = { staffId, ...item, isActive: true };
          const row = before ? await tx.staffService.update({ where: { id: before.id }, data }) : await tx.staffService.create({ data });
          await audit(tx, actorId, "StaffService", row.id, before, row);
        }
        return tx.staffService.findMany({ where: { staffId }, orderBy: { id: "asc" } });
      });
    },
    saveHours(actorId: string, input: HoursInput, id?: string) {
      return write(actorId, "exclusive", [], async tx => {
        const before = id ? required(await tx.salonOperatingHour.findUnique({ where: { id } })) : null;
        const data = { ...input, openTime: time(input.openTime), closeTime: time(input.closeTime) };
        const row = id ? await tx.salonOperatingHour.update({ where: { id }, data }) : await tx.salonOperatingHour.create({ data });
        const hours = await tx.salonOperatingHour.findMany({ where: { isActive: true } });
        const windows = hours.map(h => ({ ...h, startTime: h.openTime, endTime: h.closeTime }));
        if (before) await protect(tx, {}, r => !coversReservation(r.scheduledStartAt, r.reservedUntilAt, windows, timeZone));
        await audit(tx, actorId, "SalonOperatingHour", row.id, before, row);
        return row;
      });
    },
    saveSchedule(actorId: string, input: ScheduleInput, id?: string) {
      return write(actorId, "shared", [input.staffId], async tx => {
        const before = id ? required(await tx.staffSchedule.findUnique({ where: { id } })) : null;
        if (before && before.staffId !== input.staffId) throw new ApiError(400, "INVALID_REFERENCE", "Create a separate schedule for a different staff member.");
        const data = { ...input, startTime: time(input.startTime), endTime: time(input.endTime), effectiveFrom: date(input.effectiveFrom), effectiveTo: date(input.effectiveTo) };
        const row = id ? await tx.staffSchedule.update({ where: { id }, data }) : await tx.staffSchedule.create({ data });
        const schedules = await tx.staffSchedule.findMany({ where: { staffId: input.staffId, isActive: true } });
        if (before) await protect(tx, { staffId: input.staffId }, r => !coversReservation(r.scheduledStartAt, r.reservedUntilAt, schedules, timeZone));
        await audit(tx, actorId, "StaffSchedule", row.id, before, row);
        return row;
      });
    },
    saveClosure(actorId: string, input: ClosureInput, id?: string) {
      return write(actorId, "exclusive", [], async tx => {
        const before = id ? required(await tx.salonClosure.findUnique({ where: { id } })) : null;
        const row = id ? await tx.salonClosure.update({ where: { id }, data: input }) : await tx.salonClosure.create({ data: { ...input, createdByUserId: actorId } });
        await protect(tx, { scheduledStartAt: { lt: row.endsAt }, reservedUntilAt: { gt: row.startsAt } }, r => overlaps(r.scheduledStartAt, r.reservedUntilAt, row.startsAt, row.endsAt));
        await audit(tx, actorId, "SalonClosure", row.id, before, row);
        return row;
      });
    },
    saveUnavailability(actorId: string, input: UnavailabilityInput, id?: string) {
      return write(actorId, "shared", [input.staffId], async tx => {
        const before = id ? required(await tx.staffUnavailability.findUnique({ where: { id } })) : null;
        if (before && before.staffId !== input.staffId) throw new ApiError(400, "INVALID_REFERENCE", "Create a separate unavailable period for a different staff member.");
        const row = id ? await tx.staffUnavailability.update({ where: { id }, data: input }) : await tx.staffUnavailability.create({ data: { ...input, createdByUserId: actorId } });
        await protect(tx, { staffId: row.staffId, scheduledStartAt: { lt: row.endsAt }, reservedUntilAt: { gt: row.startsAt } }, () => true);
        await audit(tx, actorId, "StaffUnavailability", row.id, before, row);
        return row;
      });
    },
    removeClosure(actorId: string, id: string) {
      return write(actorId, "exclusive", [], async tx => {
        const before = required(await tx.salonClosure.findUnique({ where: { id } }));
        await tx.salonClosure.delete({ where: { id } });
        await audit(tx, actorId, "SalonClosure", id, before, null);
      });
    },
    async removeUnavailability(actorId: string, id: string) {
      // Staff assignment is immutable, so this preliminary lookup determines the
      // ordered lock set safely; the row is reloaded after locking.
      const preliminary = required(await prisma.staffUnavailability.findUnique({ where: { id } }));
      return write(actorId, "shared", [preliminary.staffId], async tx => {
        const before = required(await tx.staffUnavailability.findUnique({ where: { id } }));
        await tx.staffUnavailability.delete({ where: { id } });
        await audit(tx, actorId, "StaffUnavailability", id, before, null);
      });
    },
    createPolicy(actorId: string, input: PolicyInput) {
      return write(actorId, "exclusive", [], async tx => {
        const now = await freshTime(tx);
        if (input.effectiveFrom && input.effectiveFrom < now) throw new ApiError(400, "POLICY_IN_PAST", "New policies must take effect now or in the future.");
        const latest = await tx.bookingPolicyVersion.aggregate({ _max: { version: true } });
        const row = await tx.bookingPolicyVersion.create({ data: {
          ...input, version: (latest._max.version ?? 0) + 1,
          effectiveFrom: input.effectiveFrom ?? now, createdByUserId: actorId,
        } });
        await audit(tx, actorId, "BookingPolicyVersion", row.id, null, row);
        return row;
      });
    },
  };
}
