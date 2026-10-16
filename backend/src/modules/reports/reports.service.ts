import { freshTime } from "../scheduling/coordination.js";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { Temporal } from "@js-temporal/polyfill";
import { ApiError } from "../../shared/http.js";
import { reportPeriod, type ReportQuery, type ConfirmedServicesQuery, reportKinds } from "./reports.schema.js";

type Kind = typeof reportKinds[number];
const amount = (n: Prisma.Decimal | null) => (n ?? new Prisma.Decimal(0)).toFixed(2);
const booking = { select: { bookingCode: true } } as const;
// Audits may contain legacy snapshots. Never expose credentials or provider metadata.
export function safeAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeAudit);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|token|secret|authorization|cookie|metadata/i.test(key))
    .map(([key, item]) => [key, safeAudit(item)]));
  return value;
}
export function createReportsService(prisma: PrismaClient, timeZone: string) {
  async function read<T>(actorId: string, admin: boolean, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async tx => {
      const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true } });
      if (!actor?.isActive) throw new ApiError(401, "UNAUTHORIZED", "Please sign in again.");
      if (admin && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Administrator access is required.");
      return operation(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  return {
    collections(actorId: string, q: ReportQuery) {
      return read(actorId, false, async tx => {
        const period = reportPeriod(q, timeZone);
        // Query Payment directly: joining carried credits, receipts or commissions would multiply money.
        const captures = await tx.payment.groupBy({ by: ["currency", "type", "method", "status", "satisfiesObligation", "reconciliationStatus"],
          where: { status: { in: ["SUCCEEDED", "REFUNDED"] }, paidAt: period }, orderBy: [{ currency: "asc" }, { type: "asc" }, { method: "asc" }, { status: "asc" }, { satisfiesObligation: "asc" }, { reconciliationStatus: "asc" }], _sum: { amount: true }, _count: { _all: true } });
        const refunds = await tx.payment.groupBy({ by: ["currency", "method", "type"], where: { status: "REFUNDED", refundedAt: period }, _sum: { amount: true }, _count: { _all: true } });
        const currencies = [...new Set([...captures, ...refunds].map(r => r.currency))].sort();
        return { from: q.from, to: q.to, timeZone, basis: "Collections use capture time. Net movement reflects recorded payment adjustments. Dates are inclusive in salon time. Carried credits are not new collections.",
          totals: currencies.map(currency => {
            const rows = captures.filter(r => r.currency === currency);
            const sum = (selected: typeof rows) => selected.reduce((n, r) => n.plus(r._sum.amount ?? 0), new Prisma.Decimal(0));
            const gross = sum(rows); const refunded = refunds.filter(r => r.currency === currency).reduce((n, r) => n.plus(r._sum.amount ?? 0), new Prisma.Decimal(0));
            return { currency, captured: amount(gross), refunded: amount(refunded), netCashMovement: amount(gross.minus(refunded)),
              successfulApplied: amount(sum(rows.filter(r => r.status === "SUCCEEDED" && r.satisfiesObligation))),
              successfulUnapplied: amount(sum(rows.filter(r => r.status === "SUCCEEDED" && !r.satisfiesObligation))),
              reconciliationRequired: amount(sum(rows.filter(r => r.status === "SUCCEEDED" && r.reconciliationStatus === "REQUIRED"))) };
          }),
          methodTotals: currencies.flatMap(currency => ["CASH", "GCASH", "OTHER"].map(method => {
            const captured = captures.filter(r => r.currency === currency && r.method === method).reduce((n, r) => n.plus(r._sum.amount ?? 0), new Prisma.Decimal(0));
            const refunded = refunds.filter(r => r.currency === currency && r.method === method).reduce((n, r) => n.plus(r._sum.amount ?? 0), new Prisma.Decimal(0));
            return { currency, method, captured: amount(captured), refunded: amount(refunded), netCashMovement: amount(captured.minus(refunded)) };
          })),
          typeTotals: currencies.flatMap(currency => ["APPOINTMENT_FEE", "SERVICE_PAYMENT"].map(type => {
            const rows = captures.filter(r => r.currency === currency && r.type === type);
            return { currency, type, captured: amount(rows.reduce((n, r) => n.plus(r._sum.amount ?? 0), new Prisma.Decimal(0))), count: rows.reduce((n, r) => n + r._count._all, 0) };
          })),
          breakdown: captures.map(({ _sum, _count, ...row }) => ({ ...row, amount: amount(_sum.amount), count: _count._all })),
        };
      });
    },
    waitingQueue(actorId: string, q: ConfirmedServicesQuery) {
      return read(actorId, false, async tx => {
        const now = await freshTime(tx);
        const where: Prisma.AppointmentWhereInput = {
          status: "CONFIRMED", checkedInAt: { not: null }, completedAt: null, completionType: null,
          appointmentServices: {
            some: { membershipStatus: "ACTIVE" },
            none: { membershipStatus: "ACTIVE", OR: [
              { outcome: { not: "SCHEDULED" } }, { outcomeFinalizedAt: { not: null } },
            ] },
          },
          ...(q.search ? { OR: [
            { bookingCode: { contains: q.search, mode: "insensitive" } },
            { AND: q.search.split(/\s+/).map(word => ({ OR: [
              { customer: { firstName: { contains: word, mode: "insensitive" as const } } },
              { customer: { lastName: { contains: word, mode: "insensitive" as const } } },
            ] })) },
          ] } : {}),
        };
        const total = await tx.appointment.count({ where });
        const rows = await tx.appointment.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
          orderBy: [{ checkedInAt: "asc" }, { id: "asc" }], select: {
            bookingCode: true, startAt: true, endAt: true, checkedInAt: true,
            checkedInByUser: { select: { firstName: true, lastName: true } },
            customer: { select: { firstName: true, lastName: true } },
            appointmentServices: { where: { membershipStatus: "ACTIVE" }, orderBy: { sequenceNo: "asc" }, select: {
              id: true, serviceNameSnapshot: true, staff: { select: { firstName: true, lastName: true } },
            } },
          } });
        return { timeZone, serverTime: now.toISOString(), page: q.page, pageSize: q.pageSize, total,
          rows: rows.map(row => ({ ...row,
            minutesSinceCheckIn: Math.max(0, Math.floor((+now - +row.checkedInAt!) / 60_000)),
            needsReview: row.endAt <= now,
          })) };
      });
    },

    confirmedServices(actorId: string, q: ConfirmedServicesQuery) {
      return read(actorId, false, async tx => {
        const today = q.arrivalToday === "true"
          ? Temporal.Instant.fromEpochMilliseconds(+(await freshTime(tx))).toZonedDateTimeISO(timeZone).toPlainDate().toString()
          : null;
        const where: Prisma.AppointmentWhereInput = {
          status: "CONFIRMED", completedAt: null, completionType: null,
          ...(today ? {
            startAt: reportPeriod({ from: today, to: today, page: q.page, pageSize: q.pageSize }, timeZone),
            AND: [{ appointmentServices: {
              some: { membershipStatus: "ACTIVE" },
              none: { membershipStatus: "ACTIVE", OR: [
                { outcome: { not: "SCHEDULED" } }, { outcomeFinalizedAt: { not: null } },
              ] },
            } }],
          } : {}),
          ...(q.paymentReady === "true" ? { appointmentServices: {
            some: { membershipStatus: "ACTIVE" as const, outcome: "PERFORMED" as const, actualChargedAmount: { gt: 0 } },
            none: { membershipStatus: "ACTIVE" as const, outcome: "SCHEDULED" as const },
          } } : {}),
          ...(q.search ? { OR: [
            { bookingCode: { contains: q.search, mode: "insensitive" } },
            { AND: q.search.split(/\s+/).map(word => ({ OR: [
              { customer: { firstName: { contains: word, mode: "insensitive" as const } } },
              { customer: { lastName: { contains: word, mode: "insensitive" as const } } },
            ] })) },
          ] } : {}),
        };
        const total = await tx.appointment.count({ where });
        const rows = await tx.appointment.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
          orderBy: [{ startAt: "asc" }, { id: "asc" }], select: {
            bookingCode: true, startAt: true, checkedInAt: true,
            checkedInByUser: { select: { firstName: true, lastName: true } },
            customer: { select: { firstName: true, lastName: true } },
            appointmentServices: { where: { membershipStatus: "ACTIVE" }, orderBy: { sequenceNo: "asc" }, select: {
              id: true, serviceNameSnapshot: true, priceSnapshot: true, outcome: true,
              staffFirstNameSnapshot: true, staffLastNameSnapshot: true,
              staff: { select: { firstName: true, lastName: true } },
            } },
          } });
        return { timeZone, page: q.page, pageSize: q.pageSize, total,
          rows: rows.map(row => ({ ...row, appointmentServices: row.appointmentServices.map(({ staffFirstNameSnapshot, staffLastNameSnapshot, ...service }) => ({ ...service,
            staff: service.staff ?? { firstName: staffFirstNameSnapshot || "Former staff", lastName: staffLastNameSnapshot },
            priceSnapshot: service.priceSnapshot.toFixed(2) })) })) };
      });
    },
    cashierQueue(actorId: string, q: ReportQuery) {
      return read(actorId, false, async tx => {
        const where = { startAt: reportPeriod(q, timeZone), status: { in: ["CONFIRMED", "COMPLETED"] as ("CONFIRMED" | "COMPLETED")[] } };
        const counts = await tx.appointment.groupBy({ by: ["status"], where, _count: { _all: true } });
        const total = counts.reduce((n, r) => n + r._count._all, 0);
        const rows = await tx.appointment.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
          orderBy: [{ status: "asc" }, { startAt: "asc" }, { id: "asc" }], select: {
            bookingCode: true, startAt: true, checkedInAt: true,
            checkedInByUser: { select: { firstName: true, lastName: true } }, status: true, completionType: true,
            customer: { select: { firstName: true, lastName: true } },
            appointmentServices: { where: { membershipStatus: "ACTIVE" }, orderBy: { sequenceNo: "asc" }, select: {
              serviceNameSnapshot: true, outcome: true, staff: { select: { firstName: true, lastName: true } },
            } },
          } });
        return { from: q.from, to: q.to, timeZone, page: q.page, pageSize: q.pageSize, total,
          awaitingSettlement: counts.find(r => r.status === "CONFIRMED")?._count._all ?? 0,
          completed: counts.find(r => r.status === "COMPLETED")?._count._all ?? 0, rows };
      });
    },
    dashboard(actorId: string, q: ReportQuery) {
      return read(actorId, true, async tx => {
        const period = reportPeriod(q, timeZone);
        const appointments = await tx.appointment.groupBy({ by: ["status"], where: { startAt: period }, _count: { _all: true } });
        const commissions = await tx.commissionRecord.aggregate({ where: { finalizedAt: period }, _sum: { commissionAmount: true }, _count: { _all: true } });
        const now = new Date();
        const pendingFees = await tx.appointment.count({ where: { status: "PENDING_PAYMENT", holdExpiresAt: { gte: now } } });
        const unsettled = await tx.appointment.count({ where: { status: "CONFIRMED", startAt: { lte: now } } });
        const reconciliation = await tx.payment.count({ where: { status: "SUCCEEDED", reconciliationStatus: "REQUIRED" } });
        const until = new Date(Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timeZone).add({ days: 7 }).epochMilliseconds);
        const windows = { startsAt: { lt: until }, endsAt: { gt: now } };
        const closures = await tx.salonClosure.findMany({ where: windows, orderBy: { startsAt: "asc" }, take: 20,
          select: { id: true, startsAt: true, endsAt: true, reason: true } });
        const absences = await tx.staffUnavailability.findMany({ where: windows, orderBy: { startsAt: "asc" }, take: 20,
          select: { id: true, staffId: true, startsAt: true, endsAt: true, reason: true, staff: { select: { firstName: true, lastName: true } } } });
        return { timeZone, appointments: appointments.map(r => ({ status: r.status, count: r._count._all })),
          finalizedCommissions: amount(commissions._sum.commissionAmount), commissionCount: commissions._count._all,
          attention: { pendingFees, unsettled, reconciliation }, scheduling: { until, closures, absences } };
      });
    },
    list(actorId: string, kind: Kind, q: ReportQuery) {
      return read(actorId, true, async tx => {
        const period = reportPeriod(q, timeZone);
        const paging = { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
        let rows: unknown[]; let total: number; let dateBasis: string;
        switch (kind) {
          case "appointments": {
            const where = { startAt: period }; dateBasis = "Scheduled start";
            total = await tx.appointment.count({ where });
            rows = await tx.appointment.findMany({ where, ...paging, orderBy: [{ startAt: "desc" }, { id: "desc" }], select: {
              id: true, bookingCode: true, status: true, startAt: true, endAt: true, completionType: true, appointmentFeeAmount: true,
              recoveryOfAppointmentId: true, carriedAppointmentFeePaymentId: true,
              appointmentServices: { orderBy: [{ sequenceNo: "asc" }, { id: "asc" }], select: { serviceNameSnapshot: true, priceSnapshot: true, staffId: true, membershipStatus: true, outcome: true, actualChargedAmount: true } },
            } }); break;
          }
          case "payments": {
            // All attempts remain visible; financial summary uses capture/refund time separately.
            const where = { createdAt: period }; dateBasis = "Payment attempt created";
            total = await tx.payment.count({ where });
            rows = await tx.payment.findMany({ where, ...paging, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: {
              id: true, appointment: booking, type: true, method: true, provider: true, status: true, amount: true, currency: true,
              satisfiesObligation: true, reconciliationStatus: true, createdAt: true, paidAt: true, refundedAt: true,
            } }); break;
          }
          case "receipts": {
            const where = { issuedAt: period }; dateBasis = "Receipt issued";
            total = await tx.receipt.count({ where });
            rows = await tx.receipt.findMany({ where, ...paging, orderBy: [{ issuedAt: "desc" }, { id: "desc" }], select: {
              id: true, receiptNumber: true, paymentId: true, issuedAt: true, receiptSnapshot: true,
            } }); break;
          }
          case "commissions": {
            const where = { finalizedAt: period }; dateBasis = "Commission finalized";
            total = await tx.commissionRecord.count({ where });
            rows = await tx.commissionRecord.findMany({ where, ...paging, orderBy: [{ finalizedAt: "desc" }, { id: "desc" }], select: {
              id: true, appointment: booking, staffId: true, sourcePaymentId: true, appointmentService: { select: { serviceNameSnapshot: true } },
              serviceAmount: true, allocatedAppointmentFee: true, commissionBase: true, commissionRate: true, commissionAmount: true, finalizedAt: true,
            } }); break;
          }
          case "audit": {
            const where = { createdAt: period }; dateBasis = "Audit event recorded";
            total = await tx.auditLog.count({ where });
            const events = await tx.auditLog.findMany({ where, ...paging, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: {
              id: true, action: true, actorType: true, actorUserId: true, actorCustomerId: true, entityType: true, entityId: true, createdAt: true, beforeData: true, afterData: true,
            } });
            rows = events.map(r => ({ ...r, beforeData: safeAudit(r.beforeData), afterData: safeAudit(r.afterData) })); break;
          }
        }
        return { kind, from: q.from, to: q.to, timeZone, dateBasis, page: q.page, pageSize: q.pageSize, total, rows };
      });
    },
  };
}
