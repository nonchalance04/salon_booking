import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaymentKey } from "../src/payment-key.ts";

test("payment keys remain valid and distinct without crypto.randomUUID on HTTP origins", () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const keys = Array.from({ length: 1000 }, () => createPaymentKey());
    for (const key of keys) {
      assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.equal(new Set(keys).size, keys.length);
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});
