import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationQueue } from "../generated/prisma/client.js";
import { parseEnv } from "../src/config/env.schema.js";
import { createPhilSmsProvider, NotificationFailure, smsRecipient, type NotificationMessage } from "../src/modules/notifications/notification-provider.js";
import { renderNotification } from "../src/modules/notifications/templates.js";

const message: NotificationMessage = { id: "stable-queue-id", channel: "EMAIL", recipient: "guest@example.test", subject: "Booking confirmed", text: "Your booking was confirmed." };
const signal = new AbortController().signal;
test("PhilSMS normalizes Philippine numbers and sends authenticated JSON", async () => {
  assert.equal(smsRecipient("0917 123 4567"), "+639171234567");
  assert.equal(smsRecipient("+63 (917) 123-4567"), "+639171234567");
  assert.throws(() => smsRecipient("0"), NotificationFailure);
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://dashboard.philsms.com/api/v3/sms/send");
    assert.equal(new Headers(init!.headers).get("Authorization"), "Bearer secret");
    assert.deepEqual(JSON.parse(String(init!.body)), { recipient: "639171234567", sender_id: "Salon", type: "plain", message: message.text });
    assert.equal(init!.signal, signal); assert.equal(init!.redirect, "error");
    assert.equal(init!.method, "POST");
    assert.equal(new Headers(init!.headers).get("Accept"), "application/json");
    assert.equal(new Headers(init!.headers).get("Content-Type"), "application/json");
    return Response.json({ status: "success", data: { uid: "accepted" } });
  };
  await createPhilSmsProvider("secret", "Salon", request).send({ ...message, channel: "SMS", recipient: "09171234567" }, signal);
});
test("all existing outbox events render without secure tokens or unsupported payment claims", () => {
  const base = { id: "id", recipient: "guest@example.test", channel: "EMAIL" as const, payload: { schemaVersion: 1, bookingCode: "BOOK-123", guestAccessToken: "private", paymentId: "private" } };
  for (const eventType of ["BOOKING_CONFIRMED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED", "NO_SHOW_RECOVERY_CREATED", "PAYMENT_RECEIVED", "APPOINTMENT_COMPLETED"] as const) {
    const rendered = renderNotification({ ...base, eventType }, "Asia/Manila");
    assert.ok(rendered.text.includes("BOOK-123")); assert.ok(!rendered.text.includes("private"));
  }
  const render = (eventType: NotificationQueue["eventType"], data: object) => renderNotification({ ...base, eventType, payload: { ...base.payload, ...data } }, "Asia/Manila").text;
  assert.match(render("PAYMENT_RECEIVED", { reconciliationRequired: true }), /does not confirm/);
  assert.match(render("NO_SHOW_RECOVERY_CREATED", { appointmentStatus: "PENDING_PAYMENT" }), /still required/);
  assert.match(render("APPOINTMENT_COMPLETED", { completionType: "NO_SERVICE_CLOSURE" }), /No service payment/);
  assert.match(render("APPOINTMENT_REMINDER", { startAt: "2026-10-05T01:00:00.000Z", rescheduleCount: 0 }), /9:00 AM.*Asia\/Manila/);
  assert.throws(() => render("APPOINTMENT_REMINDER", {}), /INVALID_PAYLOAD/);
  assert.throws(() => render("BOOKING_CONFIRMED", { bookingCode: "hello\nmalicious" }), /INVALID_PAYLOAD/);
});
test("notification configuration validates credentials, bounds and production restrictions", () => {
  const base = { DATABASE_URL: "postgresql://localhost/test", JWT_SECRET: "a".repeat(32) };
  assert.equal(parseEnv(base).NOTIFICATION_EMAIL_PROVIDER, "disabled");
  for (const bad of [
    { NOTIFICATION_EMAIL_PROVIDER: "gmail" }, { NOTIFICATION_EMAIL_PROVIDER: "resend" }, { NOTIFICATION_SMS_PROVIDER: "philsms" }, { NOTIFICATION_SMS_PROVIDER: "twilio" },
    { NOTIFICATION_LEASE_MS: 5000, NOTIFICATION_TIMEOUT_MS: 10000 }, { NOTIFICATION_MAX_ATTEMPTS: 0 },
    { NOTIFICATION_REMINDER_HOURS: -1 }, { NODE_ENV: "production", TRUSTED_ORIGINS: "https://salon.test", NOTIFICATION_EMAIL_PROVIDER: "test" },
    { NODE_ENV: "production", TRUSTED_ORIGINS: "https://salon.test", NOTIFICATION_SMS_PROVIDER: "test" },
  ]) assert.throws(() => parseEnv({ ...base, ...bad }), /Invalid environment/);
});

test("PhilSMS rejects malformed responses and provider errors without exposing content", async () => {
  const sms = { ...message, channel: "SMS" as const, recipient: "+639171234567" };
  for (const body of [null, [], {}, { status: "queued" }, { status: true }]) {
    await assert.rejects(createPhilSmsProvider("secret", "Salon", async () => Response.json(body)).send(sms, signal), /INVALID_PROVIDER_RESPONSE/);
  }
  await assert.rejects(createPhilSmsProvider("secret", "Salon", async () => new Response("private invalid JSON")).send(sms, signal), /INVALID_PROVIDER_RESPONSE/);
  await assert.rejects(createPhilSmsProvider("secret", "Salon", async () => Response.json({ status: "error", message: "private recipient secret" })).send(sms, signal), (error: NotificationFailure) => {
    assert.equal(error.code, "PROVIDER_REJECTED"); assert.equal(error.retryable, false); assert.equal(error.message, "PROVIDER_REJECTED"); return true;
  });
  for (const status of [400, 401, 403, 408, 409, 422, 429, 500, 503]) {
    await assert.rejects(createPhilSmsProvider("secret", "Salon", async () => new Response("private recipient secret", { status })).send(sms, signal), (error: NotificationFailure) => {
      assert.equal(error.code, `PROVIDER_HTTP_${status}`);
      assert.equal(error.retryable, [408, 409, 429, 500, 503].includes(status)); return true;
    });
  }
});

test("PhilSMS refuses invalid destinations and wrong channels before calling the network", async () => {
  let calls = 0;
  const provider = createPhilSmsProvider("secret", "Salon", async () => { calls++; return Response.json({ status: "success" }); });
  await assert.rejects(provider.send(message, signal), /CHANNEL_MISMATCH/);
  for (const recipient of ["0", "+12025550123", "+63281234567", "+639171234567,+639181234567"]) {
    await assert.rejects(provider.send({ ...message, channel: "SMS", recipient }, signal), (error: NotificationFailure) => {
      assert.equal(error.code, "INVALID_RECIPIENT"); assert.equal(error.retryable, false); return true;
    });
  }
  assert.equal(calls, 0);
});

test("PhilSMS preserves Unicode content and propagates the worker abort signal", async () => {
  const text = "Appointment confirmed — ₱100.00";
  const controller = new AbortController();
  const provider = createPhilSmsProvider("secret", "Salon", async (_url, init) => {
    assert.equal(JSON.parse(String(init!.body)).type, "unicode");
    assert.equal(JSON.parse(String(init!.body)).message, text);
    assert.equal(init!.signal, controller.signal);
    controller.abort(); init!.signal!.throwIfAborted();
    return Response.json({ status: "success" });
  });
  await assert.rejects(provider.send({ ...message, text, channel: "SMS", recipient: "+639171234567" }, controller.signal), { name: "AbortError" });
});

test("PhilSMS configuration requires a token and approved sender and wires the SMS provider", async () => {
  const { configuredNotificationProviders } = await import("../src/modules/notifications/provider-config.js");
  const base = { DATABASE_URL: "postgresql://localhost/test", JWT_SECRET: "a".repeat(32), NOTIFICATION_SMS_PROVIDER: "philsms", PHILSMS_API_TOKEN: "private-token", PHILSMS_SENDER_ID: "Salon" };
  const env = parseEnv(base);
  assert.deepEqual(Object.keys(configuredNotificationProviders(env)), ["SMS"]);
  assert.deepEqual(Object.keys(configuredNotificationProviders(parseEnv({ ...base, NOTIFICATION_SMS_PROVIDER: "disabled" }))), []);
  for (const bad of [{ PHILSMS_API_TOKEN: "" }, { PHILSMS_API_TOKEN: "  " }, { PHILSMS_API_TOKEN: "token\nsecret" }, { PHILSMS_SENDER_ID: "" }, { PHILSMS_SENDER_ID: " " }, { PHILSMS_SENDER_ID: "MoreThan11Chars" }, { PHILSMS_SENDER_ID: "bad\nsender" }]) {
    assert.throws(() => parseEnv({ ...base, ...bad }), /Invalid environment/);
  }
  assert.equal(parseEnv({ ...base, NODE_ENV: "production", TRUSTED_ORIGINS: "https://salon.test" }).NOTIFICATION_SMS_PROVIDER, "philsms");
});
