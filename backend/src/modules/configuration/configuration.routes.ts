import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { validateRequest } from "../../shared/http.js";
import { createAuthMiddleware } from "../auth/auth.middleware.js";
import { browserSecurity, type AuthConfig } from "../auth/auth.security.js";
import { createConfigurationService } from "./configuration.service.js";
import { staffSkillsSchema, staffPublicProfileSchema, profileSchema, serviceSchema, staffSchema, staffUpdateSchema, qualificationSchema, hoursSchema, scheduleSchema, closureSchema, unavailabilitySchema, policySchema, recordId } from "./configuration.schema.js";

export function createConfigurationRouter(prisma: PrismaClient, config: AuthConfig) {
  const router = Router();
  const service = createConfigurationService(prisma, config.SALON_TIMEZONE);
  const { authenticate, adminOnly } = createAuthMiddleware(prisma, config);
  router.get("/salon", async (_req, res) => res.json(await service.publicSalon()));
  router.get("/services", async (_req, res) => res.json({ services: await service.publicServices() }));
  router.use("/configuration", browserSecurity(config.TRUSTED_ORIGINS), authenticate, adminOnly);
  router.get("/configuration", async (_req, res) => res.json(await service.snapshot()));
  router.put("/configuration/profile", validateRequest(z.object({ body: profileSchema })), async (_req, res) => {
    res.json({ record: await service.saveProfile(res.locals.user.id, res.locals.validated.body) });
  });
  // This is only route registration for this feature; the distinct services
  // above retain their own domain validation and locking responsibilities.
  function register<T>(path: string, schema: z.ZodType<T>, save: (actorId: string, input: T, id?: string) => Promise<unknown>, updateSchema: z.ZodType<T> = schema) {
    router.post(`/configuration/${path}`, validateRequest(z.object({ body: schema })), async (_req, res) => {
      res.status(201).json({ record: await save(res.locals.user.id, res.locals.validated.body) });
    });
    router.put(`/configuration/${path}/:id`, validateRequest(z.object({ params: recordId, body: updateSchema })), async (_req, res) => {
      res.json({ record: await save(res.locals.user.id, res.locals.validated.body, res.locals.validated.params.id) });
    });
  }
  register("services", serviceSchema, service.saveService);
  register("staff", staffSchema, service.saveStaff, staffUpdateSchema);
  router.delete("/configuration/staff/:id", validateRequest(z.object({ params: recordId })), async (_req, res) => {
    await service.removeStaff(res.locals.user.id, res.locals.validated.params.id); res.status(204).end();
  });
  router.put("/configuration/staff/:id/skills", validateRequest(z.object({ params: recordId, body: staffSkillsSchema })), async (_req, res) => {
    res.json({ qualifications: await service.saveStaffSkills(res.locals.user.id, res.locals.validated.params.id, res.locals.validated.body) });
  });
  router.put("/configuration/staff/:id/profile", validateRequest(z.object({ params: recordId, body: staffPublicProfileSchema })), async (_req, res) => {
    res.json({ record: await service.saveStaffPublicProfile(res.locals.user.id, res.locals.validated.params.id, res.locals.validated.body) });
  });
  register("qualifications", qualificationSchema, service.saveQualification);
  register("hours", hoursSchema, service.saveHours);
  register("schedules", scheduleSchema, service.saveSchedule);
  register("closures", closureSchema, service.saveClosure);
  register("unavailability", unavailabilitySchema, service.saveUnavailability);
  router.post("/configuration/policies", validateRequest(z.object({ body: policySchema })), async (_req, res) => {
    res.status(201).json({ record: await service.createPolicy(res.locals.user.id, res.locals.validated.body) });
  });
  router.delete("/configuration/closures/:id", validateRequest(z.object({ params: recordId })), async (_req, res) => {
    await service.removeClosure(res.locals.user.id, res.locals.validated.params.id); res.status(204).end();
  });
  router.delete("/configuration/unavailability/:id", validateRequest(z.object({ params: recordId })), async (_req, res) => {
    await service.removeUnavailability(res.locals.user.id, res.locals.validated.params.id); res.status(204).end();
  });
  return router;
}
