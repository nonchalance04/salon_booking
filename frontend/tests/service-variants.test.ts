import assert from "node:assert/strict";
import { test } from "node:test";
import { groupServiceVariants } from "../src/service-variants.ts";
import { selectService } from "../src/service-selection.ts";

test("haircut choices retain their exact catalog price, duration and ID in menu order", () => {
  const standard = { id: "cut", name: "Ladies Haircut", category: "Hair", price: "120.00", durationMinutes: 30 };
  const blowdry = { ...standard, id: "dry", name: "Ladies Haircut w/ Blowdry", price: "170.00", durationMinutes: 45 };
  const shampoo = { ...standard, id: "wash", name: "Ladies Haircut w/ Shampoo & Conditioner + Blowdry", price: "220.00", durationMinutes: 60 };
  const catalog = [shampoo, blowdry, standard];
  const groups = groupServiceVariants(catalog);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Ladies Haircut");
  assert.deepEqual(groups[0].options.map(option => option.service), [standard, blowdry, shampoo]);
  assert.equal(groups[0].options[2].label, "With shampoo & conditioner + blowdry");
  const rows = selectService([{ key: 1, serviceId: "cut", staffId: "stylist" }], groups[0].options[2].service, catalog, 2);
  assert.deepEqual(rows, [{ key: 2, serviceId: "wash", staffId: "" }]);
});

test("color packages and foot spa variants group without merging unrelated services", () => {
  const names = ["Hair Color (Long)", "Hair Color (Short)", "Hair Color (Medium)", "Highlights & Color", "Rebonding with Color & Brazilian", "Rebonding", "Rebond with Color", "Rebonding with Color & Keratin", "Brazilian", "Foot Spa with Pedicure", "Foot Spa", "Pedicure"];
  const services = names.map((name, i) => ({ id: String(i), name }));
  const groups = groupServiceVariants(services);
  assert.deepEqual(groups.map(group => [group.name, group.options.length]), [
    ["Hair Color", 3], ["Highlights & Color", 1], ["Rebonding", 4], ["Brazilian", 1], ["Foot Spa", 2], ["Pedicure", 1],
  ]);
  assert.deepEqual(groups.flatMap(group => group.options.map(option => option.service.id)).sort(), services.map(service => service.id).sort());
});

test("unavailable variants are not invented and new catalog services remain selectable", () => {
  const catalog = [{ id: "dry", name: "Kids Haircut w/ Blowdry" }, { id: "custom", name: "New treatment" }];
  const groups = groupServiceVariants(catalog);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flatMap(group => group.options.map(option => option.service)), catalog);
});
