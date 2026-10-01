import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthRateLimiter } from "../../auth/auth.rate-limit.js";
import type { AuthConfig } from "../../config/types.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  config: AuthConfig,
): void {
  const rateLimiter = new AuthRateLimiter(
    config.rateLimitMax,
    config.rateLimitWindowSeconds * 1000,
  );
  app.get(
    "/health",
    { preHandler: rateLimitRequest(rateLimiter) },
    async () => ({ status: "ok" }),
  );
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
