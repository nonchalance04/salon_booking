import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEmailLayout } from "../src/modules/notifications/email-layout.js";
import { renderSimpleEmailLayout } from "../src/modules/notifications/simple-email-layout.js";
import { renderNotification } from "../src/modules/notifications/templates.js";

test("confirmation emails link to appointment management in HTML and plain text", () => {
  const row = { id: "id", recipient: "guest@example.test", channel: "EMAIL" as const,
    eventType: "BOOKING_CONFIRMED" as const, payload: { schemaVersion: 1, bookingCode: "BOOK-123", appointmentFeePaid: true } };
  const message = renderNotification(row, "Asia/Manila", "https://salon.example.com/");
  assert.match(message.html!, /href="https:\/\/salon.example.com\/appointment"[^>]*>Your Appointment<\/a>/);
  assert.match(message.html!, /View and manage your appointment details/);
  assert.match(message.text, /Your Appointment: https:\/\/salon.example.com\/appointment/);
  assert.match(message.text, /Verify your email or phone number/);
  assert.match(message.text, /appointment fee has been received/);
  const generic = renderNotification({ ...row, payload: { schemaVersion: 1, bookingCode: "BOOK-123" } }, "Asia/Manila", "https://salon.example.com");
  assert.match(generic.html!, />Your Appointment<\/a>/);
  assert.ok(!renderNotification(row, "Asia/Manila").html!.includes('href='));
  const cancelled = renderNotification({ ...row, eventType: "BOOKING_CANCELLED" }, "Asia/Manila", "https://salon.example.com");
  assert.ok(!cancelled.html!.includes('href='));
  const sms = renderNotification({ ...row, channel: "SMS", recipient: "09171234567" }, "Asia/Manila", "https://salon.example.com");
  assert.ok(!sms.text.includes("https://"));
});

test("email layout escapes dynamic content including titles, details and codes", () => {
  const unsafe = '<script>alert("test")</script>&';
  for (const render of [renderEmailLayout, renderSimpleEmailLayout]) {
    const html = render({ title: unsafe, text: unsafe, bookingCode: unsafe, when: unsafe, verificationCode: unsafe });
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;&amp;"));
  }
});

test("all notification events receive HTML without exposing private payload fields", () => {
  const base = { id: "id", recipient: "guest@example.test", channel: "EMAIL" as const,
    payload: { schemaVersion: 1, bookingCode: "BOOK-123", startAt: "2026-10-12T01:00:00.000Z", rescheduleCount: 0, guestAccessToken: "private-token", paymentId: "private-payment" } };
  for (const eventType of ["BOOKING_CONFIRMED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED", "NO_SHOW_RECOVERY_CREATED", "PAYMENT_RECEIVED", "APPOINTMENT_COMPLETED", "APPOINTMENT_REMINDER"] as const) {
    const message = renderNotification({ ...base, eventType }, "Asia/Manila");
    assert.ok(message.html?.includes("BOOK-123"));
    assert.ok(message.html?.includes("9:00 AM (Asia/Manila)"));
    assert.ok(!message.html?.includes("private-"));
    const sms = renderNotification({ ...base, channel: "SMS", recipient: "09171234567", eventType }, "Asia/Manila");
    assert.equal(sms.html, undefined);
  }
});

test("payment review and no-service closure notices remain visible in HTML", () => {
  const base = { id: "id", recipient: "guest@example.test", channel: "EMAIL" as const };
  const payment = renderNotification({ ...base, eventType: "PAYMENT_RECEIVED", payload: {
    schemaVersion: 1, bookingCode: "BOOK-123", reconciliationRequired: true,
  } }, "Asia/Manila");
  assert.match(payment.html!, /does not confirm a reservation/);
  const completed = renderNotification({ ...base, eventType: "APPOINTMENT_COMPLETED", payload: {
    schemaVersion: 1, bookingCode: "BOOK-123", completionType: "NO_SERVICE_CLOSURE",
  } }, "Asia/Manila");
  assert.match(completed.html!, /No service payment was collected/);
});
