import assert from "node:assert/strict";
import { test } from "node:test";
import { noShowCorrectionSchema } from "../src/modules/appointments/appointments.schema.js";

test("no-show correction requires a meaningful reason and explicit physical presence without forged fields", () => {
  const input = { bookingCode: "SL-TEST", reason: " Arrival missed by staff ", customerPresent: true };
  assert.equal(noShowCorrectionSchema.parse(input).reason, "Arrival missed by staff");
  for (const value of [
    { ...input, reason: "  " }, { ...input, reason: "a".repeat(1001) },
    { ...input, customerPresent: false }, { bookingCode: input.bookingCode, reason: input.reason },
    { ...input, checkedInAt: new Date().toISOString() }, { ...input, checkedInByUserId: "forged" },
    { ...input, startAt: new Date().toISOString() },
  ]) assert.equal(noShowCorrectionSchema.safeParse(value).success, false);
});
