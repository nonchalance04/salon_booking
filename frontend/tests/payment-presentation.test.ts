import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentStatusLabel, visibleReportEntries } from "../src/payment-presentation.ts";

test("legacy payment statuses use a readable label without changing transaction state", () => {
  assert.equal(paymentStatusLabel("REFUNDED"), "Returned payment");
  for (const status of ["PENDING", "SUCCEEDED", "FAILED", "EXPIRED"]) {
    assert.equal(paymentStatusLabel(status), status);
  }
});

test("reports omit unsupported fields while retaining exact collection amounts and history", () => {
  const row = { captured: "100.00", refunded: "20.00", refundedAt: "2026-10-16T00:00:00Z", netCashMovement: "80.00", status: "REFUNDED" };
  assert.deepEqual(Object.fromEntries(visibleReportEntries(row)), {
    captured: "100.00", netCashMovement: "80.00", status: "REFUNDED",
  });
  assert.equal(row.refunded, "20.00");
});
