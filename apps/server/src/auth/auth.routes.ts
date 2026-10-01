import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  AuthenticationError,
  InvalidCredentialsError,
  UsernameTakenError,
} from "./auth.errors.js";
import {
  createGuestSchema,
  googleCallbackSchema,
  loginSchema,
  registerSchema,
  userResponseSchema,
} from "./auth.schemas.js";
import { AuthService } from "./auth.service.js";
import { GoogleOAuthService } from "./oauth/google.service.js";
import type { AuthConfig } from "../config/types.js";
import { AuthRateLimiter } from "./auth.rate-limit.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  googleOAuth: GoogleOAuthService,
  config: AuthConfig,
): Promise<void> {
  const rateLimiter = new AuthRateLimiter(
    config.rateLimitMax,
    config.rateLimitWindowSeconds * 1000,
  );
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.secureCookies,
    path: "/",
  };
  const oauthCookieOptions = {
    ...cookieOptions,
    maxAge: config.oauthStateTtlSeconds,
  };

  app.post(
    "/auth/guest",
    { preHandler: rateLimitRequest(rateLimiter) },
    async (request, reply) => {
      createGuestSchema.parse(request.body ?? {});
      const { user, token } = await authService.createGuest();

      reply.setCookie(authService.sessionCookie, token, cookieOptions);
      return reply
        .code(201)
        .send(userResponseSchema.parse(toUserResponse(user)));
    },
  );

  app.post(
    "/auth/register",
    { preHandler: rateLimitRequest(rateLimiter) },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const { user, token } = await authService.register(
        input.username,
        input.password,
      );
      reply.setCookie(authService.sessionCookie, token, cookieOptions);
      return reply
        .code(201)
        .send(userResponseSchema.parse(toUserResponse(user)));
    },
  );

  app.post(
    "/auth/login",
    { preHandler: rateLimitRequest(rateLimiter) },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const { user, token } = await authService.login(
        input.username,
        input.password,
      );
      reply.setCookie(authService.sessionCookie, token, cookieOptions);
      return reply.send(userResponseSchema.parse(toUserResponse(user)));
    },
  );

  app.get("/auth/me", async (request, reply) => {
    const authenticated = await authenticateRequest(request, authService);
    if (!authenticated) {
      throw new AuthenticationError();
    }

    return userResponseSchema.parse(toUserResponse(authenticated.user));
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[authService.sessionCookie];
    if (token) {
      await authService.revoke(token);
    }

    reply.clearCookie(authService.sessionCookie, cookieOptions);
    return reply.code(204).send();
  });

  app.get(
    "/auth/google",
    { preHandler: rateLimitRequest(rateLimiter) },
    async (_request, reply) => {
      const authorization = googleOAuth.createAuthorization();
      reply
        .setCookie(
          "google_oauth_state",
          authorization.state,
          oauthCookieOptions,
        )
        .setCookie(
          "google_oauth_verifier",
          authorization.verifier,
          oauthCookieOptions,
        );
      return reply.redirect(authorization.url);
    },
  );

  app.get(
    "/auth/google/callback",
    { preHandler: rateLimitRequest(rateLimiter) },
    async (request, reply) => {
      const query = googleCallbackSchema.parse(request.query);
      if (query.error) {
        return reply.code(400).send({
          code: "GOOGLE_AUTHORIZATION_DENIED",
          message: "Google authorization was denied",
        });
      }

      if (!query.code) {
        return reply.code(400).send({
          code: "MISSING_GOOGLE_CODE",
          message: "Google authorization code is missing",
        });
      }

      const expectedState = request.cookies.google_oauth_state;
      const verifier = request.cookies.google_oauth_verifier;
      if (
        !expectedState ||
        !verifier ||
        !GoogleOAuthService.verifyState(expectedState, query.state)
      ) {
        return reply.code(400).send({
          code: "INVALID_OAUTH_STATE",
          message: "OAuth state is invalid or expired",
        });
      }

      const { token, user } = await googleOAuth.completeAuthorization(
        query.code,
        verifier,
      );
      reply
        .setCookie(authService.sessionCookie, token, cookieOptions)
        .clearCookie("google_oauth_state", cookieOptions)
        .clearCookie("google_oauth_verifier", cookieOptions);
      return reply.send(toUserResponse(user));
  });
}

function rateLimitRequest(rateLimiter: AuthRateLimiter) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = rateLimiter.consume(
      `${request.ip}:${request.routeOptions.url}`,
    );
    reply.header("X-RateLimit-Limit", rateLimiter.limit);
    reply.header("X-RateLimit-Remaining", result.remaining);
    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfterSeconds);
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "Too many requests",
      });
    }
  };
}

export async function authenticateRequest(
  request: FastifyRequest,
  authService: AuthService,
) {
  const token = request.cookies[authService.sessionCookie];
  return token ? authService.authenticate(token) : undefined;
}

function toUserResponse(user: {
  id: string;
  displayName: string;
  isGuest: boolean;
  createdAt: string;
  email?: string;
  avatarUrl?: string;
  username?: string;
}) {
  return {
    id: user.id,
    displayName: user.displayName,
    isGuest: user.isGuest,
    createdAt: user.createdAt,
    ...(user.email ? { email: user.email } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.username ? { username: user.username } : {}),
  };
}

export const authErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
