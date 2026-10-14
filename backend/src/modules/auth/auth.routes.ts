import { createAuthMiddleware } from "./auth.middleware.js";
import { Router } from "express";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { validateRequest } from "../../shared/http.js";
import { createTokenService } from "./auth.token.js";
import { createAuthService } from "./auth.service.js";
import { createUsersService } from "../users/users.service.js";
import {
  loginSchema,
  createAccountSchema,
  updateAccountSchema,
} from "./auth.schema.js";
import {
  browserSecurity,
  COOKIE_NAME,
  cookieOptions,
  type AuthConfig,
} from "./auth.security.js";

export function createAuthRouter(prisma: PrismaClient, config: AuthConfig) {
  const router = Router();
  const service = createAuthService(prisma);
  const users = createUsersService(prisma);
  const tokens = createTokenService(config.JWT_SECRET);
  const cookie = cookieOptions(config);
  // Scoped to browser-authenticated modules; future provider callbacks have a separate boundary.
  router.use(["/auth", "/users"], browserSecurity(config.TRUSTED_ORIGINS));
  const { authenticate, adminOnly } = createAuthMiddleware(prisma, config);
  router.post(
    "/auth/login",
    validateRequest(loginSchema),
    async (_req, res) => {
      const { email, password } = res.locals.validated.body;
      const user = await service.login(email, password);
      res.cookie(
        COOKIE_NAME,
        await tokens.sign({ userId: user.id, role: user.role }),
        { ...cookie, maxAge: 8 * 60 * 60 * 1000 },
      );
      res.json({ user });
    },
  );
  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, cookie);
    res.status(204).end();
  });
  router.get("/auth/me", authenticate, (_req, res) =>
    res.json({ user: res.locals.user }),
  );
  router.get("/users", authenticate, adminOnly, async (_req, res) =>
    res.json({ users: await users.list(res.locals.user.id) }),
  );
  router.post(
    "/users",
    authenticate,
    adminOnly,
    validateRequest(createAccountSchema),
    async (_req, res) => {
      res
        .status(201)
        .json({
          user: await users.save(res.locals.user.id, res.locals.validated.body),
        });
    },
  );
  router.patch(
    "/users/:id",
    authenticate,
    adminOnly,
    validateRequest(updateAccountSchema),
    async (_req, res) => {
      res.json({
        user: await users.save(
          res.locals.user.id,
          res.locals.validated.body,
          res.locals.validated.params.id,
        ),
      });
    },
  );
  return router;
}
