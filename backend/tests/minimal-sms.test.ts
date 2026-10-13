import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationSms, suppressRoutineSms } from "../src/modules/notifications/minimal-sms.js";
import { parseEnv } from "../src/config/env.schema.js";
test("confirmation uses the requested customer greeting, local time range and reference", () => {
  const message = confirmationSms({ id: "queue-id", recipient: "09171234567" }, {
    startAt: new Date("2026-10-21T23:00:00Z"), endAt: new Date("2026-10-22T01:00:00Z"),
    bookingCode: "BOOK-123", customer: { firstName: "María", lastName: "Santos" },
  }, "Asia/Manila");
  assert.equal(message.text, "Hello, María Santos!\n\n" +
    "Your appointment at Clique Salon has been successfully confirmed, and your appointment fee has been received. Thank you for choosing us!\n\n" +
    "Date: October 22, 2026\nTime: 7:00 AM – 9:00 AM\nReference Number: BOOK-123\n\n" +
    "Please keep your reference number for future inquiries or when managing your existing appointment. Kindly arrive on time to ensure a smooth and hassle-free experience. We look forward to welcoming you to Clique Salon. See you soon!");
  assert.equal(message.recipient, "+639171234567");
  assert.doesNotMatch(message.text, /https?:|Private link|#/);
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
