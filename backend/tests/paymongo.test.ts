import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PayMongoProvider, centavos } from "../src/modules/payments/paymongo-provider.js";
import { parseEnv } from "../src/config/env.schema.js";
const config = { secretKey: "sk_test_dummy", webhookSecret: "whsk_test_secret_for_tests", returnUrl: "https://salon.test/booking-confirmed" };
const paymentId = randomUUID(), appointmentId = randomUUID();
function session(paid = false) { return { data: { id: "cs_test123", type: "checkout_session", attributes: {
  livemode: false, reference_number: paymentId, metadata: { paymentId, appointmentId }, status: paid ? "active" : "active",
  checkout_url: "https://checkout.paymongo.com/test123", line_items: [{ amount: 10000, currency: "PHP", quantity: 1 }],
  payments: paid ? [{ id: "pay_test123", type: "payment", attributes: { amount: 10000, currency: "PHP", status: "paid", livemode: false, source: { type: "gcash" }, paid_at: 1791000000 } }] : [],
} } }; }
function signed(type = "checkout_session.payment.paid", timestamp = Math.floor(Date.now() / 1000), live = false) {
  const raw = Buffer.from(JSON.stringify({ data: { id: "evt_test", type: "event", attributes: { type, livemode: live, data: { id: "cs_test123", type: "checkout_session" } } } }));
  const signature = createHmac("sha256", config.webhookSecret).update(`${timestamp}.`).update(raw).digest("hex");
  return { raw, header: `t=${timestamp},te=${signature},li=` };
}
test("PayMongo creates GCash-only V2 checkout with exact centavos, private-free metadata and trusted return URL", async () => {
  let calls = 0;
  const provider = new PayMongoProvider(config, (async (url, init) => {
    calls++; assert.equal(url, "https://api.paymongo.com/v2/checkout_sessions"); assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string,string>).Authorization, `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`);
    const attr = JSON.parse(init!.body as string).data.attributes;
    assert.deepEqual(attr.payment_method_types, ["gcash"]); assert.equal(attr.line_items[0].amount, 10000);
    assert.equal(attr.reference_number, paymentId); assert.deepEqual(attr.metadata, { paymentId, appointmentId });
    assert.equal(attr.success_url, config.returnUrl); assert.equal(attr.cancel_url, config.returnUrl);
    assert.equal(attr.pass_on_fees, undefined); assert.equal(attr.expires_at, undefined);
    // Actual V2 creation summary omits metadata, line items, status and payments.
    return Response.json({ data: { id: "cs_test123", type: "checkout_session", attributes: {
      livemode: false, checkout_url: "https://checkout.paymongo.com/test123", created_at: 1791000000, updated_at: 1791000000,
    } } });
  }) as typeof fetch);
  const result = await provider.createPayment({ paymentId, appointmentId, amount: "100.00", currency: "PHP", expiresAt: new Date(Date.now() + 60_000) });
  assert.equal(result.reference, "cs_test123"); assert.equal(calls, 1);
  assert.equal(centavos("9999999999.99"), 999999999999); assert.throws(() => centavos("100.001"));
});
test("PayMongo creation rejects missing identity, wrong mode and unsafe URLs without requiring full session attributes", async () => {
  for (const data of [
    { id: "pay_wrong", type: "checkout_session", attributes: { livemode: false, checkout_url: "https://checkout.paymongo.com/test" } },
    { id: "cs_test", type: "checkout_session", attributes: { livemode: true, checkout_url: "https://checkout.paymongo.com/test" } },
    { id: "cs_test", type: "checkout_session", attributes: { livemode: false, checkout_url: "not-a-url" } },
    { id: "cs_test", type: "checkout_session", attributes: { livemode: false, checkout_url: "https://evil.test/test" } },
  ]) {
    const provider = new PayMongoProvider(config, (async () => Response.json({ data })) as typeof fetch);
    await assert.rejects(provider.createPayment({ paymentId, appointmentId, amount: "100.00", currency: "PHP", expiresAt: new Date(Date.now()+60000) }));
  }
});
test("PayMongo verifies raw signed events and retrieves merchant capture instead of trusting redirects or callback fields", async () => {
  let calls = 0;
  const provider = new PayMongoProvider(config, (async url => { calls++; assert.equal(url, "https://api.paymongo.com/v1/checkout_sessions/cs_test123"); return Response.json(session(true)); }) as typeof fetch);
  const event = signed(); const result = await provider.verifyPayment(event.raw, event.header);
  assert.equal(result?.status, "SUCCEEDED"); assert.equal(result?.reference, "pay_test123"); assert.equal(result?.checkoutReference, "cs_test123"); assert.equal(result?.amount, "100.00");
  assert.equal(calls, 1);
  for (const [body, header] of [[event.raw, undefined], [event.raw, event.header.replace("te=", "li=")], [Buffer.from(event.raw.toString()+" "), event.header], [signed("checkout_session.payment.paid", 1000000000).raw, signed("checkout_session.payment.paid", 1000000000).header]]) {
    await assert.rejects(provider.verifyPayment(body as Buffer, header as string | undefined));
  }
  assert.equal(calls, 1);
  const unrelated = signed("payment.refunded"); assert.equal(await provider.verifyPayment(unrelated.raw, unrelated.header), null);
  const wrongMode = signed("checkout_session.payment.paid", undefined, true); await assert.rejects(provider.verifyPayment(wrongMode.raw, wrongMode.header));
});
test("PayMongo rejects mismatched mode, amounts, payment methods, untrusted checkout URLs and malformed upstream responses", async () => {
  for (const mutate of [
    (s: ReturnType<typeof session>) => { s.data.attributes.livemode = true; },
    (s: ReturnType<typeof session>) => { s.data.attributes.payments[0]!.attributes.amount = 1; },
    (s: ReturnType<typeof session>) => { s.data.attributes.payments[0]!.attributes.source.type = "card"; },
    (s: ReturnType<typeof session>) => { s.data.attributes.reference_number = randomUUID(); },
  ]) {
    const data = session(true); mutate(data);
    const provider = new PayMongoProvider(config, (async () => Response.json(data)) as typeof fetch);
    await assert.rejects(provider.getPaymentStatus("cs_test123"));
  }
  const data = session(); data.data.attributes.checkout_url = "https://malicious.test/";
  const provider = new PayMongoProvider(config, (async () => Response.json(data)) as typeof fetch);
  await assert.rejects(provider.createPayment({ paymentId, appointmentId, amount: "100.00", currency: "PHP", expiresAt: new Date(Date.now()+60000) }));
  const down = new PayMongoProvider(config, (async () => new Response('secret provider payload', { status: 500 })) as typeof fetch);
  await assert.rejects(down.getPaymentStatus("cs_test123"), (e: Error) => !e.message.includes("secret"));
});
test("PayMongo validates environment mode and trusted callback destination without exposing secrets", () => {
  const base = { DATABASE_URL: "postgresql://test@localhost/test", JWT_SECRET: "x".repeat(32), PAYMENT_PROVIDER: "paymongo", PAYMONGO_SECRET_KEY: config.secretKey,
    PAYMONGO_WEBHOOK_SECRET: config.webhookSecret, PAYMONGO_RETURN_URL: config.returnUrl, TRUSTED_ORIGINS: "https://salon.test" };
  assert.equal(parseEnv(base).PAYMENT_PROVIDER, "paymongo");
  assert.equal(parseEnv({ ...base, PAYMONGO_RETURN_URL: "https://salon.test/appointment" }).PAYMENT_PROVIDER, "paymongo");
  for (const returnUrl of ["https://salon.test/booking-confirmed?token=secret", "https://salon.test/booking-confirmed#secret", "https://evil.test/booking-confirmed", "https://salon.test/other-page"]) {
    assert.throws(() => parseEnv({ ...base, PAYMONGO_RETURN_URL: returnUrl }));
  }
  for (const changes of [{ PAYMONGO_WEBHOOK_SECRET: "" }, { NODE_ENV: "production" }, { PAYMONGO_SECRET_KEY: "sk_live_dummy" }, { PAYMONGO_RETURN_URL: "https://evil.test/appointment" }, { PAYMONGO_RETURN_URL: "https://salon.test/appointment?token=secret" }]) assert.throws(() => parseEnv({ ...base, ...changes }));
  assert.equal(parseEnv({ ...base, NODE_ENV: "production", PAYMONGO_SECRET_KEY: "sk_live_dummy" }).PAYMENT_PROVIDER, "paymongo");
});
test("PayMongo expiry uses the documented session endpoint and unpaid sessions never become captures", async () => {
  const provider = new PayMongoProvider(config, (async (url, init) => {
    if (init?.method === "POST") assert.equal(url, "https://api.paymongo.com/v1/checkout_sessions/cs_test123/expire");
    const data = session(); data.data.attributes.status = "expired"; return Response.json(data);
  }) as typeof fetch);
  await provider.expirePayment("cs_test123"); assert.equal((await provider.getPaymentStatus("cs_test123")).status, "EXPIRED");
});
