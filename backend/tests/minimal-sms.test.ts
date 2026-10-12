import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationSms, suppressRoutineSms } from "../src/modules/notifications/minimal-sms.js";
import { parseEnv } from "../src/config/env.schema.js";
test("confirmation contains simple booking details in one SMS without links", () => {
  const message = confirmationSms({ id: "queue-id", recipient: "09171234567" }, new Date("2026-10-15T06:00:00Z"), "Asia/Manila", "BOOK-123");
  assert.equal(message.text, "CLIQUE: Fee paid. Confirmed Oct 15, 2026, 2:00 PM (salon time). Booking: BOOK-123.");
  assert.ok(message.text.length <= 160);
  assert.match(message.text, /^[\x20-\x7E]+$/);
  assert.doesNotMatch(message.text, /https?:|Private link|#/);
  assert.throws(() => confirmationSms({ id: "id", recipient: "09171234567" }, new Date(), "Asia/Manila", "A".repeat(160)), /SMS_CONTENT_TOO_LONG/);
});
test("minimal policy suppresses routine SMS while keeping changes, exceptions and email", () => {
  for (const eventType of ["PAYMENT_RECEIVED", "APPOINTMENT_COMPLETED", "APPOINTMENT_REMINDER"] as const) {
    assert.equal(suppressRoutineSms({ channel: "SMS", eventType, payload: {} }), true);
    assert.equal(suppressRoutineSms({ channel: "EMAIL", eventType, payload: {} }), false);
  }
  for (const eventType of ["BOOKING_CONFIRMED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"] as const) assert.equal(suppressRoutineSms({ channel: "SMS", eventType, payload: {} }), false);
  assert.equal(suppressRoutineSms({ channel: "SMS", eventType: "PAYMENT_RECEIVED", payload: { reconciliationRequired: true } }), false);
});
test("public link origins must be trusted, without credentials, paths or query parameters", () => {
  const base = { DATABASE_URL: "postgresql://localhost/test", JWT_SECRET: "s".repeat(32), TRUSTED_ORIGINS: "https://salon.example.com" };
  assert.equal(parseEnv(base).NOTIFICATION_SMS_POLICY, "minimal");
  assert.equal(parseEnv({ ...base, PUBLIC_SITE_URL: "https://salon.example.com" }).PUBLIC_SITE_URL, "https://salon.example.com");
  for (const url of ["https://attacker.test", "https://secret@salon.example.com", "https://salon.example.com/path", "https://salon.example.com?key=value"]) assert.throws(() => parseEnv({ ...base, PUBLIC_SITE_URL: url }));
});
