import type { NotificationQueue } from "../../../generated/prisma/client.js";
import { smsRecipient, type NotificationMessage } from "./notification-provider.js";

export function suppressRoutineSms(row: Pick<NotificationQueue, "channel" | "eventType" | "payload">) {
  if (row.channel !== "SMS") return false;
  if (row.eventType === "APPOINTMENT_REMINDER" || row.eventType === "APPOINTMENT_COMPLETED") return true;
  // Financial exceptions still need a separate notice; they must never claim confirmation.
  return row.eventType === "PAYMENT_RECEIVED" && !(row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) && row.payload.reconciliationRequired === true);
}
export function confirmationSms(row: Pick<NotificationQueue, "id" | "recipient">, appointment: {
  startAt: Date; endAt: Date; bookingCode: string;
  customer: { firstName: string; lastName: string };
}, timeZone: string): NotificationMessage {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric", year: "numeric" }).format(appointment.startAt);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const customerName = `${appointment.customer.firstName} ${appointment.customer.lastName}`.replace(/\s+/g, " ").trim();
  const text = `Hello, ${customerName}!\n\n` +
    "Your appointment at Clique Salon has been successfully confirmed, and your appointment fee has been received. Thank you for choosing us!\n\n" +
    `Date: ${date}\nTime: ${time.format(appointment.startAt)} – ${time.format(appointment.endAt)}\nReference Number: ${appointment.bookingCode}\n\n` +
    "Please keep your reference number for future inquiries or when managing your existing appointment. Kindly arrive on time to ensure a smooth and hassle-free experience. We look forward to welcoming you to Clique Salon. See you soon!";
  return { id: row.id, channel: "SMS", recipient: smsRecipient(row.recipient), subject: "Payment received and booking confirmed", text };
}
