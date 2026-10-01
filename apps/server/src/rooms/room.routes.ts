import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/auth.routes.js";
import { AuthenticationError } from "../auth/auth.errors.js";
import { AuthService } from "../auth/auth.service.js";
import { RoomService } from "./room.service.js";
import { toRoomResponse } from "./room.serializer.js";
import { ROOM_RULES_VERSION } from "./room.rules.codec.js";

const roomIdParams = z.object({ roomId: z.string().uuid() });
const createRoomBody = z.object({
  name: z.string().trim().min(1).max(50),
  capacity: z.number().int().min(3).max(4).default(4),
});
const readyBody = z.object({ ready: z.boolean() });
const updateRulesBody = z.object({
  expectedVersion: z.number().int().positive(),
  rulesVersion: z.literal(ROOM_RULES_VERSION),
  rules: z.record(z.string(), z.never()),
});
const transferHostBody = z.object({ nextHostUserId: z.string().uuid() });

export async function registerRoomRoutes(
  app: FastifyInstance,
  roomService: RoomService,
  authService: AuthService,
): Promise<void> {
  app.post(
    "/rooms",
    async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const input = createRoomBody.parse(request.body);
    const details = await roomService.create(
      authenticated,
      input.name,
      input.capacity,
    );
    return reply.code(201).send(toRoomResponse(details));
    },
  );

  app.get(
    "/rooms/:roomId",
    async (request, reply) => {
    await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const details = await roomService.details(roomId);
    return reply.send(toRoomResponse(details));
    },
  );

  app.post(
    "/rooms/:roomId/join",
    async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const details = await roomService.join(authenticated, roomId);
    return reply.send(toRoomResponse(details));
    },
  );

  app.post(
    "/rooms/:roomId/leave",
    async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    await roomService.leave(authenticated, roomId);
    return reply.code(204).send();
    },
  );

  app.post(
    "/rooms/:roomId/ready",
    async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const { ready } = readyBody.parse(request.body);
    const details = await roomService.setReady(
      authenticated,
      roomId,
      ready,
    );
    return reply.send(toRoomResponse(details));
    },
  );

  app.put(
    "/rooms/:roomId/rules",
    async (request, reply) => {
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
    },
  );

  app.post(
    "/rooms/:roomId/host",
    async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    const { nextHostUserId } = transferHostBody.parse(request.body);
    const details = await roomService.transferHost(
      authenticated,
      roomId,
      nextHostUserId,
    );
    return reply.send(toRoomResponse(details));
    },
  );

  app.post(
    "/rooms/:roomId/close",
    async (request, reply) => {
    const authenticated = await requireAuthentication(request, authService);
    const { roomId } = roomIdParams.parse(request.params);
    await roomService.close(authenticated, roomId);
    return reply.code(204).send();
    },
  );
}


async function requireAuthentication(
  request: FastifyRequest,
  authService: AuthService,
) {
  const authenticated = await authenticateRequest(request, authService);
  if (!authenticated) throw new AuthenticationError();
  return authenticated;
}
