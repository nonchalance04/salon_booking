import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingSchema, guestAccessSchema } from "../src/modules/appointments/appointments.schema.js";
import { createGuestCredentials, tokenHash, validGuestToken } from "../src/modules/appointments/appointments.security.js";
test("guest credentials have independent random entropy and constant-length hashed storage", () => {
  const a = createGuestCredentials(); const b = createGuestCredentials();
  assert.notEqual(a.token, b.token); assert.notEqual(a.bookingCode, b.bookingCode);
  assert.match(a.bookingCode, /^SL-[A-Z0-9]{6}$/);
  assert.equal(a.hash.length, 64); assert.equal(a.hash, tokenHash(a.token));
  assert.ok(validGuestToken(a.token, a.hash)); assert.ok(!validGuestToken(b.token, a.hash));
  assert.ok(!validGuestToken(a.token, "malformed"));
  assert.ok(guestAccessSchema.safeParse({ bookingCode: a.bookingCode, token: a.token }).success);
});
test("booking validation accepts contact details, requires an exact start, and rejects authority overrides", () => {
  const input = { date: "2026-10-10", startAt: "2026-10-10T09:00:00+08:00", services: [{ serviceId: "11111111-1111-4111-8111-111111111111", assignmentMode: "ANY_AVAILABLE" }], customer: { firstName: " Guest ", lastName: "Name", phone: "+63 917 123 4567", email: "GUEST@example.test" } };
  assert.equal(bookingSchema.parse(input).customer.firstName, "Guest");
  assert.equal(bookingSchema.parse(input).customer.email, "guest@example.test");
  assert.ok(!bookingSchema.safeParse({ ...input, startAt: undefined }).success);
  assert.ok(!bookingSchema.safeParse({ ...input, status: "CONFIRMED" }).success);
  assert.ok(!bookingSchema.safeParse({ ...input, customer: { ...input.customer, id: "injected" } }).success);
});

test("guest access preserves historical references and validates short references", () => {
  const { token } = createGuestCredentials();
  for (const bookingCode of ["SL-A7K2Q9", `SL-${"A".repeat(24)}`]) {
    assert.ok(guestAccessSchema.safeParse({ bookingCode, token }).success);
  }
  for (const bookingCode of ["SL-ABCDE", "SL-ABCDEFG", "SL-abc123", "SL-ABC!23"]) {
    assert.ok(!guestAccessSchema.safeParse({ bookingCode, token }).success);
  }
});
