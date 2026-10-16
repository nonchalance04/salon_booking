import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { validateRequest } from "../../shared/http.js";
import { browserSecurity, type AuthConfig } from "../auth/auth.security.js";
import { createAuthMiddleware } from "../auth/auth.middleware.js";
import { booking, outcomesSchema, revision, settlementSchema } from "./settlement.schema.js";
import { createSettlementService } from "./settlement.service.js";
export function createSettlementRouter(prisma: PrismaClient, config: AuthConfig) {
  const router = Router(); const service = createSettlementService(prisma); const auth = createAuthMiddleware(prisma, config);
  router.use("/settlement", browserSecurity(config.TRUSTED_ORIGINS), auth.authenticate, (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.post("/settlement/lookup", validateRequest(z.object({ body: booking })), async (_req, res) => res.json({ appointment: await service.lookup(res.locals.user.id, res.locals.validated.body.bookingCode) }));
  router.post("/settlement/outcomes", validateRequest(z.object({ body: outcomesSchema })), async (_req, res) => res.json({ appointment: await service.outcomes(res.locals.user.id, res.locals.validated.body) }));
  router.post("/settlement/pay", validateRequest(z.object({ body: settlementSchema })), async (_req, res) => res.json({ appointment: await service.settle(res.locals.user.id, res.locals.validated.body) }));
  router.post("/settlement/close", auth.adminOnly, validateRequest(z.object({ body: revision.strict() })), async (_req, res) => res.json({ appointment: await service.close(res.locals.user.id, res.locals.validated.body) }));
  return router;
}
