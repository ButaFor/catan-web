import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/auth.routes.js";
import { AuthenticationError } from "../auth/auth.errors.js";
import { AuthService } from "../auth/auth.service.js";
import { RoomService } from "./room.service.js";
import { AuthRateLimiter } from "../auth/auth.rate-limit.js";
import type { AuthConfig } from "../config/types.js";

const roomIdParams = z.object({ roomId: z.string().uuid() });
const createRoomBody = z.object({
  name: z.string().trim().min(1).max(50),
  capacity: z.number().int().min(3).max(4).default(4),
});
const readyBody = z.object({ ready: z.boolean() });
const updateRulesBody = z.object({
  expectedVersion: z.number().int().positive(),
  rulesVersion: z.number().int().positive(),
  rules: z.record(z.string(), z.never()),
});
const transferHostBody = z.object({ nextHostUserId: z.string().min(1) });

export async function registerRoomRoutes(
  app: FastifyInstance,
  roomService: RoomService,
  authService: AuthService,
  config: AuthConfig,
): Promise<void> {
  const rateLimiter = new AuthRateLimiter(
    config.rateLimitMax,
    config.rateLimitWindowSeconds * 1000,
  );
  const rateLimit = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
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
    },
  };

  app.post("/rooms", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const input = createRoomBody.parse(request.body);
    const details = await roomService.create(
      authenticated,
      input.name,
      input.capacity,
    );
    return reply.code(201).send(toRoomResponse(details));
  });

  app.get("/rooms/:roomId", rateLimit, async (request, reply) => {
    await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const details = await roomService.details(roomId);
    return reply.send(toRoomResponse(details));
  });

  app.post("/rooms/:roomId/join", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const details = await roomService.join(authenticated, roomId);
    return reply.send(toRoomResponse(details));
  });

  app.post("/rooms/:roomId/leave", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    await roomService.leave(authenticated, roomId);
    return reply.code(204).send();
  });

  app.post("/rooms/:roomId/ready", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const { ready } = readyBody.parse(request.body);
    const details = await roomService.setReady(
      authenticated,
      roomId,
      ready,
    );
    return reply.send(toRoomResponse(details));
  });

  app.put("/rooms/:roomId/rules", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const input = updateRulesBody.parse(request.body);
    const details = await roomService.updateRules(
      authenticated,
      roomId,
      input.expectedVersion,
      { rulesVersion: input.rulesVersion, rules: {} },
    );
    return reply.send(toRoomResponse(details));
  });

  app.post("/rooms/:roomId/host", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const { nextHostUserId } = transferHostBody.parse(request.body);
    const details = await roomService.transferHost(
      authenticated,
      roomId,
      nextHostUserId,
    );
    return reply.send(toRoomResponse(details));
  });

  app.post("/rooms/:roomId/close", rateLimit, async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    await roomService.close(authenticated, roomId);
    return reply.code(204).send();
  });
}

async function requireAuthentication(
  request: FastifyRequest,
  authService: AuthService,
) {
  const authenticated = await authenticateRequest(request, authService);
  if (!authenticated) throw new AuthenticationError();
  return authenticated;
}

function toRoomResponse(details: Awaited<ReturnType<RoomService["details"]>>) {
  return {
    id: details.room.id,
    code: details.room.code,
    name: details.room.name,
    hostUserId: details.room.hostUserId,
    status: details.room.status,
    capacity: details.room.capacity,
    version: details.room.version,
    currentRules: details.room.currentRules,
    createdAt: details.room.createdAt,
    members: details.members,
  };
}
