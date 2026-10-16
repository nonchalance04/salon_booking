import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type Payment,
  type Appointment,
} from "../../../generated/prisma/client.js";
import { ApiError } from "../../shared/http.js";
import { lockSalon, lockStaff, freshTime } from "../scheduling/coordination.js";
import { coversReservation } from "../scheduling/coverage.js";
import { createGuestCredentials, validGuestAccess } from "../appointments/appointments.security.js";
import { GUEST_SESSION_MS } from "../appointments/appointment-otp.service.js";
import { historicalStaff } from "../appointments/staff-history.js";
import type { PaymentProvider, VerifiedPayment } from "./payment-provider.js";
import { TestPaymentProvider } from "./payment-provider.js";
import {
  manualPaymentSchema,
  type ManualPaymentInput,
} from "./payments.schema.js";

type Tx = Prisma.TransactionClient;
function metadata(payment: Payment): Prisma.JsonObject {
  return payment.metadata &&
    typeof payment.metadata === "object" &&
    !Array.isArray(payment.metadata)
    ? payment.metadata
    : {};
}
class RestartPayment extends Error {}
const conflict = () =>
  new ApiError(
    409,
    "PAYMENT_IDENTITY_CONFLICT",
    "This payment identity is already associated with different payment details.",
  );
async function transaction<T>(
  prisma: PrismaClient,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          await lockSalon(tx, "shared");
          return work(tx);
        },
        { isolationLevel: "ReadCommitted", timeout: 20_000 },
      );
    } catch (error) {
      if (error instanceof RestartPayment) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") continue; // Re-read a concurrent payment identity in a fresh transaction.
        if (
          ["P2028", "P2034"].includes(error.code) ||
          ["55P03", "40P01"].includes(String(error.meta?.code))
        ) {
          throw new ApiError(
            409,
            "PAYMENT_BUSY",
            "Payment processing is busy. Retry with the same payment reference.",
          );
        }
      }
      throw error;
    }
  }
  throw new ApiError(
    409,
    "PAYMENT_BUSY",
    "Payment processing changed. Retry with the same payment reference.",
  );
}
async function authorize(tx: Tx, actorId: string, adminOnly = false) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId}::uuid FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: actorId } });
  if (!user?.isActive)
    throw new ApiError(401, "UNAUTHORIZED", "Please sign in again.");
  if (adminOnly && user.role !== "ADMIN")
    throw new ApiError(403, "FORBIDDEN", "Administrator access is required.");
  return user;
}
async function guest(db: Tx, bookingCode: string, token: string) {
  const row = await db.appointment.findUnique({ where: { bookingCode } });
  const valid = await validGuestAccess(db, token, row);
  if (!row || !valid)
    throw new ApiError(
      404,
      "APPOINTMENT_NOT_FOUND",
      "Unable to access this appointment. Verify your phone number on Your appointment or contact the salon.",
    );
  return row;
}
async function lockAppointment(tx: Tx, id: string) {
  const before = await tx.appointmentService.findMany({
    where: { appointmentId: id, membershipStatus: "ACTIVE" },
    select: { staffId: true },
  });
  const ids = before.map((s) => s.staffId);
  await lockStaff(tx, ids);
  await tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.appointment.findUniqueOrThrow({
    where: { id },
    include: { appointmentServices: true, customer: true },
  });
  if (
    row.appointmentServices.some(
      (s) => s.membershipStatus === "ACTIVE" && !ids.includes(s.staffId),
    )
  )
    throw new RestartPayment();
  return row;
}
async function lockPayment(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${id}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUnique({ where: { id } });
  if (!payment) throw new ApiError(404, "NOT_FOUND", "Payment not found.");
  return payment;
}
async function view(tx: Tx, id: string) {
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      status: true,
      amount: true,
      currency: true,
      method: true,
      provider: true,
      paidAt: true,
      satisfiesObligation: true,
      reconciliationStatus: true,
      receipt: {
        select: { receiptNumber: true, issuedAt: true, receiptSnapshot: true },
      },
      appointment: { select: { bookingCode: true, status: true } },
    },
  });
  return { ...payment, amount: payment.amount.toFixed(2) };
}
async function issueReceipt(tx: Tx, payment: Payment, actorId: string | null, timeZone = "Asia/Manila") {
  const existing = await tx.receipt.findUnique({
    where: { paymentId: payment.id },
  });
  if (existing) return existing;
  if (payment.status !== "SUCCEEDED")
    throw new ApiError(
      409,
      "PAYMENT_NOT_SUCCEEDED",
      "A receipt requires a successful payment.",
    );
  const appointment = await tx.appointment.findUniqueOrThrow({
    where: { id: payment.appointmentId },
    include: { customer: true, appointmentServices: { where: { membershipStatus: "ACTIVE" }, orderBy: { sequenceNo: "asc" } } },
  });
  const salon = await tx.salonProfile.findFirst();
  return tx.receipt.create({
    data: {
      paymentId: payment.id,
      receiptNumber: `R-${randomUUID()}`,
      issuedByUserId: actorId,
      receiptSnapshot: {
        schemaVersion: 2,
        issuedBy: actorId ? "STAFF" : "SYSTEM",
        paymentId: payment.id,
        bookingCode: appointment.bookingCode,
        type: payment.type,
        amount: payment.amount.toFixed(2),
        currency: payment.currency,
        method: payment.method,
        provider: payment.provider,
        externalReference: payment.externalReference,
        paidAt: payment.paidAt!.toISOString(),
        customerName: `${appointment.customer.firstName} ${appointment.customer.lastName}`,
        timeZone,
        appointment: { startAt: appointment.startAt.toISOString(), endAt: appointment.endAt.toISOString() },
        scheduledServices: appointment.appointmentServices.map(service => {
          const staff = historicalStaff(service);
          return { name: service.serviceNameSnapshot, staffName: `${staff.firstName} ${staff.lastName}`.trim(),
            startAt: service.scheduledStartAt.toISOString(), endAt: service.scheduledEndAt.toISOString() };
        }),
        salon: salon
          ? { name: salon.name, address: salon.address, phone: salon.phone, email: salon.email }
          : null,
      },
    },
  });
}
async function issueAutomaticReceipt(tx: Tx, payment: Payment, timeZone: string) {
  if (payment.provider !== "paymongo" || payment.status !== "SUCCEEDED" || payment.type !== "APPOINTMENT_FEE")
    throw new ApiError(409, "RECEIPT_UNAVAILABLE", "An e-receipt requires a verified successful PayMongo appointment-fee payment.");
  const existing = await tx.receipt.findUnique({ where: { paymentId: payment.id } });
  if (existing) return existing;
  const receipt = await issueReceipt(tx, payment, null, timeZone);
  await tx.auditLog.create({ data: { actorType: "SYSTEM", action: "RECEIPT_ISSUED", entityType: "Receipt", entityId: receipt.id,
    afterData: { paymentId: payment.id, issuance: "VERIFIED_PROVIDER_PAYMENT" } } });
  return receipt;
}
async function reservationsOwned(
  tx: Tx,
  row: Awaited<ReturnType<typeof lockAppointment>>,
  now: Date,
  timeZone: string,
) {
  const services = row.appointmentServices;
  if (
    !services.length ||
    services.some(
      (s) => s.membershipStatus !== "ACTIVE" || s.outcome !== "SCHEDULED",
    )
  )
    return false;
  const hours = (
    await tx.salonOperatingHour.findMany({ where: { isActive: true } })
  ).map((h) => ({ ...h, startTime: h.openTime, endTime: h.closeTime }));
  for (const part of services) {
    const staff = await tx.staff.findUnique({
      where: { id: part.staffId },
      include: {
        schedules: { where: { isActive: true } },
        staffServices: { where: { isActive: true, serviceId: part.serviceId } },
      },
    });
    const service = await tx.service.findUnique({
      where: { id: part.serviceId },
      select: { isActive: true },
    });
    if (
      !staff?.isActive ||
      !service?.isActive ||
      !staff.staffServices.length ||
      !coversReservation(
        part.scheduledStartAt,
        part.reservedUntilAt,
        hours,
        timeZone,
      ) ||
      !coversReservation(
        part.scheduledStartAt,
        part.reservedUntilAt,
        staff.schedules,
        timeZone,
      )
    )
      return false;
    const interval = {
      startsAt: { lt: part.reservedUntilAt },
      endsAt: { gt: part.scheduledStartAt },
    };
    if (
      (await tx.salonClosure.count({ where: interval })) ||
      (await tx.staffUnavailability.count({
        where: { ...interval, staffId: part.staffId },
      }))
    )
      return false;
    const overlap = await tx.appointmentService.findFirst({
      where: {
        appointmentId: { not: row.id },
        staffId: part.staffId,
        membershipStatus: "ACTIVE",
        scheduledStartAt: { lt: part.reservedUntilAt },
        reservedUntilAt: { gt: part.scheduledStartAt },
        appointment: {
          OR: [
            { status: { in: ["CONFIRMED", "COMPLETED"] } },
            { status: "PENDING_PAYMENT", holdExpiresAt: { gte: now } },
          ],
        },
      },
      select: { id: true },
    });
    if (overlap) return false;
  }
  return true;
}
async function settle(
  tx: Tx,
  row: Awaited<ReturnType<typeof lockAppointment>>,
  payment: Payment,
  event: VerifiedPayment,
  actorId?: string,
  timeZone = "Asia/Manila",
) {
  if (
    payment.type !== "APPOINTMENT_FEE" ||
    payment.id !== event.paymentId ||
    payment.appointmentId !== event.appointmentId ||
    payment.externalReference !== event.reference ||
    !payment.amount.equals(event.amount) ||
    payment.currency !== event.currency ||
    !row.appointmentFeeAmount.equals(event.amount)
  )
    throw conflict();
  if (payment.status === "SUCCEEDED" || payment.status === "REFUNDED")
    return view(tx, payment.id);
  if (event.status === "PENDING") return view(tx, payment.id);
  const now = await freshTime(tx);
  let confirm = false;
  let reason: string | null = null;
  if (event.status === "SUCCEEDED") {
    const previous = await tx.payment.findFirst({
      where: {
        appointmentId: row.id,
        type: "APPOINTMENT_FEE",
        status: "SUCCEEDED",
        satisfiesObligation: true,
      },
    });
    if (previous || row.carriedAppointmentFeePaymentId)
      reason = "ADDITIONAL_CAPTURE";
    else if (
      row.status !== "PENDING_PAYMENT" ||
      !row.holdExpiresAt ||
      row.holdExpiresAt < now
    )
      reason = "HOLD_NOT_ACTIVE";
    else if (!(await reservationsOwned(tx, row, now, timeZone)))
      reason = "RESERVATION_NOT_OWNED";
    else confirm = true;
  }
  if (payment.status === event.status && !confirm) return view(tx, payment.id);
  // All locks precede the deadline decision. Re-read again after ownership queries.
  const decisionTime = await freshTime(tx);
  if (confirm && row.holdExpiresAt! < decisionTime) {
    confirm = false;
    reason = "HOLD_NOT_ACTIVE";
  }
  const updated = await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: event.status,
      satisfiesObligation: confirm,
      ...(event.status === "SUCCEEDED"
        ? {
            paidAt: new Date(event.paidAt!),
            reconciliationStatus: confirm ? "NONE" : "REQUIRED",
            reconciliationReason: reason,
          }
        : { failedAt: decisionTime }),
    },
  });
  if (confirm)
    await tx.appointment.update({
      where: { id: row.id },
      data: { status: "CONFIRMED", confirmedAt: decisionTime },
    });
  else if (
    row.status === "PENDING_PAYMENT" &&
    row.holdExpiresAt &&
    row.holdExpiresAt < decisionTime
  ) {
    await tx.appointment.update({
      where: { id: row.id },
      data: { status: "EXPIRED" },
    });
    await tx.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "BOOKING_HOLD_EXPIRED",
        entityType: "Appointment",
        entityId: row.id,
        beforeData: { status: "PENDING_PAYMENT" },
        afterData: { status: "EXPIRED" },
      },
    });
  }
  const actor = actorId
    ? await tx.user.findUniqueOrThrow({ where: { id: actorId } })
    : null;
  await tx.auditLog.create({
    data: {
      actorType: actor?.role ?? "SYSTEM",
      actorUserId: actorId,
      action: `APPOINTMENT_FEE_${event.status}`,
      entityType: "Payment",
      entityId: payment.id,
      afterData: {
        status: updated.status,
        amount: updated.amount.toFixed(2),
        currency: updated.currency,
        satisfiesObligation: confirm,
        reconciliationReason: reason,
      },
    },
  });
  if (event.status === "SUCCEEDED") {
    if (updated.provider === "paymongo") await issueAutomaticReceipt(tx, updated, timeZone);
    else if (actorId) await issueReceipt(tx, updated, actorId, timeZone);
    const eventTypes = confirm
      ? (["PAYMENT_RECEIVED", "BOOKING_CONFIRMED"] as const)
      : (["PAYMENT_RECEIVED"] as const);
    for (const eventType of eventTypes) {
      const combineEmail = confirm && !!row.customer.email;
      const skipPaymentEmail = combineEmail && eventType === "PAYMENT_RECEIVED";
      await tx.notificationQueue.create({
        data: {
          appointmentId: row.id,
          customerId: row.customerId,
          eventType,
          channel: row.customer.email ? "EMAIL" : "SMS",
          recipient: row.customer.email ?? row.customer.phone,
          status: skipPaymentEmail ? "SKIPPED" : "PENDING",
          lastError: skipPaymentEmail
            ? "EMAIL_COMBINED_WITH_CONFIRMATION"
            : null,
          scheduledAt: decisionTime,
          payload: {
            appointmentFeePaid:
              combineEmail && eventType === "BOOKING_CONFIRMED",
            schemaVersion: 1,
            bookingCode: row.bookingCode,
            paymentId: payment.id,
            amount: updated.amount.toFixed(2),
            currency: updated.currency,
            startAt: row.startAt.toISOString(),
            appointmentStatus: confirm
              ? "CONFIRMED"
              : row.status === "PENDING_PAYMENT" &&
                  row.holdExpiresAt! < decisionTime
                ? "EXPIRED"
                : row.status,
            reconciliationRequired: !confirm,
          },
        },
      });
    }
    if (confirm)
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "BOOKING_CONFIRMED",
          entityType: "Appointment",
          entityId: row.id,
          beforeData: { status: "PENDING_PAYMENT" },
          afterData: { status: "CONFIRMED", paymentId: payment.id },
        },
      });
  }
  const result = await view(tx, payment.id);
  // A late wait on inserts/foreign keys must not commit a stale confirmation.
  if (confirm && row.holdExpiresAt! < (await freshTime(tx)))
    throw new RestartPayment();
  return result;
}
function requestFor(payment: Payment, appointment: Appointment) {
  return {
    paymentId: payment.id,
    appointmentId: appointment.id,
    amount: payment.amount.toFixed(2),
    currency: payment.currency,
    expiresAt: appointment.holdExpiresAt!,
  };
}
export function createPaymentsService(
  prisma: PrismaClient,
  provider?: PaymentProvider,
  timeZone = "Asia/Manila",
) {
  return {
    async lookup(actorId: string, bookingCode: string) {
      return transaction(prisma, async (tx) => {
        await authorize(tx, actorId);
        const row = await tx.appointment.findUnique({
          where: { bookingCode },
          select: {
            bookingCode: true,
            status: true,
            holdExpiresAt: true,
            appointmentFeeAmount: true,
            customer: { select: { firstName: true, lastName: true } },
            payments: {
              where: { type: "APPOINTMENT_FEE" },
              select: {
                id: true,
                status: true,
                amount: true,
                reconciliationStatus: true,
                receipt: {
                  select: { receiptNumber: true, receiptSnapshot: true },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        });
        if (!row)
          throw new ApiError(404, "NOT_FOUND", "Appointment not found.");
        const now = await freshTime(tx);
        return {
          ...row,
          status:
            row.status === "PENDING_PAYMENT" &&
            row.holdExpiresAt &&
            row.holdExpiresAt < now
              ? "EXPIRED"
              : row.status,
          appointmentFeeAmount: row.appointmentFeeAmount.toFixed(2),
          payments: row.payments.map((p) => ({
            ...p,
            amount: p.amount.toFixed(2),
          })),
        };
      });
    },
    async returnSession(bookingCode: string, token: string) {
      return transaction(prisma, async tx => {
        const appointment = await guest(tx, bookingCode, token);
        const session = createGuestCredentials();
        await tx.appointmentGuestSession.create({ data: {
          appointmentId: appointment.id, tokenHash: session.hash,
          expiresAt: new Date(Date.now() + GUEST_SESSION_MS),
        } });
        return session.token;
      });
    },
    async checkout(bookingCode: string, token: string, key: string) {
      if (!provider)
        throw new ApiError(
          503,
          "ONLINE_PAYMENT_UNAVAILABLE",
          "Online payment is not configured. Contact the salon for payment assistance.",
        );
      const pending = await transaction(prisma, async (tx) => {
        const appointment = await guest(tx, bookingCode, token);
        const row = await lockAppointment(tx, appointment.id);
        const keyed = await tx.payment.findUnique({
          where: { idempotencyKey: `checkout:${key}` },
        });
        if (
          keyed &&
          (keyed.appointmentId !== row.id || keyed.provider !== provider.name)
        )
          throw conflict();
        const existing =
          keyed ??
          (provider.name === "paymongo"
            ? await tx.payment.findFirst({
                where: {
                  appointmentId: row.id,
                  provider: "paymongo",
                  status: "PENDING",
                  type: "APPOINTMENT_FEE",
                },
                orderBy: { createdAt: "asc" },
              })
            : null);
        if (existing) {
          if (
            existing.appointmentId !== row.id ||
            existing.provider !== provider.name
          )
            throw conflict();
          const details = metadata(existing);
          if (
            provider.name === "paymongo" &&
            existing.status === "PENDING" &&
            !details.checkoutReference
          ) {
            throw new ApiError(
              409,
              "CHECKOUT_UNCERTAIN",
              "Checkout creation is pending verification. Contact the salon before making another payment.",
            );
          }
          return { payment: existing, appointment: row, create: false };
        }
        const now = await freshTime(tx);
        if (
          row.status !== "PENDING_PAYMENT" ||
          !row.holdExpiresAt ||
          row.holdExpiresAt < now
        )
          throw new ApiError(
            409,
            "HOLD_NOT_ACTIVE",
            "This booking no longer has an active payment hold.",
          );
        const payment = await tx.payment.create({
          data: {
            appointmentId: row.id,
            type: "APPOINTMENT_FEE",
            provider: provider.name,
            method: provider.name === "test" ? "OTHER" : "GCASH",
            status: "PENDING",
            amount: row.appointmentFeeAmount,
            currency: "PHP",
            idempotencyKey: `checkout:${key}`,
            ...(provider.name === "paymongo"
              ? { metadata: { checkoutState: "REQUESTED" } }
              : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: "CUSTOMER",
            actorCustomerId: row.customerId,
            action: "PAYMENT_ATTEMPT_CREATED",
            entityType: "Payment",
            entityId: payment.id,
            afterData: {
              provider: provider.name,
              status: "PENDING",
              amount: payment.amount.toFixed(2),
              currency: "PHP",
            },
          },
        });
        return { payment, appointment: row, create: true };
      });
      if (pending.payment.status !== "PENDING")
        return {
          payment: await view(prisma, pending.payment.id),
          checkoutUrl: null,
          testMode: provider.name === "test",
        };
      const details = metadata(pending.payment);
      if (provider.name === "paymongo" && !pending.create) {
        const now = new Date();
        if (
          pending.appointment.status !== "PENDING_PAYMENT" ||
          !pending.appointment.holdExpiresAt ||
          pending.appointment.holdExpiresAt < now
        ) {
          throw new ApiError(
            409,
            "HOLD_NOT_ACTIVE",
            "The booking hold is no longer active. Check payment status.",
          );
        }
        return {
          payment: await view(prisma, pending.payment.id),
          checkoutUrl:
            typeof details.checkoutUrl === "string"
              ? details.checkoutUrl
              : null,
          testMode: false,
        };
      }
      const checkout = await provider.createPayment(
        requestFor(pending.payment, pending.appointment),
      );
      const result = await transaction(prisma, async (tx) => {
        const appointment = await lockAppointment(tx, pending.appointment.id);
        const row = await lockPayment(tx, pending.payment.id);
        const stored = metadata(row);
        if (provider.name === "paymongo") {
          if (
            stored.checkoutReference &&
            stored.checkoutReference !== checkout.reference
          )
            throw conflict();
          await tx.payment.update({
            where: { id: row.id },
            data: {
              metadata: {
                ...stored,
                checkoutState: "CREATED",
                checkoutReference: checkout.reference,
                checkoutUrl: checkout.checkoutUrl,
              },
            },
          });
        } else {
          if (
            row.externalReference &&
            row.externalReference !== checkout.reference
          )
            throw conflict();
          await tx.payment.update({
            where: { id: row.id },
            data: { externalReference: checkout.reference },
          });
        }
        const now = await freshTime(tx);
        return {
          payment: await view(tx, row.id),
          active:
            appointment.status === "PENDING_PAYMENT" &&
            Boolean(
              appointment.holdExpiresAt && appointment.holdExpiresAt >= now,
            ),
        };
      });
      if (!result.active && provider.expirePayment) {
        try {
          await provider.expirePayment(checkout.reference);
        } catch {
          /* Worker retries; never conceal a late capture. */
        }
      }
      return {
        payment: result.payment,
        checkoutUrl: result.active ? checkout.checkoutUrl : null,
        testMode: provider.name === "test",
      };
    },
    async providerEvent(raw: Buffer, signature: string | undefined) {
      if (!provider)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Payment provider is not enabled.",
        );
      const event = await provider.verifyPayment(raw, signature);
      return event ? processVerified(event) : null;
    },
    async refresh(bookingCode: string, token: string, paymentId: string) {
      const appointment = await guest(prisma, bookingCode, token);
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      if (!payment || payment.appointmentId !== appointment.id)
        throw new ApiError(404, "NOT_FOUND", "Payment not found.");
      if (payment.provider !== provider?.name || payment.status === "SUCCEEDED")
        return view(prisma, payment.id);
      const reference = metadata(payment).checkoutReference;
      if (typeof reference !== "string") return view(prisma, payment.id);
      return processVerified(await provider.getPaymentStatus(reference));
    },
    async recoverCheckout(
      actorId: string,
      paymentId: string,
      checkoutReference: string,
    ) {
      // Admin recovery for a response lost after PayMongo created the checkout.
      await transaction(prisma, (tx) => authorize(tx, actorId, true));
      if (provider?.name !== "paymongo")
        throw new ApiError(
          409,
          "PROVIDER_UNAVAILABLE",
          "PayMongo is not enabled.",
        );
      const event = await provider.getPaymentStatus(checkoutReference);
      if (event.paymentId !== paymentId) throw conflict();
      return processVerified(event, actorId);
    },
    async synchronizeExpired(limit = 20) {
      if (!provider?.expirePayment) return;
      const now = new Date();
      const candidates = await prisma.payment.findMany({
        where: {
          provider: provider.name,
          status: "PENDING",
          appointment: { holdExpiresAt: { lt: now } },
        },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      for (const payment of candidates) {
        const reference = metadata(payment).checkoutReference;
        if (typeof reference !== "string") {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: { updatedAt: new Date() },
          });
          continue;
        }
        try {
          let event = await provider.getPaymentStatus(reference);
          if (event.status === "PENDING") {
            await provider.expirePayment(reference);
            event = await provider.getPaymentStatus(reference);
          }
          await processVerified(event);
        } catch {
          console.error(
            JSON.stringify({
              level: "error",
              event: "payment_session_cleanup_failed",
              paymentId: payment.id,
            }),
          );
        }
        // Fair retries when a provider reports an in-progress payment at expiry.
        await prisma.payment.updateMany({
          where: { id: payment.id, status: "PENDING" },
          data: { updatedAt: new Date() },
        });
      }
    },
    async simulate(
      bookingCode: string,
      token: string,
      paymentId: string,
      outcome: "SUCCEEDED" | "FAILED",
    ) {
      if (!(provider instanceof TestPaymentProvider))
        throw new ApiError(404, "NOT_FOUND", "Test payments are not enabled.");
      const appointment = await guest(prisma, bookingCode, token);
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      if (
        !payment ||
        payment.appointmentId !== appointment.id ||
        payment.provider !== provider.name
      )
        throw new ApiError(404, "NOT_FOUND", "Payment not found.");
      return processVerified(
        await provider.simulate(requestFor(payment, appointment), outcome),
      );
    },
    async manual(actorId: string, raw: ManualPaymentInput) {
      const input = manualPaymentSchema.parse(raw);
      // Stable across retries; a salon reference, not a provider transaction ID.
      const reference =
        input.externalReference ?? `SALON-FEE-${input.idempotencyKey}`;
      return transaction(prisma, async (tx) => {
        const appointment = await tx.appointment.findUnique({
          where: { bookingCode: input.bookingCode },
        });
        if (!appointment)
          throw new ApiError(404, "NOT_FOUND", "Appointment not found.");
        const row = await lockAppointment(tx, appointment.id);
        await authorize(tx, actorId);
        if (!row.appointmentFeeAmount.equals(input.amount))
          throw new ApiError(
            400,
            "AMOUNT_MISMATCH",
            "Record the exact appointment fee shown for this booking.",
          );
        const key = `manual:${input.idempotencyKey}`;
        const matches = await tx.payment.findMany({
          where: {
            OR: [
              { idempotencyKey: key },
              { provider: "manual", externalReference: reference },
            ],
          },
        });
        if (matches.length > 1) throw conflict();
        let payment = matches[0];
        if (
          payment &&
          (payment.appointmentId !== row.id ||
            payment.provider !== "manual" ||
            payment.method !== input.method ||
            payment.externalReference !== reference ||
            !payment.amount.equals(input.amount) ||
            payment.currency !== input.currency)
        )
          throw conflict();
        if (payment) payment = await lockPayment(tx, payment.id);
        else
          payment = await tx.payment.create({
            data: {
              appointmentId: row.id,
              type: "APPOINTMENT_FEE",
              provider: "manual",
              method: input.method,
              status: "PENDING",
              amount: input.amount,
              currency: input.currency,
              idempotencyKey: key,
              externalReference: reference,
              recordedByUserId: actorId,
            },
          });
        return settle(
          tx,
          row,
          payment,
          {
            paymentId: payment.id,
            appointmentId: row.id,
            reference,
            amount: input.amount,
            currency: input.currency,
            status: "SUCCEEDED",
            paidAt: (await freshTime(tx)).toISOString(),
          },
          actorId,
          timeZone,
        );
      });
    },
    async customerReceipt(bookingCode: string, token: string, paymentId: string) {
      return transaction(prisma, async tx => {
        const appointment = await guest(tx, bookingCode, token);
        await lockAppointment(tx, appointment.id);
        const payment = await lockPayment(tx, paymentId);
        if (payment.appointmentId !== appointment.id) throw new ApiError(404, "NOT_FOUND", "Payment not found.");
        await issueAutomaticReceipt(tx, payment, timeZone);
        return view(tx, paymentId);
      });
    },
    async issueReceipt(actorId: string, paymentId: string) {
      return transaction(prisma, async (tx) => {
        const payment = await lockPayment(tx, paymentId);
        const actor = await authorize(tx, actorId);
        if (payment.type !== "APPOINTMENT_FEE")
          throw new ApiError(
            400,
            "INVALID_PAYMENT_TYPE",
            "Only appointment-fee receipts are available here.",
          );
        const existing = await tx.receipt.findUnique({ where: { paymentId } });
        if (!existing) {
          const receipt = await issueReceipt(tx, payment, actorId, timeZone);
          await tx.auditLog.create({
            data: {
              actorType: actor.role,
              actorUserId: actorId,
              action: "RECEIPT_ISSUED",
              entityType: "Receipt",
              entityId: receipt.id,
              afterData: { paymentId },
            },
          });
        }
        return view(tx, paymentId);
      });
    },
    async list(actorId: string, cursor?: string, reconciliationOnly = true) {
      return transaction(prisma, async (tx) => {
        await authorize(tx, actorId, true);
        const rows = await tx.payment.findMany({
          where: {
            type: "APPOINTMENT_FEE",
            ...(reconciliationOnly
              ? { reconciliationStatus: "REQUIRED" as const }
              : {}),
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: "asc" },
          take: 51,
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            method: true,
            provider: true,
            externalReference: true,
            paidAt: true,
            satisfiesObligation: true,
            reconciliationStatus: true,
            reconciliationReason: true,
            appointment: { select: { bookingCode: true, status: true } },
            receipt: { select: { receiptNumber: true } },
          },
        });
        return {
          payments: rows
            .slice(0, 50)
            .map((row) => ({ ...row, amount: row.amount.toFixed(2) })),
          nextCursor: rows.length > 50 ? rows[49]!.id : null,
        };
      });
    },
  };
  async function processVerified(event: VerifiedPayment, actorId?: string) {
    return transaction(prisma, async (tx) => {
      const original = await tx.payment.findUnique({
        where: { id: event.paymentId },
      });
      if (!original || original.provider !== provider!.name) throw conflict();
      const row = await lockAppointment(tx, original.appointmentId);
      let payment = await lockPayment(tx, original.id);
      if (actorId) await authorize(tx, actorId, true);
      if (provider!.name === "paymongo") {
        const details = metadata(payment);
        if (
          event.appointmentId !== payment.appointmentId ||
          !payment.amount.equals(event.amount) ||
          event.currency !== payment.currency ||
          !event.checkoutReference ||
          (details.checkoutReference &&
            details.checkoutReference !== event.checkoutReference) ||
          !details.checkoutState
        )
          throw conflict();
        if (
          payment.externalReference &&
          payment.externalReference !== event.reference &&
          event.status === "SUCCEEDED"
        )
          throw conflict();
        payment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            metadata: {
              ...details,
              checkoutState: "CREATED",
              checkoutReference: event.checkoutReference,
              ...(event.checkoutUrl ? { checkoutUrl: event.checkoutUrl } : {}),
            },
            ...(event.status === "SUCCEEDED"
              ? { externalReference: event.reference }
              : {}),
          },
        });
        if (actorId)
          await tx.auditLog.create({
            data: {
              actorType: "ADMIN",
              actorUserId: actorId,
              action: "PAYMONGO_CHECKOUT_RECOVERED",
              entityType: "Payment",
              entityId: payment.id,
              afterData: { checkoutReference: event.checkoutReference },
            },
          });
        if (event.status !== "SUCCEEDED") {
          // A session is not a captured transaction. Keep externalReference for pay_ identity.
          if (event.status === "EXPIRED" && payment.status === "PENDING") {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: "EXPIRED" },
            });
            await tx.auditLog.create({
              data: {
                actorType: "SYSTEM",
                action: "PAYMENT_ATTEMPT_EXPIRED",
                entityType: "Payment",
                entityId: payment.id,
              },
            });
          }
          return view(tx, payment.id);
        }
      }
      return settle(tx, row, payment, event, undefined, timeZone);
    });
  }
}
