import type { Prisma } from "../../../generated/prisma/client.js";
import { ApiError } from "../../shared/http.js";
import { localDay } from "./availability.engine.js";
import type { AvailabilityInput } from "./availability.schema.js";

// Caller owns coordination/Staff locks. Booking additionally verifies that every
// freshly discovered candidate belongs to its complete ordered lock set.
export async function loadAvailabilityData(tx: Prisma.TransactionClient, input: AvailabilityInput, timeZone: string, now: Date,
  policy: Awaited<ReturnType<Prisma.TransactionClient["bookingPolicyVersion"]["findFirstOrThrow"]>>,
  options: { retainedServiceIds?: string[]; excludeAppointmentId?: string } = {}) {
  if (new Set(input.services.map(service => service.serviceId)).size !== input.services.length) {
    throw new ApiError(400, "DUPLICATE_SERVICE", "Select each service only once.");
  }
  const day = localDay(input.date, timeZone);
  const services = await tx.service.findMany({ where: { id: { in: input.services.map(s => s.serviceId) }, OR: [{ isActive: true }, { id: { in: options.retainedServiceIds ?? [] } }] } });
  if (input.services.some(s => !services.some(row => row.id === s.serviceId))) {
    throw new ApiError(400, "SERVICE_UNAVAILABLE", "One or more selected services are no longer bookable.");
  }
  const categories = services.map(service => service.category.trim().toLowerCase());
  if (new Set(categories).size !== categories.length) {
    throw new ApiError(400, "DUPLICATE_SERVICE_CATEGORY", "Select only one service per category.");
  }
  const staff = await tx.staff.findMany({ where: { isActive: true }, select: { id: true, firstName: true, lastName: true } });
  const qualifications = await tx.staffService.findMany({ where: { isActive: true, serviceId: { in: services.map(s => s.id) } }, select: { staffId: true, serviceId: true, commissionRate: true } });
  const hours = await tx.salonOperatingHour.findMany({ where: { isActive: true } });
  const schedules = await tx.staffSchedule.findMany({ where: { isActive: true, staffId: { in: staff.map(s => s.id) } } });
  const interval = { startsAt: { lt: day.end }, endsAt: { gt: day.start } };
  const closures = await tx.salonClosure.findMany({ where: interval });
  const unavailability = await tx.staffUnavailability.findMany({ where: { ...interval, staffId: { in: staff.map(s => s.id) } } });
  const reservations = await tx.appointmentService.findMany({ where: {
    appointmentId: options.excludeAppointmentId ? { not: options.excludeAppointmentId } : undefined,
    membershipStatus: "ACTIVE", staffId: { in: staff.map(s => s.id) }, scheduledStartAt: { lt: day.end }, reservedUntilAt: { gt: day.start },
    appointment: { OR: [{ status: "CONFIRMED" }, { status: "COMPLETED" }, { status: "PENDING_PAYMENT", holdExpiresAt: { gte: now } }] },
  }, select: { staffId: true, scheduledStartAt: true, reservedUntilAt: true, membershipStatus: true, appointment: { select: { status: true, holdExpiresAt: true } } } });
  return { now, timeZone, policy, services, staff, qualifications, hours: hours.map(h => ({ ...h, startTime: h.openTime, endTime: h.closeTime })), schedules, closures, unavailability, reservations };
}
