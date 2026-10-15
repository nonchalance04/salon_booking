import assert from "node:assert/strict";
import { test } from "node:test";
import { coversReservation, overlaps } from "../src/modules/scheduling/coverage.js";
import { staffSkillsSchema, staffSchema, staffUpdateSchema, serviceSchema, qualificationSchema, hoursSchema, scheduleSchema, policySchema, closureSchema } from "../src/modules/configuration/configuration.schema.js";

const time = (value: string) => new Date(`1970-01-01T${value}:00Z`);
test("weekly coverage uses salon-local weekdays, full buffers, and contiguous window unions", () => {
  const start = new Date("2030-01-07T01:00:00Z"); // Monday 09:00 Manila
  const end = new Date("2030-01-07T01:45:00Z");
  const window = { dayOfWeek: "MONDAY", startTime: time("09:00"), endTime: time("09:30") };
  assert.equal(coversReservation(start, end, [window], "Asia/Manila"), false);
  assert.equal(coversReservation(start, end, [window, { ...window, startTime: time("09:30"), endTime: time("09:45") }], "Asia/Manila"), true);
  assert.equal(coversReservation(start, end, [window, { ...window, startTime: time("09:31"), endTime: time("10:00") }], "Asia/Manila"), false);
  assert.equal(coversReservation(start, end, [{ ...window, endTime: time("10:00"), effectiveFrom: new Date("2030-01-08") }], "Asia/Manila"), false);
  assert.equal(coversReservation(start, end, [{ ...window, endTime: time("10:00"), effectiveTo: new Date("2030-01-07") }], "Asia/Manila"), true);
  assert.equal(overlaps(start, end, end, new Date(end.getTime() + 1000)), false);
  assert.equal(overlaps(start, end, new Date(end.getTime() - 1), new Date(end.getTime() + 1000)), true);
});
test("coverage respects timezone transitions and local calendar dates", () => {
  const windows = [{ dayOfWeek: "SUNDAY", startTime: time("01:00"), endTime: time("04:00") }];
  assert.equal(coversReservation(new Date("2030-03-10T06:00:00Z"), new Date("2030-03-10T08:00:00Z"), windows, "America/New_York"), true);
  assert.equal(coversReservation(new Date("2030-01-06T23:30:00Z"), new Date("2030-01-07T00:15:00Z"), [{ dayOfWeek: "MONDAY", startTime: time("07:00"), endTime: time("09:00") }], "Asia/Manila"), true);
});
test("configuration schemas preserve null/zero buffers and reject invalid money, times, references, and policy types", () => {
  const service = { name: "Cut", description: null, price: "120.00", durationMinutes: 30, bufferMinutes: null, isActive: true };
  assert.equal(serviceSchema.parse(service).bufferMinutes, null);
  assert.equal(serviceSchema.parse({ ...service, bufferMinutes: 0 }).bufferMinutes, 0);
  for (const price of [0, "0", "1.001", "10000000000", "NaN", "-1"]) assert.equal(serviceSchema.safeParse({ ...service, price }).success, false);
  assert.equal(qualificationSchema.safeParse({ staffId: "bad", serviceId: "bad", commissionRate: "1.1", isActive: true }).success, false);
  assert.equal(hoursSchema.safeParse({ dayOfWeek: "MONDAY", openTime: "12:00", closeTime: "12:00", isActive: true }).success, false);
  assert.equal(scheduleSchema.safeParse({ staffId: "10000000-0000-4000-8000-000000000001", dayOfWeek: "MONDAY", startTime: "08:00", endTime: "09:00", effectiveFrom: "2030-02-30", effectiveTo: null, isActive: true }).success, false);
  assert.equal(closureSchema.safeParse({ startsAt: "2030-01-01T09:00", endsAt: "2030-01-01T10:00", reason: null }).success, false);
  assert.equal(policySchema.safeParse({ appointmentFeeType: "PERCENTAGE" }).success, false);
});

test("public staff profiles validate images, ratings, limits, and fields", async () => {
  const { staffPublicProfileSchema } = await import("../src/modules/configuration/configuration.schema.js");
  const profile = { title: "Senior stylist", bio: "Cuts and color", photoUrl: null, languages: ["English"], portfolio: [], reviews: [] };
  assert.equal(staffPublicProfileSchema.parse(profile).title, "Senior stylist");
  for (const photoUrl of ["javascript:alert(1)", "data:image/png;base64,abc", "http://example.com/photo.jpg", "https://user:pass@example.com/photo.jpg"]) {
    assert.equal(staffPublicProfileSchema.safeParse({ ...profile, photoUrl }).success, false);
  }
  assert.equal(staffPublicProfileSchema.safeParse({ ...profile, reviews: [{ author: "Client", rating: 6, text: "Great" }] }).success, false);
  assert.equal(staffPublicProfileSchema.safeParse({ ...profile, languages: Array(11).fill("English") }).success, false);
  assert.equal(staffPublicProfileSchema.safeParse({ ...profile, appointmentsCompleted: 99 }).success, false);
});

test("staff skill inputs reject duplicate services and invalid commission rates", () => {
  const item = { serviceId: "10000000-0000-4000-8000-000000000001", commissionRate: "0.4" };
  assert.equal(staffSkillsSchema.safeParse({ services: [] }).success, true);
  assert.equal(staffSkillsSchema.safeParse({ services: [item] }).success, true);
  assert.equal(staffSkillsSchema.safeParse({ services: [item, item] }).success, false);
  for (const commissionRate of ["1.01", "-0.1", "NaN", "0.12345", 0.4]) {
    assert.equal(staffSkillsSchema.safeParse({ services: [{ ...item, commissionRate }] }).success, false);
  }
  const input = { name: "Manicure", description: null, price: "120.00", durationMinutes: 30, bufferMinutes: null, isActive: true };
  assert.equal(serviceSchema.parse({ ...input, category: " Nails " }).category, "Nails");
  assert.equal(serviceSchema.safeParse({ ...input, category: " " }).success, false);
});


test("staff edits allow a blank last name while new staff still require one", () => {
  const input = { firstName: "Jamie", phone: null, isActive: true };
  for (const lastName of ["", "   "]) {
    assert.equal(staffUpdateSchema.parse({ ...input, lastName }).lastName, "");
    assert.equal(staffSchema.safeParse({ ...input, lastName }).success, false);
  }
  assert.equal(staffUpdateSchema.parse(input).lastName, "");
  assert.equal(staffUpdateSchema.parse({ ...input, lastName: " Santos " }).lastName, "Santos");
  assert.equal(staffSchema.safeParse(input).success, false);
  for (const lastName of [null, 123, "x".repeat(201)]) {
    assert.equal(staffUpdateSchema.safeParse({ ...input, lastName }).success, false);
  }
});
