import { z } from "zod";
import { renderSimpleEmailLayout } from "./simple-email-layout.js";
import type { NotificationQueue } from "../../../generated/prisma/client.js";
import {
  NotificationFailure,
  smsRecipient,
  type NotificationMessage,
} from "./notification-provider.js";

export const notificationPayload = z.object({
  paymentId: z.string().optional(),
  appointmentFeePaid: z.boolean().optional(),
  schemaVersion: z.literal(1),
  bookingCode: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/),
  startAt: z.iso.datetime().optional(),
  rescheduleCount: z.number().int().nonnegative().optional(),
  appointmentStatus: z
    .enum([
      "PENDING_PAYMENT",
      "CONFIRMED",
      "CANCELLED",
      "EXPIRED",
      "NO_SHOW",
      "COMPLETED",
    ])
    .optional(),
  completionType: z
    .enum(["SERVICE_SETTLEMENT", "NO_SERVICE_CLOSURE"])
    .optional(),
  reconciliationRequired: z.boolean().optional(),
});

export function renderNotification(
  row: Pick<
    NotificationQueue,
    "id" | "channel" | "recipient" | "eventType" | "payload"
  >,
  timeZone: string,
  publicSiteUrl?: string,
): NotificationMessage {
  const parsed = notificationPayload.safeParse(row.payload);
  if (!parsed.success) throw new NotificationFailure("INVALID_PAYLOAD", false);
  if (row.channel === "EMAIL" && !z.email().safeParse(row.recipient).success)
    throw new NotificationFailure("INVALID_RECIPIENT", false);
  const p = parsed.data;
  const when = p.startAt
    ? new Intl.DateTimeFormat("en-PH", {
        timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(p.startAt)) + ` (${timeZone})`
    : undefined;
  let subject: string;
  let text: string;
  switch (row.eventType) {
    case "BOOKING_CONFIRMED":
      if (row.channel === "EMAIL" && (p.appointmentFeePaid || (p.paymentId && p.appointmentStatus === "CONFIRMED" && p.reconciliationRequired === false))) {
        subject = "Payment received - your appointment is confirmed";
        text =
          "Thank you! Your appointment fee has been received.\n\n" +
          `Your booking is confirmed${when ? ` for ${when}` : ""}.\n\n` +
          "Appointment reminder: Please arrive 10 minutes early.\n" +
          "We look forward to seeing you!";
      } else {
        subject = "Booking confirmed";
        text = `Your booking was confirmed${when ? ` for ${when}` : ""}.`;
      }
      break;
    case "BOOKING_RESCHEDULED":
      subject = "Booking rescheduled";
      text = `Your booking was rescheduled${when ? ` to ${when}` : ""}.`;
      break;
    case "BOOKING_CANCELLED":
      subject = "Booking cancelled";
      text = "Your booking was cancelled.";
      break;
    case "NO_SHOW_RECOVERY_CREATED":
      subject = "Replacement booking created";
      text = `Your replacement booking was created${when ? ` for ${when}` : ""}.${p.appointmentStatus === "PENDING_PAYMENT" ? " Appointment-fee payment is still required to confirm it." : ""}`;
      break;
    case "PAYMENT_RECEIVED":
      subject = "Payment received";
      text = p.reconciliationRequired
        ? "Your payment was received and needs salon review. This payment does not confirm a reservation. Please contact the salon."
        : "Your payment was received.";
      break;
    case "APPOINTMENT_COMPLETED":
      subject = "Appointment completed";
      text =
        p.completionType === "NO_SERVICE_CLOSURE"
          ? "Your appointment was closed with no services performed. No service payment was collected."
          : "Your appointment was completed.";
      break;
    case "APPOINTMENT_REMINDER":
      if (!when || p.rescheduleCount === undefined)
        throw new NotificationFailure("INVALID_PAYLOAD", false);
      subject = "Appointment reminder";
      text = `Your appointment is scheduled for ${when}.`;
      break;
  }
  const appointmentUrl = row.channel === "EMAIL" && row.eventType === "BOOKING_CONFIRMED" && publicSiteUrl
    ? new URL("/appointment", publicSiteUrl).href : undefined;
  return {
    id: row.id,
    channel: row.channel,
    recipient:
      row.channel === "SMS" ? smsRecipient(row.recipient) : row.recipient,
    subject,
    text: `Booking ${p.bookingCode}: ${text}${appointmentUrl ? `\n\nYour Appointment: ${appointmentUrl}\nView and manage your appointment details. Verify your email or phone number to access your appointment.` : ""}`,
    ...(row.channel === "EMAIL" ? { html: renderSimpleEmailLayout({
      title: subject, text, bookingCode: p.bookingCode, when, appointmentUrl,
    }) } : {}),
  };
}
