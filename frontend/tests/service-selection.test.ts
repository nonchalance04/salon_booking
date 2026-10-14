import assert from "node:assert/strict";
import { test } from "node:test";
import { selectService } from "../src/service-selection.ts";

const brazilian = { id: "brazilian", category: "Hair" };
const haircut = { id: "haircut", category: " Hair " };
const manicure = { id: "manicure", category: "Nails" };
const catalog = [brazilian, haircut, manicure];

test("haircut, color and treatment coexist; changing a color variant only replaces color", () => {
  const cut = { id: "cut", category: "Hair Services" };
  const color = { id: "short", category: "Hair Color & Styling" };
  const long = { id: "long", category: " hair color & styling " };
  const treatment = { id: "treatment", category: "Hair Treatments" };
  const services = [cut, color, long, treatment];
  let rows = selectService([], cut, services, 1);
  rows = selectService(rows, color, services, 2);
  rows = selectService(rows, treatment, services, 3);
  rows = rows.map(row => ({ ...row, staffId: "stylist" }));
  assert.equal(rows.length, 3);
  assert.deepEqual(selectService(rows, long, services, 4), [
    rows[0], { key: 4, serviceId: "long", staffId: "" }, rows[2],
  ]);
});

test("clicking Brazilian three times selects it only once", () => {
  let rows = selectService([], brazilian, catalog, 1);
  rows = selectService(rows, brazilian, catalog, 2);
  rows = selectService(rows, brazilian, catalog, 3);
  assert.deepEqual(rows, [{ key: 1, serviceId: "brazilian", staffId: "" }]);
});

test("hair and nails coexist; replacing hair clears only its professional", () => {
  const rows = [
    { key: 1, serviceId: "brazilian", staffId: "hair-stylist" },
    { key: 2, serviceId: "manicure", staffId: "nail-technician" },
  ];
  assert.equal(selectService(rows, brazilian, catalog, 3), rows);
  assert.deepEqual(selectService(rows, haircut, catalog, 4), [
    { key: 4, serviceId: "haircut", staffId: "" }, rows[1],
  ]);
  assert.deepEqual(selectService([rows[0]], manicure, catalog, 2), [rows[0], { key: 2, serviceId: "manicure", staffId: "" }]);
});

test("removing a category lets the customer select it again", () => {
  const rows = selectService([], brazilian, catalog, 1);
  const remaining = rows.filter(row => row.serviceId !== brazilian.id);
  assert.deepEqual(selectService(remaining, haircut, catalog, 2), [{ key: 2, serviceId: "haircut", staffId: "" }]);
});
