import { GUEST_SESSION_COOKIE, guestSessionCredentials } from "../appointments/appointment-otp.routes.js";
import { GUEST_SESSION_MS } from "../appointments/appointment-otp.service.js";
import { Router, type Request } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { validateRequest } from "../../shared/http.js";
import { browserSecurity, cookieOptions, type AuthConfig } from "../auth/auth.security.js";
import { createAuthMiddleware } from "../auth/auth.middleware.js";
import { configuredPaymentProvider } from "./provider-config.js";
import type { PaymentProvider } from "./payment-provider.js";
import { guestAccessSchema } from "../appointments/appointments.schema.js";
import { createPaymentsService } from "./payments.service.js";
import { checkoutSchema, listSchema, manualPaymentSchema, receiptSchema, testCaptureSchema } from "./payments.schema.js";

export function createPaymentsRouter(prisma: PrismaClient, config: AuthConfig, provider: PaymentProvider | undefined = configuredPaymentProvider(config)) {
  const router = Router();
  const service = createPaymentsService(prisma, provider, config.SALON_TIMEZONE);
  const auth = createAuthMiddleware(prisma, config);
  router.use("/payments", (_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next(); });
  // This endpoint authenticates the provider signature, never a browser cookie.
  router.post("/payments/provider/events", async (req, res) => {
    await service.providerEvent((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0), req.get(provider?.name === "paymongo" ? "paymongo-signature" : "x-payment-signature"));
    res.json({ received: true });
  });
  router.use("/payments", browserSecurity(config.TRUSTED_ORIGINS));
  router.get("/payments/options", (_req, res) => res.json({ onlineAvailable: Boolean(provider), testMode: provider?.name === "test", provider: provider?.name ?? null, sandbox: provider?.name === "paymongo" && config.NODE_ENV !== "production" }));
  router.post("/payments/status", guestSessionCredentials(prisma), validateRequest(z.object({ body: guestAccessSchema.extend({ paymentId: z.uuid() }).strict() })), async (_req, res) => {
    const { bookingCode, token, paymentId } = res.locals.validated.body;
    res.json({ payment: await service.refresh(bookingCode, token, paymentId) });
  });
  router.post("/payments/customer-receipt", guestSessionCredentials(prisma), validateRequest(z.object({ body: guestAccessSchema.extend({ paymentId: z.uuid() }).strict() })), async (_req, res) => {
    const { bookingCode, token, paymentId } = res.locals.validated.body;
    res.json({ payment: await service.customerReceipt(bookingCode, token, paymentId) });
  });
  router.post("/payments/recover-checkout", auth.authenticate, auth.adminOnly, validateRequest(z.object({ body: z.object({ paymentId: z.uuid(), checkoutReference: z.string().regex(/^cs_[A-Za-z0-9]+$/) }).strict() })), async (_req, res) => {
    res.json({ payment: await service.recoverCheckout(res.locals.user.id, res.locals.validated.body.paymentId, res.locals.validated.body.checkoutReference) });
  });
  router.post("/payments/checkout", guestSessionCredentials(prisma), validateRequest(z.object({ body: checkoutSchema })), async (_req, res) => {
    const { bookingCode, token, idempotencyKey } = res.locals.validated.body;
    const checkout = await service.checkout(bookingCode, token, idempotencyKey);
    // Establish access before leaving for checkout, without exposing the private
    // booking token to PayMongo, browser storage, or the return URL.
    if (provider?.name === "paymongo") {
      const session = await service.returnSession(bookingCode, token);
      res.cookie(GUEST_SESSION_COOKIE, session, { ...cookieOptions(config), maxAge: GUEST_SESSION_MS });
    }
    res.json(checkout);
  });
  router.post("/payments/test-capture", guestSessionCredentials(prisma), validateRequest(z.object({ body: testCaptureSchema })), async (_req, res) => {
    const { bookingCode, token, paymentId, outcome } = res.locals.validated.body;
    res.json({ payment: await service.simulate(bookingCode, token, paymentId, outcome) });
  });
  router.post("/payments/manual", auth.authenticate, validateRequest(z.object({ body: manualPaymentSchema })), async (_req, res) => {
    res.json({ payment: await service.manual(res.locals.user.id, res.locals.validated.body) });
  });
  router.post("/payments/lookup", auth.authenticate, validateRequest(z.object({ body: z.object({ bookingCode: z.string().min(1).max(100) }).strict() })), async (_req, res) => {
    res.json({ appointment: await service.lookup(res.locals.user.id, res.locals.validated.body.bookingCode) });
  });
  router.post("/payments/receipts", auth.authenticate, validateRequest(z.object({ body: receiptSchema })), async (_req, res) => {
    res.json({ payment: await service.issueReceipt(res.locals.user.id, res.locals.validated.body.paymentId) });
  });
  router.get("/payments", auth.authenticate, auth.adminOnly, validateRequest(z.object({ query: listSchema })), async (_req, res) => {
    const { cursor, reconciliationOnly } = res.locals.validated.query;
    res.json(await service.list(res.locals.user.id, cursor, reconciliationOnly === "true"));
  });
  return router;
}
