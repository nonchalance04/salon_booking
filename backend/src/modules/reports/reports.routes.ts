import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { validateRequest } from "../../shared/http.js";
import { createAuthMiddleware } from "../auth/auth.middleware.js";
import { browserSecurity, type AuthConfig } from "../auth/auth.security.js";
import { confirmedServicesQuery, reportKinds, reportQuery } from "./reports.schema.js";
import { createReportsService } from "./reports.service.js";
export function createReportsRouter(prisma: PrismaClient, config: AuthConfig) {
  const router = Router(); const auth = createAuthMiddleware(prisma, config);
  const service = createReportsService(prisma, config.SALON_TIMEZONE);
  router.use("/reports", browserSecurity(config.TRUSTED_ORIGINS), auth.authenticate);
  router.get("/reports/collections", validateRequest(z.object({ query: reportQuery })), async (_req, res) => res.json(await service.collections(res.locals.user.id, res.locals.validated.query)));
  router.get("/reports/cashier-queue", validateRequest(z.object({ query: reportQuery })), async (_req, res) => res.json(await service.cashierQueue(res.locals.user.id, res.locals.validated.query)));
  router.get("/reports/waiting-queue", validateRequest(z.object({ query: confirmedServicesQuery })), async (_req, res) => res.json(await service.waitingQueue(res.locals.user.id, res.locals.validated.query)));
  router.get("/reports/confirmed-services", validateRequest(z.object({ query: confirmedServicesQuery })), async (_req, res) => res.json(await service.confirmedServices(res.locals.user.id, res.locals.validated.query)));
  router.get("/reports/dashboard", auth.adminOnly, validateRequest(z.object({ query: reportQuery })), async (_req, res) => res.json(await service.dashboard(res.locals.user.id, res.locals.validated.query)));
  router.get("/reports/:kind", auth.adminOnly, validateRequest(z.object({ params: z.object({ kind: z.enum(reportKinds) }), query: reportQuery })), async (_req, res) => res.json(await service.list(res.locals.user.id, res.locals.validated.params.kind, res.locals.validated.query)));
  return router;
}
