import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleForAutomaticNoShow, NO_SHOW_ARRIVAL_GRACE_MS } from "../src/modules/appointments/appointment-changes.service.js";

test("automatic no-show starts exactly at fifteen minutes and excludes arrived or recorded visits", () => {
  const startAt = new Date("2026-10-13T02:00:00Z");
  const row = { status: "CONFIRMED", startAt, checkedInAt: null, completedAt: null, completionType: null,
    appointmentServices: [{ membershipStatus: "ACTIVE", outcome: "SCHEDULED", outcomeFinalizedAt: null }] };
  const deadline = new Date(+startAt + NO_SHOW_ARRIVAL_GRACE_MS);
  assert.equal(eligibleForAutomaticNoShow(row, new Date(+deadline - 1)), false);
  assert.equal(eligibleForAutomaticNoShow(row, deadline), true);
  assert.equal(eligibleForAutomaticNoShow({ ...row, checkedInAt: startAt }, deadline), false);
  assert.equal(eligibleForAutomaticNoShow({ ...row, completedAt: deadline }, deadline), false);
  assert.equal(eligibleForAutomaticNoShow({ ...row, completionType: "NO_SERVICE" }, deadline), false);
  for (const status of ["PENDING_PAYMENT", "NO_SHOW", "CANCELLED", "EXPIRED", "COMPLETED"]) {
    assert.equal(eligibleForAutomaticNoShow({ ...row, status }, deadline), false);
  }
  for (const outcome of ["PERFORMED", "NOT_PERFORMED"]) {
    assert.equal(eligibleForAutomaticNoShow({ ...row, appointmentServices: [{ ...row.appointmentServices[0]!, outcome }] }, deadline), false);
  }
  assert.equal(eligibleForAutomaticNoShow({ ...row, appointmentServices: [{ ...row.appointmentServices[0]!, outcomeFinalizedAt: deadline }] }, deadline), false);
  assert.equal(eligibleForAutomaticNoShow({ ...row, appointmentServices: [{ membershipStatus: "REMOVED", outcome: "PERFORMED", outcomeFinalizedAt: deadline }] }, deadline), true);
});
