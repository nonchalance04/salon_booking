import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { ApiError } from "../../shared/http.js";
import { freshTime, lockStaff } from "../scheduling/coordination.js";
import { reservationTransaction, RestartReservation } from "../appointments/appointments.service.js";
import { allocateCommissions } from "./commissions.js";
import { booking, outcomesSchema, revision as revisionSchema, settlementSchema, type OutcomesInput, type SettlementInput } from "./settlement.schema.js";
type Tx = Prisma.TransactionClient;
const include = { customer: true, appointmentServices: { where: { membershipStatus: "ACTIVE" as const }, orderBy: { sequenceNo: "asc" as const }, include: { staff: true } },
  payments: { include: { receipt: true } }, commissionRecords: true };
type Row = Prisma.AppointmentGetPayload<{ include: typeof include }>;
const fail = (code: string, message: string) => new ApiError(409, code, message);
function revision(row: Row) { return createHash("sha256").update(JSON.stringify([row.status, row.updatedAt, row.appointmentServices.map(s => [s.id, s.updatedAt, s.outcome, s.actualChargedAmount, s.staffId])])).digest("hex"); }
async function authorize(tx: Tx, id: string, requiredRole?: "ADMIN" | "CASHIER") {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id } });
  if (!actor?.isActive) throw new ApiError(401, "UNAUTHORIZED", "Please sign in again.");
  if (requiredRole && actor.role !== requiredRole) throw new ApiError(403, "FORBIDDEN", `${requiredRole === "ADMIN" ? "Administrator" : "Cashier"} access is required.`);
  return actor;
}
async function locked(tx: Tx, code: string) {
  const ids = (await tx.staff.findMany({ select: { id: true } })).map(s => s.id);
  await lockStaff(tx, ids);
  await tx.$queryRaw`SELECT id FROM "Appointment" WHERE "bookingCode" = ${code} FOR UPDATE`;
  const row = await tx.appointment.findUnique({ where: { bookingCode: code }, include });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Appointment not found.");
  if (row.appointmentServices.some(s => !ids.includes(s.staffId))) throw new RestartReservation();
  return row;
}
function editable(row: Row, expected: string) {
  if (row.status !== "CONFIRMED" || row.completedAt || row.completionType || row.payments.some(p => p.type === "SERVICE_PAYMENT" && p.status === "SUCCEEDED")) throw fail("SETTLEMENT_NOT_ALLOWED", "Only an unfinalized confirmed appointment can be changed or settled.");
  if (revision(row) !== expected) throw fail("STALE_SETTLEMENT", "This appointment changed. Refresh and review its outcomes before continuing.");
  if (!row.appointmentServices.length) throw fail("OUTCOMES_REQUIRED", "No active services are available for settlement.");
}
async function eligibleFee(tx: Tx, row: Row) {
  const candidates = await tx.payment.findMany({ where: { type: "APPOINTMENT_FEE", status: "SUCCEEDED", refundedAt: null, satisfiesObligation: true, currency: "PHP",
    ...(row.carriedAppointmentFeePaymentId ? { id: row.carriedAppointmentFeePaymentId, appointmentId: row.recoveryOfAppointmentId ?? "00000000-0000-0000-0000-000000000000" } : { appointmentId: row.id, carriedByAppointment: null }) }, orderBy: { id: "asc" } });
  if (candidates.length > 1) throw fail("INVALID_FEE", "Multiple eligible appointment fees require review.");
  return candidates[0]?.amount ?? new Prisma.Decimal(0);
}
async function view(tx: Tx, row: Row, admin: boolean) {
  return { bookingCode: row.bookingCode, status: row.status, revision: revision(row), startAt: row.startAt, completionType: row.completionType, completedAt: row.completedAt,
    customer: { firstName: row.customer.firstName, lastName: row.customer.lastName },
    eligibleAppointmentFee: (await eligibleFee(tx, row)).toFixed(2), carriedFee: Boolean(row.carriedAppointmentFeePaymentId),
    amountDue: row.appointmentServices.filter(s => s.outcome === "PERFORMED").reduce((n, s) => n.plus(s.actualChargedAmount ?? 0), new Prisma.Decimal(0)).toFixed(2),
    services: row.appointmentServices.map(s => ({ id: s.id, name: s.serviceNameSnapshot, staff: `${s.staff?.firstName ?? s.staffFirstNameSnapshot} ${s.staff?.lastName ?? s.staffLastNameSnapshot}`.trim() || "Former staff", outcome: s.outcome,
      price: s.priceSnapshot.toFixed(2), actualChargedAmount: s.actualChargedAmount?.toFixed(2) ?? null })),
    payments: row.payments.map(p => ({ id: p.id, type: p.type, status: p.status, amount: p.amount.toFixed(2), receipt: p.receipt ? { receiptNumber: p.receipt.receiptNumber, receiptSnapshot: p.receipt.receiptSnapshot } : null })),
    ...(admin ? { commissions: row.commissionRecords.map(c => ({ appointmentServiceId: c.appointmentServiceId, staffId: c.staffId,
      serviceAmount: c.serviceAmount.toFixed(2), allocatedAppointmentFee: c.allocatedAppointmentFee.toFixed(2), commissionBase: c.commissionBase.toFixed(2), commissionRate: c.commissionRate.toFixed(4), commissionAmount: c.commissionAmount.toFixed(2) })) } : {}) };
}
async function audit(tx: Tx, row: Row, actor: { id: string; role: "ADMIN" | "CASHIER" }, action: string, afterData: Prisma.InputJsonValue, beforeData?: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { actorType: actor.role, actorUserId: actor.id, action, entityType: "Appointment", entityId: row.id, afterData, ...(beforeData ? { beforeData } : {}) } });
}
export function createSettlementService(prisma: PrismaClient) {
  const transact = <T>(work: (tx: Tx) => Promise<T>) => reservationTransaction(prisma, work).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw fail("PAYMENT_IDENTITY_CONFLICT", "This payment reference is already used. Refresh and check the original transaction.");
    throw error;
  });
  return {
    async lookup(actorId: string, code: string) {
      booking.parse({ bookingCode: code });
      return transact(async tx => { const row = await locked(tx, code); const actor = await authorize(tx, actorId); return view(tx, row, actor.role === "ADMIN"); });
    },
    async outcomes(actorId: string, raw: OutcomesInput) {
      const input = outcomesSchema.parse(raw);
      return transact(async tx => {
        const row = await locked(tx, input.bookingCode); const actor = await authorize(tx, actorId); editable(row, input.revision);
        if (new Set(input.services.map(s => s.id)).size !== row.appointmentServices.length || input.services.length !== row.appointmentServices.length || input.services.some(s => !row.appointmentServices.some(r => r.id === s.id))) throw fail("INVALID_SERVICES", "Submit each active service exactly once.");
        for (const s of row.appointmentServices) {
          const outcome = input.services.find(i => i.id === s.id)!.outcome;
          if (outcome === "PERFORMED" && !s.priceSnapshot.gt(0)) throw fail("INVALID_SERVICE_CHARGE", "Performed services must have a positive historical price.");
          await tx.appointmentService.update({ where: { id: s.id }, data: { outcome, actualChargedAmount: outcome === "PERFORMED" ? s.priceSnapshot : "0.00" } });
        }
        await audit(tx, row, actor, "SERVICE_OUTCOMES_RECORDED", { services: input.services }, { services: row.appointmentServices.map(s => ({ id: s.id, outcome: s.outcome })) });
        return view(tx, await tx.appointment.findUniqueOrThrow({ where: { id: row.id }, include }), actor.role === "ADMIN");
      });
    },
    async settle(actorId: string, raw: SettlementInput) {
      const input = settlementSchema.parse(raw);
      // Reuse the same salon reference when a payment request is retried.
      const reference = input.externalReference ?? `SALON-SERVICE-${input.idempotencyKey}`;
      return transact(async tx => {
        const row = await locked(tx, input.bookingCode); const actor = await authorize(tx, actorId, "CASHIER");
        const key = `settlement:${input.idempotencyKey}`;
        const matches = await tx.payment.findMany({ where: { OR: [{ idempotencyKey: key }, { provider: "manual", externalReference: reference }] } });
        if (matches.length) {
          const p = matches[0]!;
          if (matches.length !== 1 || p.appointmentId !== row.id || p.type !== "SERVICE_PAYMENT" || p.status !== "SUCCEEDED" || p.method !== input.method || p.currency !== input.currency || !p.amount.equals(input.amount) || p.externalReference !== reference || row.completionType !== "SERVICE_SETTLEMENT") throw fail("PAYMENT_IDENTITY_CONFLICT", "This payment identity is associated with different details.");
          return view(tx, row, false);
        }
        editable(row, input.revision);
        if (row.appointmentServices.some(s => s.outcome === "SCHEDULED")) throw fail("OUTCOMES_REQUIRED", "Record all service outcomes before settlement.");
        const performed = row.appointmentServices.filter(s => s.outcome === "PERFORMED");
        const fee = await eligibleFee(tx, row);
        const commissions = allocateCommissions(performed, fee);
        const amount = commissions.reduce((n, c) => n.plus(c.serviceAmount), new Prisma.Decimal(0));
        if (!amount.equals(input.amount)) throw fail("AMOUNT_MISMATCH", "The payment must equal the full performed-service charge.");
        const now = await freshTime(tx);
        const payment = await tx.payment.create({ data: { appointmentId: row.id, type: "SERVICE_PAYMENT", method: input.method, provider: "manual", status: "SUCCEEDED", amount,
          currency: "PHP", idempotencyKey: key, externalReference: reference, satisfiesObligation: true, recordedByUserId: actor.id, paidAt: now } });
        const salon = await tx.salonProfile.findFirst();
        const receipt = await tx.receipt.create({ data: { paymentId: payment.id, receiptNumber: `R-${randomUUID()}`, issuedByUserId: actor.id,
          receiptSnapshot: { schemaVersion: 1, bookingCode: row.bookingCode, paymentId: payment.id, type: "SERVICE_PAYMENT", amount: amount.toFixed(2), currency: "PHP", method: input.method,
            externalReference: reference, paidAt: now.toISOString(), customerName: `${row.customer.firstName} ${row.customer.lastName}`,
            salon: salon ? { name: salon.name, address: salon.address, phone: salon.phone } : null,
            services: performed.map(s => ({ name: s.serviceNameSnapshot, amount: s.actualChargedAmount!.toFixed(2) })) } } });
        await tx.commissionRecord.createMany({ data: commissions.map(c => ({ ...c, appointmentId: row.id, sourcePaymentId: payment.id, finalizedByUserId: actor.id, finalizedAt: now })) });
        await audit(tx, row, actor, "SERVICE_PAYMENT_SETTLED", { paymentId: payment.id, amount: amount.toFixed(2), receiptId: receipt.id });
        await audit(tx, row, actor, "COMMISSIONS_FINALIZED", { paymentId: payment.id, eligibleAppointmentFee: fee.toFixed(2), services: commissions.map(c => ({ id: c.appointmentServiceId, allocation: c.allocatedAppointmentFee.toFixed(2), commission: c.commissionAmount.toFixed(2) })) });
        await complete(tx, row, actor, "SERVICE_SETTLEMENT", now, payment.id);
        return view(tx, await tx.appointment.findUniqueOrThrow({ where: { id: row.id }, include }), false);
      });
    },
    async close(actorId: string, raw: { bookingCode: string; revision: string }) {
      const input = revisionSchema.strict().parse(raw);
      return transact(async tx => {
        const row = await locked(tx, input.bookingCode); const actor = await authorize(tx, actorId, "ADMIN");
        if (row.status === "COMPLETED" && row.completionType === "NO_SERVICE_CLOSURE") return view(tx, row, true);
        editable(row, input.revision);
        if (row.appointmentServices.some(s => s.outcome !== "NOT_PERFORMED")) throw fail("NO_SERVICE_CLOSURE_NOT_ALLOWED", "Every active service must be recorded as not performed.");
        await complete(tx, row, actor, "NO_SERVICE_CLOSURE", await freshTime(tx));
        return view(tx, await tx.appointment.findUniqueOrThrow({ where: { id: row.id }, include }), true);
      });
    },
  };
}
async function complete(tx: Tx, row: Row, actor: { id: string; role: "ADMIN" | "CASHIER" }, completionType: "SERVICE_SETTLEMENT" | "NO_SERVICE_CLOSURE", now: Date, paymentId?: string) {
  await tx.appointmentService.updateMany({ where: { appointmentId: row.id, membershipStatus: "ACTIVE" }, data: { outcomeFinalizedAt: now, outcomeFinalizedByUserId: actor.id } });
  await tx.appointment.update({ where: { id: row.id }, data: { status: "COMPLETED", completionType, completedAt: now, completedByUserId: actor.id } });
  await audit(tx, row, actor, completionType, { status: "COMPLETED", completionType }, { status: row.status });
  for (const eventType of paymentId ? ["PAYMENT_RECEIVED", "APPOINTMENT_COMPLETED"] as const : ["APPOINTMENT_COMPLETED"] as const) {
    await tx.notificationQueue.create({ data: { appointmentId: row.id, customerId: row.customerId, eventType, channel: row.customer.email ? "EMAIL" : "SMS", recipient: row.customer.email ?? row.customer.phone,
      status: "PENDING", scheduledAt: now, payload: { schemaVersion: 1, bookingCode: row.bookingCode, appointmentStatus: "COMPLETED", completionType, ...(paymentId ? { paymentId } : {}) } } });
  }
}
