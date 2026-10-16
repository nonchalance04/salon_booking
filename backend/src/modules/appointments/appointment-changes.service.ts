import { coversReservation, overlaps } from "../scheduling/coverage.js";
import { noShowCorrectionSchema, type NoShowCorrectionInput } from "./appointments.schema.js";
import {
  Prisma,
  type PrismaClient,
  type NotificationEventType,
} from "../../../generated/prisma/client.js";
import { ApiError } from "../../shared/http.js";
import { freshTime, lockStaff } from "../scheduling/coordination.js";
import { loadAvailabilityData } from "../availability/availability.data.js";
import {
  calculateAvailability,
  planAt,
  type AvailabilityData,
} from "../availability/availability.engine.js";
import type { AvailabilityInput } from "../availability/availability.schema.js";
import {
  createGuestCredentials,
  validGuestAccess,
} from "./appointments.security.js";
import {
  guestSelect,
  guestView,
  reservationTransaction,
  RestartReservation,
} from "./appointments.service.js";
import { Temporal } from "@js-temporal/polyfill";
import type {
  AppointmentListQuery,
  ChangeInput,
  ChangeSearch,
} from "./appointments.schema.js";

/**
 * Shorthand type alias for Prisma's transaction client.
 */
type Tx = Prisma.TransactionClient;

/**
 * Standard relations loaded when inspecting or updating an appointment for changes.
 * Includes policy rules, customer info, ordered service line items, and any linked recovery appointment.
 */
const include = {
  bookingPolicyVersion: true,
  customer: true,
  appointmentServices: { orderBy: { sequenceNo: "asc" as const } },
  recoveryAppointment: true,
};

/**
 * Type representing an appointment record with all standard change-service relations included.
 */
type Row = Prisma.AppointmentGetPayload<{ include: typeof include }>;

/**
 * Helper to construct an HTTP 409 Conflict error when an appointment modification is prohibited.
 */
const conflict = (message: string) =>
  new ApiError(409, "CHANGE_NOT_ALLOWED", message);

/**
 * Validates whether an appointment is eligible for rescheduling or no-show recovery.
 *
 * Enforces key business policy rules:
 * 1. Reschedule Limit: Cannot exceed `policy.maxReschedules`.
 * 2. No-Show Recovery Mode (`recovery: true`):
 *    - Appointment must be in `NO_SHOW` status.
 *    - No recovery appointment must have already been booked from it.
 *    - Must be within the grace period (`startAt + policy.noShowGraceHours`).
 * 3. Ordinary Reschedule (`recovery: false`):
 *    - Appointment must be in `CONFIRMED` status.
 *    - Must be requested before the cutoff window (`startAt - policy.rescheduleCutoffHours`).
 *
 * @throws {ApiError} 409 Conflict if any eligibility condition is violated.
 */
export function validateChangeEligibility(
  row: {
    status: string;
    startAt: Date;
    rescheduleCount: number;
    recoveryAppointment: unknown;
    bookingPolicyVersion: {
      maxReschedules: number;
      rescheduleCutoffHours: number;
      noShowGraceHours: number;
    };
  },
  recovery: boolean,
  now: Date,
) {
  const policy = row.bookingPolicyVersion;
  if (row.rescheduleCount >= policy.maxReschedules) {
    throw conflict(
      "The maximum number of appointment changes has been reached.",
    );
  }
  if (recovery) {
    if (row.status !== "NO_SHOW" || row.recoveryAppointment) {
      throw conflict(
        "This appointment is not eligible for another recovery booking.",
      );
    }
    if (+now > +row.startAt + policy.noShowGraceHours * 3_600_000) {
      throw conflict("The no-show recovery grace period has ended.");
    }
  } else {
    if (
      row.status !== "CONFIRMED" ||
      +now > +row.startAt - policy.rescheduleCutoffHours * 3_600_000
    ) {
      throw conflict(
        "This appointment can no longer be rescheduled. Please contact the salon.",
      );
    }
  }
}

/**
 * Asserts that the appointment is in a "pristine" state with no service outcomes recorded.
 *
 * Protects settled or in-progress appointments from modifications:
 * - Rejects if the appointment is already completed (`completedAt`).
 * - Rejects if any active service has an outcome other than `SCHEDULED` or has `outcomeFinalizedAt`.
 *
 * @throws {ApiError} 409 Conflict if staff has already begun recording service outcomes.
 */
function pristine(row: Row) {
  if (
    row.checkedInAt ||
    row.completedAt ||
    row.appointmentServices.some(
      (s) =>
        s.membershipStatus === "ACTIVE" &&
        (s.outcome !== "SCHEDULED" || s.outcomeFinalizedAt),
    )
  ) {
    throw conflict(
      "The customer has checked in or service outcomes have already been recorded. Please contact the salon.",
    );
  }
}

export const NO_SHOW_ARRIVAL_GRACE_MS = 15 * 60_000;

export function eligibleForAutomaticNoShow(row: {
  status: string; startAt: Date; checkedInAt: Date | null; completedAt: Date | null;
  completionType: string | null;
  appointmentServices: { membershipStatus: string; outcome: string; outcomeFinalizedAt: Date | null }[];
}, now: Date) {
  return row.status === "CONFIRMED" && !row.checkedInAt && !row.completedAt && !row.completionType &&
    +now >= +row.startAt + NO_SHOW_ARRIVAL_GRACE_MS &&
    !row.appointmentServices.some(s => s.membershipStatus === "ACTIVE" &&
      (s.outcome !== "SCHEDULED" || s.outcomeFinalizedAt));
}

/**
 * Authorizes an active Admin, or an active Cashier when explicitly permitted.
 *
 * Uses a `FOR SHARE` row lock to guard against concurrent role or active-status downgrades.
 *
 * @throws {ApiError} 401 Unauthorized if inactive or not found, 403 Forbidden if the role is not permitted.
 */
async function admin(tx: Tx, actorId: string, allowCashier = false) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId}::uuid FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: actorId } });
  if (!user?.isActive)
    throw new ApiError(401, "UNAUTHORIZED", "Please sign in again.");
  if (user.role !== "ADMIN" && !(allowCashier && user.role === "CASHIER"))
    throw new ApiError(403, "FORBIDDEN", allowCashier ? "Admin or Cashier access is required." : "Administrator access is required.");
  return user;
}

/**
 * Acquires pessimistic concurrency locks on staff members and the appointment record.
 *
 * Coordination flow:
 * 1. Locks all existing staff IDs across the salon using `lockStaff()` to maintain strict lock ordering and avoid deadlocks.
 * 2. Acquires a row-level `FOR UPDATE` lock on the target appointment by `bookingCode`.
 * 3. Validates guest access credentials (token or active session cookie) if a token was supplied.
 * 4. Ensures no appointment service belongs to a staff member discovered out-of-order; if so, restarts the transaction.
 *
 * @returns The locked appointment row and the array of locked staff IDs.
 */
async function lockAppointment(tx: Tx, bookingCode: string, token?: string) {
  const lockedIds = (await tx.staff.findMany({ select: { id: true } })).map(
    (s) => s.id,
  );
  await lockStaff(tx, lockedIds);
  await tx.$queryRaw`SELECT id FROM "Appointment" WHERE "bookingCode" = ${bookingCode} FOR UPDATE`;
  const row = await tx.appointment.findUnique({
    where: { bookingCode },
    include,
  });
  const valid = token === undefined || (await validGuestAccess(tx, token, row));
  if (!row || !valid)
    throw new ApiError(
      404,
      "APPOINTMENT_NOT_FOUND",
      "Unable to access this appointment. Verify your phone number on Your appointment or contact the salon.",
    );
  if (row.appointmentServices.some((s) => !lockedIds.includes(s.staffId)))
    throw new RestartReservation();
  return { row, lockedIds };
}

/**
 * Creates an immutable, sanitized JSON snapshot of an appointment and its services.
 *
 * Used for storing `beforeSnapshot` and `afterSnapshot` in `AppointmentRescheduleHistory`
 * and system `AuditLog`. Uses an explicit allowlist so no customer PII, secret guest tokens,
 * or external payment provider credentials leak into historical logs.
 */
function snapshot(row: Row): Prisma.InputJsonValue {
  // Explicit allowlist: no contact details, credentials, or provider metadata.
  return {
    id: row.id,
    bookingPolicyVersionId: row.bookingPolicyVersionId,
    status: row.status,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    appointmentFeeAmount: row.appointmentFeeAmount.toFixed(2),
    rescheduleCount: row.rescheduleCount,
    recoveryOfAppointmentId: row.recoveryOfAppointmentId,
    carriedAppointmentFeePaymentId: row.carriedAppointmentFeePaymentId,
    appointmentServices: row.appointmentServices.map((s) => ({
      id: s.id,
      serviceId: s.serviceId,
      staffId: s.staffId,
      assignmentMode: s.assignmentMode,
      membershipStatus: s.membershipStatus,
      sequenceNo: s.sequenceNo,
      serviceNameSnapshot: s.serviceNameSnapshot,
      priceSnapshot: s.priceSnapshot.toFixed(2),
      durationMinutesSnapshot: s.durationMinutesSnapshot,
      bufferMinutesSnapshot: s.bufferMinutesSnapshot,
      commissionRateSnapshot: s.commissionRateSnapshot.toFixed(4),
      scheduledStartAt: s.scheduledStartAt.toISOString(),
      scheduledEndAt: s.scheduledEndAt.toISOString(),
      reservedUntilAt: s.reservedUntilAt.toISOString(),
      outcome: s.outcome,
      removedAt: s.removedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Enqueues a notification event in the database outbox (`NotificationQueue`).
 *
 * Delivers by EMAIL if an email exists on the customer profile, otherwise falls back to SMS.
 */
async function notify(
  tx: Tx,
  row: Row,
  eventType: NotificationEventType,
  now: Date,
) {
  await tx.notificationQueue.create({
    data: {
      appointmentId: row.id,
      customerId: row.customerId,
      eventType,
      channel: row.customer.email ? "EMAIL" : "SMS",
      recipient: row.customer.email ?? row.customer.phone,
      status: "PENDING",
      scheduledAt: now,
      payload: {
        schemaVersion: 1,
        bookingCode: row.bookingCode,
        appointmentStatus: row.status,
        startAt: row.startAt.toISOString(),
        recoveryOfAppointmentId: row.recoveryOfAppointmentId,
      },
    },
  });
}

/**
 * Validates and prepares availability and service configuration for an appointment change.
 *
 * Process:
 * 1. Validates change eligibility and pristine condition.
 * 2. Matches retained services: allows retaining existing booked services with their original
 *    pricing and duration snapshots.
 * 3. Builds availability inputs and loads salon schedule data.
 *    - Excludes the current appointment for regular reschedules to allow moving slots on the same day without self-conflicts.
 *    - Does not exclude the appointment for no-show recovery (which is treated as a fresh booking).
 * 4. Ensures any newly added services are currently active in the service catalog.
 * 5. Prepares planning data using historical snapshots for retained services.
 */
async function prepare(
  tx: Tx,
  row: Row,
  lockedIds: string[],
  input: ChangeSearch,
  timeZone: string,
  now: Date,
) {
  validateChangeEligibility(row, input.recovery, now);
  pristine(row);

  // Match retained services requested by the customer
  const retained = input.services.map((s) => {
    if (!s.appointmentServiceId) return undefined;
    const old = row.appointmentServices.find(
      (old) =>
        old.id === s.appointmentServiceId &&
        old.membershipStatus === "ACTIVE" &&
        old.serviceId === s.serviceId,
    );
    if (input.recovery || !old)
      throw new ApiError(
        400,
        "INVALID_RETAINED_SERVICE",
        "A retained service must belong to this active appointment schedule.",
      );
    return old;
  });

  if (
    new Set(retained.filter(Boolean).map((s) => s!.id)).size !==
    retained.filter(Boolean).length
  ) {
    throw new ApiError(
      400,
      "INVALID_RETAINED_SERVICE",
      "A retained service cannot appear twice.",
    );
  }

  // Construct availability search input
  const selection: AvailabilityInput = {
    date: input.date,
    services: input.services.map((s) =>
      s.assignmentMode === "SPECIFIC"
        ? {
            serviceId: s.serviceId,
            assignmentMode: "SPECIFIC",
            staffId: s.staffId!,
          }
        : { serviceId: s.serviceId, assignmentMode: "ANY_AVAILABLE" },
    ),
  };

  // Load availability from database, excluding current appointment if ordinary reschedule
  const data = await loadAvailabilityData(
    tx,
    selection,
    timeZone,
    now,
    row.bookingPolicyVersion,
    {
      retainedServiceIds: retained.flatMap((s) => (s ? [s.serviceId] : [])),
      excludeAppointmentId: input.recovery ? undefined : row.id,
    },
  );

  // The loader allows inactive rows only to recover retained snapshots. An added
  // occurrence of that same service must still independently be active.
  input.services.forEach((s, i) => {
    if (
      !retained[i] &&
      !data.services.find((item) => item.id === s.serviceId)?.isActive
    ) {
      throw new ApiError(
        400,
        "SERVICE_UNAVAILABLE",
        "Inactive services cannot be added.",
      );
    }
  });

  if (data.staff.some((s) => !lockedIds.includes(s.id)))
    throw new RestartReservation();

  // Create planning data applying historical snapshots for retained services
  const planning: AvailabilityData = {
    ...data,
    serviceOverrides: retained.map((s) =>
      s
        ? {
            name: s.serviceNameSnapshot,
            durationMinutes: s.durationMinutesSnapshot,
            bufferMinutes: s.bufferMinutesSnapshot,
          }
        : undefined,
    ),
  };

  return { selection, data, planning, retained };
}

/**
 * Creates the AppointmentChangesService instance containing operations for searching slots,
 * executing reschedules, cancelling visits, marking no-shows, and admin appointment listing.
 *
 * @param prisma - Prisma client instance.
 * @param timeZone - The IANA timezone string for the salon (e.g. "Asia/Manila").
 */
export function createAppointmentChangesService(
  prisma: PrismaClient,
  timeZone: string,
) {
  return {
    /**
     * Searches for available time slots for rescheduling or no-show recovery.
     *
     * Flow:
     * 1. Acquires concurrency locks on staff and the appointment within a transaction.
     * 2. Validates eligibility and loads availability data (supporting retained services).
     * 3. Calculates and returns available time slots for the chosen date.
     */
    async search(input: ChangeSearch) {
      return reservationTransaction(prisma, async (tx) => {
        const { row, lockedIds } = await lockAppointment(
          tx,
          input.bookingCode,
          input.token,
        );
        const prepared = await prepare(
          tx,
          row,
          lockedIds,
          input,
          timeZone,
          await freshTime(tx),
        );
        const now = await freshTime(tx);
        validateChangeEligibility(row, input.recovery, now);
        return {
          timeZone,
          generatedAt: now.toISOString(),
          slots: calculateAvailability(prepared.selection, {
            ...prepared.planning,
            now,
          }),
        };
      });
    },

    /**
     * Executes an appointment change: either an ordinary reschedule or a no-show recovery booking.
     *
     * Two change modes supported:
     * 1. No-Show Recovery (`recovery: true`):
     *    - Creates a NEW replacement appointment linked to the missed one via `recoveryOfAppointmentId`.
     *    - Carries forward the previously paid booking fee credit (`carriedAppointmentFeePaymentId`).
     *    - If valid payment credit exists, sets status to `CONFIRMED` without charging again; otherwise `PENDING_PAYMENT`.
     * 2. Ordinary Reschedule (`recovery: false`):
     *    - Modifies the EXISTING appointment record in-place.
     *    - Updates `startAt`, `endAt`, and increments `rescheduleCount`.
     *    - Temporarily soft-removes active services to prevent unique sequence index collisions, then restores or inserts new line items.
     *
     * Both modes:
     * - Record before and after snapshots in `AppointmentRescheduleHistory` and `AuditLog`.
     * - Enqueue notification events (`BOOKING_RESCHEDULED`, `NO_SHOW_RECOVERY_CREATED`).
     * - Perform a final pre-commit double-check against current time to eliminate race conditions.
     */
    async change(input: ChangeInput) {
      return reservationTransaction(prisma, async (tx) => {
        const credentials = createGuestCredentials();
        const { row, lockedIds } = await lockAppointment(
          tx,
          input.bookingCode,
          input.token,
        );
        const prepared = await prepare(
          tx,
          row,
          lockedIds,
          input,
          timeZone,
          await freshTime(tx),
        );

        // Lock every potential source payment before the fresh eligibility decision.
        // Only an original, successful obligation payment can supply this credit.
        if (input.recovery) {
          await tx.$queryRaw`SELECT id FROM "Payment" WHERE "appointmentId" = ${row.id}::uuid ORDER BY id FOR UPDATE`;
        }

        const now = await freshTime(tx);
        validateChangeEligibility(row, input.recovery, now);

        // Plan exact staff assignments and service timings for the chosen start time
        const plan = planAt(prepared.selection, new Date(input.startAt), {
          ...prepared.planning,
          now,
        });
        if (!plan)
          throw new ApiError(
            409,
            "SLOT_UNAVAILABLE",
            "This visit is no longer available. Please choose another time.",
          );

        const beforeSnapshot = snapshot(row);
        let targetId = row.id;

        if (input.recovery) {
          // Identify an eligible paid booking fee to carry forward as credit
          const credit = await tx.payment.findFirst({
            where: {
              appointmentId: row.id,
              type: "APPOINTMENT_FEE",
              status: "SUCCEEDED",
              satisfiesObligation: true,
              currency: "PHP",
              amount: { gte: row.bookingPolicyVersion.appointmentFeeAmount },
              refundedAt: null,
              carriedByAppointment: null,
            },
            orderBy: { id: "asc" },
          });

          // Create the new replacement appointment record
          const replacement = await tx.appointment.create({
            data: {
              customerId: row.customerId,
              bookingPolicyVersionId: row.bookingPolicyVersionId,
              bookingCode: credentials.bookingCode,
              guestAccessTokenHash: credentials.hash,
              recoveryOfAppointmentId: row.id,
              rescheduleCount: row.rescheduleCount + 1,
              status: credit ? "CONFIRMED" : "PENDING_PAYMENT",
              confirmedAt: credit ? now : null,
              carriedAppointmentFeePaymentId: credit?.id,
              appointmentFeeAmount:
                row.bookingPolicyVersion.appointmentFeeAmount,
              startAt: new Date(plan.startAt),
              endAt: new Date(plan.endAt),
              holdExpiresAt: credit
                ? null
                : new Date(
                    +now + row.bookingPolicyVersion.bookingHoldMinutes * 60_000,
                  ),
            },
          });
          targetId = replacement.id;
        } else {
          // Temporarily retire active rows so arbitrary reordering cannot collide
          // with the database's partial unique active-sequence index.
          await tx.appointmentService.updateMany({
            where: { appointmentId: row.id, membershipStatus: "ACTIVE" },
            data: { membershipStatus: "REMOVED", removedAt: now },
          });
          await tx.appointment.update({
            where: { id: row.id },
            data: {
              startAt: new Date(plan.startAt),
              endAt: new Date(plan.endAt),
              rescheduleCount: { increment: 1 },
            },
          });
        }

        // Create or update service items according to the plan
        for (const [i, part] of plan.services.entries()) {
          const timing = {
            staffId: part.staffId,
            assignmentMode: part.assignmentMode,
            sequenceNo: part.sequenceNo,
            scheduledStartAt: new Date(part.startAt),
            scheduledEndAt: new Date(part.endAt),
            reservedUntilAt: new Date(part.reservedUntilAt),
          };
          const old = prepared.retained[i];
          if (old) {
            // Restore retained service with its historical price and duration snapshots
            await tx.appointmentService.update({
              where: { id: old.id },
              data: { ...timing, membershipStatus: "ACTIVE", removedAt: null },
            });
          } else {
            // Create fresh line item snapshotting current service catalog values
            const item = prepared.data.services.find(
              (s) => s.id === part.serviceId,
            )!;
            const q = prepared.data.qualifications.find(
              (q) =>
                q.staffId === part.staffId && q.serviceId === part.serviceId,
            )!;
            await tx.appointmentService.create({
              data: {
                ...timing,
                appointmentId: targetId,
                serviceId: part.serviceId,
                serviceNameSnapshot: item.name,
                priceSnapshot: item.price,
                durationMinutesSnapshot: part.durationMinutes,
                bufferMinutesSnapshot: part.bufferMinutes,
                commissionRateSnapshot: q.commissionRate,
              },
            });
          }
        }

        const updated = await tx.appointment.findUniqueOrThrow({
          where: { id: targetId },
          include,
        });
        const eventType = input.recovery
          ? "NO_SHOW_RECOVERY_CREATED"
          : "ORDINARY_RESCHEDULE";

        // Record history and audit trail
        await tx.appointmentRescheduleHistory.create({
          data: {
            appointmentId: row.id,
            eventType,
            rescheduleNumber: row.rescheduleCount + 1,
            snapshotSchemaVersion: 1,
            actorType: "CUSTOMER",
            actorCustomerId: row.customerId,
            beforeSnapshot,
            afterSnapshot: snapshot(updated),
            reason: input.reason,
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: "CUSTOMER",
            actorCustomerId: row.customerId,
            action: eventType,
            entityType: "Appointment",
            entityId: row.id,
            beforeData: beforeSnapshot,
            afterData: snapshot(updated),
          },
        });

        // Queue notifications
        await notify(
          tx,
          updated,
          input.recovery ? "NO_SHOW_RECOVERY_CREATED" : "BOOKING_RESCHEDULED",
          now,
        );
        if (input.recovery && updated.status === "CONFIRMED") {
          await notify(tx, updated, "BOOKING_CONFIRMED", now);
        }

        // Concurrency double-check: ensure plan and deadlines remain valid
        const view = await tx.appointment.findUniqueOrThrow({
          where: { id: targetId },
          select: guestSelect,
        });
        const finalTime = await freshTime(tx);
        validateChangeEligibility(row, input.recovery, finalTime);

        const finalPlan = planAt(prepared.selection, new Date(input.startAt), {
          ...prepared.planning,
          now: finalTime,
        });
        if (
          !finalPlan ||
          (updated.status === "PENDING_PAYMENT" &&
            updated.holdExpiresAt! < finalTime)
        ) {
          throw conflict(
            "The booking deadline passed. Please choose another time.",
          );
        }
        if (
          finalPlan.services.some(
            (s, i) => s.staffId !== plan.services[i]!.staffId,
          )
        ) {
          throw new RestartReservation();
        }

        return {
          appointment: guestView(view, finalTime, timeZone),
          ...(input.recovery ? { guestToken: credentials.token } : {}),
        };
      });
    },

    /**
     * Cancels an appointment upon customer request.
     *
     * Rules:
     * - Idempotent: If already `CANCELLED`, returns `{ cancelled: true }`.
     * - Policy cutoff: Must be before `startAt - policy.cancellationCutoffHours`.
     * - State integrity: Rejects if service outcomes have already begun recording (`pristine`).
     * - Updates status to `CANCELLED`, writes audit log, and enqueues cancellation notification.
     */
    async cancel(bookingCode: string, token: string, reason?: string) {
      return reservationTransaction(prisma, async (tx) => {
        const { row } = await lockAppointment(tx, bookingCode, token);
        if (row.status === "CANCELLED") return { cancelled: true };

        const check = (now: Date) => {
          if (
            row.status !== "CONFIRMED" ||
            +now >
              +row.startAt -
                row.bookingPolicyVersion.cancellationCutoffHours * 3_600_000
          ) {
            throw conflict(
              "This appointment can no longer be cancelled. Please contact the salon.",
            );
          }
          pristine(row);
        };

        const now = await freshTime(tx);
        check(now);

        const updated = await tx.appointment.update({
          where: { id: row.id },
          data: { status: "CANCELLED", cancelledAt: now },
          include,
        });

        await tx.auditLog.create({
          data: {
            actorType: "CUSTOMER",
            actorCustomerId: row.customerId,
            action: "BOOKING_CANCELLED",
            entityType: "Appointment",
            entityId: row.id,
            beforeData: { status: row.status },
            afterData: { status: updated.status, reason: reason ?? null },
          },
        });

        await notify(tx, updated, "BOOKING_CANCELLED", now);
        check(await freshTime(tx));
        return { cancelled: true };
      });
    },

    async markOverdueNoShows(limit = 100) {
      // Filter protected visits before limiting so they cannot starve eligible bookings.
      const candidates = await prisma.$queryRaw<{ bookingCode: string }[]>`
        SELECT a."bookingCode" FROM "Appointment" a
        WHERE a.status = 'CONFIRMED' AND a."checkedInAt" IS NULL
          AND a."completedAt" IS NULL AND a."completionType" IS NULL
          AND a."startAt" <= clock_timestamp() - ${NO_SHOW_ARRIVAL_GRACE_MS} * interval '1 millisecond'
          AND NOT EXISTS (
            SELECT 1 FROM "AppointmentService" s
            WHERE s."appointmentId" = a.id AND s."membershipStatus" = 'ACTIVE'
              AND (s.outcome <> 'SCHEDULED' OR s."outcomeFinalizedAt" IS NOT NULL)
          )
        ORDER BY a."startAt", a.id LIMIT ${limit}
      `;
      let marked = 0;
      for (const candidate of candidates) {
        marked += await reservationTransaction(prisma, async tx => {
          // Same staff/appointment locks as check-in, settlement and manual changes.
          const { row } = await lockAppointment(tx, candidate.bookingCode);
          const now = await freshTime(tx);
          if (!eligibleForAutomaticNoShow(row, now)) return 0;
          await tx.appointment.update({ where: { id: row.id }, data: {
            status: "NO_SHOW", noShowAt: now,
            noShowGraceExpiresAt: new Date(+row.startAt + row.bookingPolicyVersion.noShowGraceHours * 3_600_000),
          } });
          await tx.auditLog.create({ data: {
            actorType: "SYSTEM", action: "BOOKING_NO_SHOW", entityType: "Appointment", entityId: row.id,
            beforeData: { status: "CONFIRMED" },
            afterData: { status: "NO_SHOW", reason: "ARRIVAL_GRACE_EXPIRED" },
          } });
          return 1;
        });
      }
      return marked;
    },

    async correctNoShow(actorId: string, raw: NoShowCorrectionInput) {
      const input = noShowCorrectionSchema.parse(raw);
      return reservationTransaction(prisma, async tx => {
        const actor = await admin(tx, actorId, true);
        const { row } = await lockAppointment(tx, input.bookingCode);
        const now = await freshTime(tx);
        if (row.status !== "NO_SHOW" || row.recoveryAppointment || row.completionType)
          throw conflict("Only an unresolved no-show without a replacement booking can be corrected.");
        pristine(row);
        const date = Temporal.Instant.fromEpochMilliseconds(+row.startAt).toZonedDateTimeISO(timeZone).toPlainDate().toString();
        const today = Temporal.Instant.fromEpochMilliseconds(+now).toZonedDateTimeISO(timeZone).toPlainDate().toString();
        if (date !== today || row.endAt <= now)
          throw conflict("The original visit has ended or is on another salon date. Arrange a new available booking instead.");
        const services = row.appointmentServices.filter(s => s.membershipStatus === "ACTIVE");
        if (!services.length) throw conflict("This appointment has no active services to restore.");
        const data = await loadAvailabilityData(tx, { date, services: services.map(s => ({
          serviceId: s.serviceId, assignmentMode: "SPECIFIC" as const, staffId: s.staffId,
        })) }, timeZone, now, row.bookingPolicyVersion, {
          retainedServiceIds: services.map(s => s.serviceId), excludeAppointmentId: row.id,
        });
        for (const service of services) {
          const start = service.scheduledStartAt, end = service.reservedUntilAt;
          if (!data.staff.some(s => s.id === service.staffId) ||
              !data.qualifications.some(q => q.staffId === service.staffId && q.serviceId === service.serviceId) ||
              !coversReservation(start, end, data.hours, timeZone) ||
              !coversReservation(start, end, data.schedules.filter(s => s.staffId === service.staffId), timeZone) ||
              data.closures.some(c => overlaps(start, end, c.startsAt, c.endsAt)) ||
              data.unavailability.some(u => u.staffId === service.staffId && overlaps(start, end, u.startsAt, u.endsAt)) ||
              data.reservations.some(r => r.staffId === service.staffId && overlaps(start, end, r.scheduledStartAt, r.reservedUntilAt)))
            throw conflict("The original staff time is no longer available. Arrange a new available booking instead.");
        }
        const checkedInAt = await freshTime(tx);
        if (row.endAt <= checkedInAt) throw conflict("The original visit has ended. Arrange a new available booking instead.");
        await tx.appointment.update({ where: { id: row.id }, data: {
          status: "CONFIRMED", checkedInAt, checkedInByUserId: actorId,
          noShowAt: null, noShowGraceExpiresAt: null,
        } });
        await tx.auditLog.create({ data: {
          actorType: actor.role, actorUserId: actorId, action: "BOOKING_NO_SHOW_CORRECTED", entityType: "Appointment", entityId: row.id,
          beforeData: { status: "NO_SHOW", noShowAt: row.noShowAt?.toISOString() ?? null,
            noShowGraceExpiresAt: row.noShowGraceExpiresAt?.toISOString() ?? null, checkedInAt: null },
          afterData: { status: "CONFIRMED", checkedInAt: checkedInAt.toISOString(), checkedInByUserId: actorId, reason: input.reason },
        } });
        return { corrected: true, checkedInAt };
      });
    },

    async checkIn(actorId: string, bookingCode: string) {
      return reservationTransaction(prisma, async tx => {
        // Authorize under a lock so a concurrent account deactivation cannot race arrival recording.
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId}::uuid FOR SHARE`;
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor?.isActive) throw new ApiError(401, "UNAUTHORIZED", "Please sign in again.");
        if (actor.role !== "ADMIN" && actor.role !== "CASHIER")
          throw new ApiError(403, "FORBIDDEN", "Admin or Cashier access is required to record arrival.");
        const { row } = await lockAppointment(tx, bookingCode);
        if (row.status !== "CONFIRMED" || row.completedAt)
          throw conflict("Only a confirmed, uncompleted appointment can be checked in.");
        if (row.checkedInAt) return { checkedInAt: row.checkedInAt, checkedInByUserId: row.checkedInByUserId };
        const now = await freshTime(tx);
        const date = (value: Date) => Temporal.Instant.fromEpochMilliseconds(+value).toZonedDateTimeISO(timeZone).toPlainDate().toString();
        if (date(now) !== date(row.startAt)) throw conflict("Check-in is available only on the scheduled salon date.");
        pristine(row);
        await tx.appointment.update({ where: { id: row.id }, data: { checkedInAt: now, checkedInByUserId: actorId } });
        await tx.auditLog.create({ data: {
          actorType: actor.role, actorUserId: actorId, action: "BOOKING_CHECKED_IN", entityType: "Appointment", entityId: row.id,
          beforeData: { checkedInAt: null }, afterData: { checkedInAt: now.toISOString(), checkedInByUserId: actorId },
        } });
        return { checkedInAt: now, checkedInByUserId: actorId };
      });
    },

    /**
     * Marks an appointment as a no-show. Restricted to administrator users.
     *
     * Rules:
     * - Target must be in `CONFIRMED` status and its scheduled start time must have arrived.
     * - Service outcomes must not have been recorded (`pristine`).
     * - Sets `noShowAt` and computes `noShowGraceExpiresAt` window for recovery bookings.
     * - Idempotent: If already `NO_SHOW`, returns `{ marked: true }`.
     * - Writes an administrative audit log entry.
     */
    async markNoShow(actorId: string, bookingCode: string) {
      return reservationTransaction(prisma, async (tx) => {
        await admin(tx, actorId);
        const { row } = await lockAppointment(tx, bookingCode);
        if (row.status === "NO_SHOW") return { marked: true };

        const now = await freshTime(tx);
        if (row.status !== "CONFIRMED" || now < row.startAt) {
          throw conflict(
            "Only a confirmed appointment whose start time has arrived may be marked as a no-show.",
          );
        }
        pristine(row);

        await tx.appointment.update({
          where: { id: row.id },
          data: {
            status: "NO_SHOW",
            noShowAt: now,
            noShowGraceExpiresAt: new Date(
              +row.startAt +
                row.bookingPolicyVersion.noShowGraceHours * 3_600_000,
            ),
          },
        });

        await tx.auditLog.create({
          data: {
            actorType: "ADMIN",
            actorUserId: actorId,
            action: "BOOKING_NO_SHOW",
            entityType: "Appointment",
            entityId: row.id,
            beforeData: { status: row.status },
            afterData: { status: "NO_SHOW" },
          },
        });

        return { marked: true };
      });
    },

    /**
     * Lists appointments with filtering and cursor-based pagination for administrator views.
     *
     * Filter parameters:
     * - `status`: Filter by appointment status (e.g. CONFIRMED, PENDING_PAYMENT, COMPLETED).
     * - `from` / `to`: Date range query converted to UTC timestamps using salon timezone.
     * - `staffId`: Filter by staff assigned to active services.
     * - `search`: Insensitive substring search matching booking code, first name, last name, or full name tokens.
     * - `attention`: Operational queues:
     *    - `"pending-fees"`: Unpaid appointments with holds expiring soon (`holdExpiresAt >= now`).
     *    - `"unsettled"`: Confirmed appointments whose start time has passed but haven't been completed yet.
     *
     * @returns Array of 50 sanitized appointment views and an optional `nextCursor` for the next page.
     */
    async list(
      actorId: string,
      cursor?: string,
      filters: AppointmentListQuery = {},
    ) {
      return prisma.$transaction(async (tx) => {
        await admin(tx, actorId);
        const now = await freshTime(tx);

        const where: Prisma.AppointmentWhereInput = {
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.from || filters.to
            ? {
                startAt: {
                  ...(filters.from
                    ? {
                        gte: new Date(
                          Temporal.PlainDate.from(filters.from).toZonedDateTime(
                            timeZone,
                          ).epochMilliseconds,
                        ),
                      }
                    : {}),
                  ...(filters.to
                    ? {
                        lt: new Date(
                          Temporal.PlainDate.from(filters.to)
                            .add({ days: 1 })
                            .toZonedDateTime(timeZone).epochMilliseconds,
                        ),
                      }
                    : {}),
                },
              }
            : {}),
          ...(filters.staffId
            ? {
                appointmentServices: {
                  some: {
                    staffId: filters.staffId,
                    membershipStatus: "ACTIVE",
                  },
                },
              }
            : {}),
          ...(filters.search
            ? {
                OR: [
                  {
                    bookingCode: {
                      contains: filters.search,
                      mode: "insensitive",
                    },
                  },
                  {
                    customer: {
                      firstName: {
                        contains: filters.search,
                        mode: "insensitive",
                      },
                    },
                  },
                  {
                    customer: {
                      lastName: {
                        contains: filters.search,
                        mode: "insensitive",
                      },
                    },
                  },
                  {
                    customer: {
                      AND: filters.search.split(/\s+/).map((word) => ({
                        OR: [
                          {
                            firstName: {
                              contains: word,
                              mode: "insensitive" as const,
                            },
                          },
                          {
                            lastName: {
                              contains: word,
                              mode: "insensitive" as const,
                            },
                          },
                        ],
                      })),
                    },
                  },
                ],
              }
            : {}),
        };

        if (filters.attention === "pending-fees") {
          where.status = "PENDING_PAYMENT";
          where.holdExpiresAt = { gte: now };
        }
        if (filters.attention === "unsettled") {
          where.status = "CONFIRMED";
          where.AND = [{ startAt: { lte: now } }];
        }

        const rows = await tx.appointment.findMany({
          where,
          take: 51,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: "asc" },
          select: { ...guestSelect, id: true, checkedInByUser: { select: { firstName: true, lastName: true } } },
        });

        return {
          appointments: rows
            .slice(0, 50)
            .map((row) => guestView(row, now, timeZone)),
          nextCursor: rows.length > 50 ? rows[49]!.id : null,
        };
      });
    },
  };
}
