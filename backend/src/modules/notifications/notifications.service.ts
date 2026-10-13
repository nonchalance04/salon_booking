import {
  confirmationSms,
  suppressRoutineSms,
} from "./minimal-sms.js";
import {
  Prisma,
  type PrismaClient,
  type NotificationQueue,
} from "../../../generated/prisma/client.js";
import {
  NotificationFailure,
  type NotificationProvider,
} from "./notification-provider.js";
import { notificationPayload, renderNotification } from "./templates.js";

export type NotificationOptions = {
  providers: Partial<Record<"EMAIL" | "SMS", NotificationProvider>>;
  timeZone: string;
  leaseMs: number;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  reminderHours: number;
  smsPolicy?: "single" | "minimal" | "all";
  publicSiteUrl?: string;
  bookingLinkSecret?: string;
};

export function createNotificationsService(
  db: PrismaClient,
  options: NotificationOptions,
) {
  if (
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 20 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    !Number.isFinite(options.leaseMs) ||
    options.leaseMs <= options.timeoutMs ||
    !Number.isFinite(options.retryBaseMs) ||
    options.retryBaseMs < 1 ||
    !Number.isFinite(options.reminderHours) ||
    options.reminderHours < 0
  )
    throw new Error("Invalid notification worker options.");
  const minimalSms = options.smsPolicy !== "all";
  const channels = Object.keys(options.providers).filter(
    (channel) => options.providers[channel as "EMAIL" | "SMS"],
  );

  async function claim() {
    if (!channels.length) return null;
    // One SQL statement claims one job just before processing; no batch can expire
    // while waiting for earlier provider calls. PostgreSQL supplies the clock.
    return db.$transaction(async tx => {
      const rows = await tx.$queryRaw<NotificationQueue[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id" FROM "NotificationQueue"
          WHERE "channel"::text IN (${Prisma.join(channels)}) AND (
            ("status" = 'PENDING' AND "scheduledAt" <= clock_timestamp()) OR
            ("status" = 'PROCESSING' AND "updatedAt" <= clock_timestamp() - ${options.leaseMs} * interval '1 millisecond')
          ) ORDER BY "scheduledAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE "NotificationQueue" q SET
          "status" = CASE WHEN q."attemptCount" >= ${options.maxAttempts} THEN 'FAILED'::"NotificationStatus" ELSE 'PROCESSING'::"NotificationStatus" END,
          "attemptCount" = CASE WHEN q."attemptCount" >= ${options.maxAttempts} THEN q."attemptCount" ELSE q."attemptCount" + 1 END,
          "lastError" = CASE WHEN q."attemptCount" >= ${options.maxAttempts} THEN 'ATTEMPTS_EXHAUSTED' ELSE q."lastError" END,
          "updatedAt" = clock_timestamp()
        FROM candidate WHERE q."id" = candidate."id" RETURNING q.*
      `);
      const row = rows[0];
      if (!row) return null;
      if (options.smsPolicy === "single" && row.channel === "SMS" && row.status === "PROCESSING") {
        let reason: string | undefined;
        if (row.eventType !== "BOOKING_CONFIRMED" || !row.appointmentId) {
          reason = "SMS_SINGLE_POLICY";
        } else {
          // Serialize claims for the same booking, even across worker processes.
          await tx.$queryRaw`SELECT "id" FROM "Appointment" WHERE "id" = ${row.appointmentId}::uuid FOR UPDATE`;
          const previous = await tx.notificationQueue.findFirst({ where: {
            appointmentId: row.appointmentId, channel: "SMS", id: { not: row.id },
            status: { in: ["SENT", "PROCESSING", "FAILED"] },
          } });
          if (previous) reason = "SMS_BOOKING_LIMIT";
        }
        if (reason) return tx.notificationQueue.update({ where: { id: row.id }, data: { status: "SKIPPED", lastError: reason } });
      }
      return row;
    });
  }

  async function fail(row: NotificationQueue, error: unknown) {
    const known = error instanceof NotificationFailure;
    const retry =
      !(minimalSms && row.channel === "SMS") &&
      (!known || error.retryable) &&
      row.attemptCount < options.maxAttempts;
    const code = known ? error.code : "PROVIDER_UNAVAILABLE";
    const delay = Math.min(
      options.retryBaseMs * 2 ** (row.attemptCount - 1),
      3_600_000,
    );
    return db.$executeRaw`
      UPDATE "NotificationQueue" SET "status" = ${retry ? "PENDING" : "FAILED"}::"NotificationStatus",
        "lastError" = ${code}, "updatedAt" = clock_timestamp(),
        "scheduledAt" = CASE WHEN ${retry} THEN clock_timestamp() + ${delay} * interval '1 millisecond' ELSE "scheduledAt" END
      WHERE "id" = ${row.id}::uuid AND "status" = 'PROCESSING' AND "attemptCount" = ${row.attemptCount}
    `;
  }

  async function skip(row: NotificationQueue, reason: string) {
    await db.notificationQueue.updateMany({
      where: {
        id: row.id,
        status: "PROCESSING",
        attemptCount: row.attemptCount,
      },
      data: { status: "SKIPPED", lastError: reason },
    });
  }

  async function deliver(row: NotificationQueue) {
    // A delayed caller must not start delivery for a claim already reclaimed.
    const live = await db.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "NotificationQueue"
      WHERE "id" = ${row.id}::uuid AND "status" = 'PROCESSING' AND "attemptCount" = ${row.attemptCount}
        AND "updatedAt" > clock_timestamp() - ${options.leaseMs} * interval '1 millisecond'`;
    if (!live.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      if (row.channel === "EMAIL" && row.eventType === "APPOINTMENT_REMINDER") {
        await skip(row, "EMAIL_REMINDER_INCLUDED_IN_CONFIRMATION");
        return;
      }
      if (row.channel === "EMAIL" && row.eventType === "PAYMENT_RECEIVED" && row.appointmentId) {
        const payload = notificationPayload.safeParse(row.payload);
        if (payload.success && payload.data.paymentId && payload.data.reconciliationRequired === false && payload.data.appointmentStatus === "CONFIRMED") {
          const confirmation = await db.notificationQueue.findFirst({ where: {
            appointmentId: row.appointmentId, channel: "EMAIL", recipient: row.recipient,
            eventType: "BOOKING_CONFIRMED",
            payload: { path: ["paymentId"], equals: payload.data.paymentId },
          } });
          if (confirmation) {
            await skip(row, "EMAIL_COMBINED_WITH_CONFIRMATION");
            return;
          }
        }
      }
      if (minimalSms && row.channel === "SMS") {
        if (suppressRoutineSms(row)) {
          await skip(row, "SMS_MINIMAL_POLICY");
          return;
        }
        if (row.attemptCount > 1) {
          await skip(row, "SMS_DELIVERY_UNCERTAIN");
          return;
        }
      }
      let message = renderNotification(row, options.timeZone, options.publicSiteUrl);
      if (
        row.channel === "SMS" &&
        row.eventType === "BOOKING_CONFIRMED"
      ) {
        const appointment = row.appointmentId
          ? await db.appointment.findUnique({
              where: { id: row.appointmentId },
              include: { customer: { select: { firstName: true, lastName: true } } },
            })
          : null;
        if (
          !appointment ||
          appointment.status !== "CONFIRMED" ||
          appointment.startAt <= new Date()
        ) {
          await skip(row, "CONFIRMATION_OBSOLETE");
          return;
        }
        const payment = await db.payment.findFirst({
          where: {
            appointmentId: appointment.id,
            type: "APPOINTMENT_FEE",
            status: "SUCCEEDED",
            satisfiesObligation: true,
          },
        });
        if (!payment) {
          await skip(row, "CONFIRMATION_PAYMENT_UNVERIFIED");
          return;
        }
        message = confirmationSms(
          row,
          appointment,
          options.timeZone,
        );
      }
      if (row.eventType === "APPOINTMENT_REMINDER") {
        const p = notificationPayload.parse(row.payload);
        const current =
          row.appointmentId &&
          (await db.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Appointment" WHERE "id" = ${row.appointmentId}::uuid AND "status" = 'CONFIRMED'
            AND "startAt" > clock_timestamp() AND "startAt" = ${new Date(p.startAt!)}
            AND "rescheduleCount" = ${p.rescheduleCount!}`);
        if (!current || !current.length)
          throw new NotificationFailure("REMINDER_OBSOLETE", false);
      }
      const provider = options.providers[row.channel];
      if (!provider) throw new NotificationFailure("PROVIDER_DISABLED");
      await Promise.race([
        provider.send(message, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new NotificationFailure("PROVIDER_TIMEOUT"));
          }, options.timeoutMs);
        }),
      ]);
      await db.$executeRaw`UPDATE "NotificationQueue" SET "status" = 'SENT', "sentAt" = clock_timestamp(),
        "lastError" = NULL, "updatedAt" = clock_timestamp()
        WHERE "id" = ${row.id}::uuid AND "status" = 'PROCESSING' AND "attemptCount" = ${row.attemptCount}`;
    } catch (error) {
      await fail(row, error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function enqueueReminders(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid reminder batch size.");
    // Email appointment details are included in confirmation; only full-policy SMS uses reminders.
    if (!options.reminderHours || minimalSms || !options.providers.SMS) return 0;
    return db.$transaction(async (tx) => {
      // The appointment lock serializes reminder creation with other scanners and
      // appointment changes. Existing rows, including SENT/FAILED, deduplicate a
      // schedule revision. No new queue model or unique constraint is needed.
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT a."id" FROM "Appointment" a WHERE a."status" = 'CONFIRMED'
          AND EXISTS (SELECT 1 FROM "Customer" c WHERE c.id = a."customerId" AND c.email IS NULL)
          AND a."startAt" > clock_timestamp()
          AND a."startAt" <= clock_timestamp() + ${options.reminderHours} * interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM "NotificationQueue" q WHERE q."appointmentId" = a."id"
            AND q."eventType" = 'APPOINTMENT_REMINDER'
            AND q."payload"->>'rescheduleCount' = a."rescheduleCount"::text
            AND (q."payload"->>'startAt') = to_char(a."startAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY a."startAt", a."id" FOR UPDATE OF a SKIP LOCKED LIMIT ${limit}`;
      let count = 0;
      for (const { id } of candidates) {
        const row = await tx.appointment.findUniqueOrThrow({
          where: { id },
          include: { customer: true },
        });
        if (row.customer.email) continue;
        const now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0]!.now;
        if (row.status !== "CONFIRMED" || row.startAt <= now) continue;
        // Recheck after locking: a concurrent scanner may have committed between
        // the statement snapshot and acquisition of this appointment's lock.
        const payload = {
          schemaVersion: 1,
          bookingCode: row.bookingCode,
          startAt: row.startAt.toISOString(),
          rescheduleCount: row.rescheduleCount,
          appointmentStatus: row.status,
        };
        if (
          await tx.notificationQueue.findFirst({
            where: {
              appointmentId: id,
              eventType: "APPOINTMENT_REMINDER",
              AND: [
                { payload: { path: ["startAt"], equals: payload.startAt } },
                {
                  payload: {
                    path: ["rescheduleCount"],
                    equals: row.rescheduleCount,
                  },
                },
              ],
            },
          })
        )
          continue;
        await tx.notificationQueue.create({
          data: {
            appointmentId: id,
            customerId: row.customerId,
            eventType: "APPOINTMENT_REMINDER",
            channel: row.customer.email ? "EMAIL" : "SMS",
            recipient: row.customer.email ?? row.customer.phone,
            status: "PENDING",
            scheduledAt: now,
            payload,
          },
        });
        count++;
      }
      return count;
    });
  }

  return {
    claim,
    deliver,
    enqueueReminders,
    async processNext() {
      const row = await claim();
      if (!row) return false;
      if (row.status === "PROCESSING") await deliver(row);
      return true;
    },
  };
}
