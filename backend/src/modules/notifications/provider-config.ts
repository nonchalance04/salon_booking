import { createGmailProvider } from "./gmail-provider.js";
import type { parseEnv } from "../../config/env.schema.js";
import { createTextBeeProvider, createTestNotificationProvider, createPhilSmsProvider, type NotificationProvider } from "./notification-provider.js";

export function configuredNotificationProviders(env: ReturnType<typeof parseEnv>) {
  const providers: Partial<Record<"EMAIL" | "SMS", NotificationProvider>> = {};
  // Test delivery logs only the queue identity and channel, never message/contact data.
  const test = createTestNotificationProvider(message => console.info(JSON.stringify({ event: "notification_test_accepted", id: message.id, channel: message.channel })));
  if (env.NODE_ENV === "production" && (env.NOTIFICATION_EMAIL_PROVIDER === "test" || env.NOTIFICATION_SMS_PROVIDER === "test")) throw new Error("Test notifications are unavailable in production.");
  if (env.NOTIFICATION_EMAIL_PROVIDER === "test") providers.EMAIL = test;
  if (env.NOTIFICATION_SMS_PROVIDER === "test") providers.SMS = test;
  if (env.NOTIFICATION_EMAIL_PROVIDER === "gmail") providers.EMAIL = createGmailProvider(env.GMAIL_USER!, env.GMAIL_APP_PASSWORD!, env.NOTIFICATION_EMAIL_FROM!, env.NOTIFICATION_TIMEOUT_MS);
  if (env.NOTIFICATION_SMS_PROVIDER === "philsms") providers.SMS = createPhilSmsProvider(env.PHILSMS_API_TOKEN!, env.PHILSMS_SENDER_ID!);
  if (env.NOTIFICATION_SMS_PROVIDER === "textbee") providers.SMS = createTextBeeProvider(env.TEXTBEE_API_KEY!, env.TEXTBEE_DEVICE_ID!);
  return providers;
}
