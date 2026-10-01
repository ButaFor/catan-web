import type { Server, Socket } from "socket.io";
import { RepositoryError } from "../../db/repository.errors.js";
import { FixedWindowRateLimiter } from "../../auth/auth.rate-limit.js";
import { RoomService } from "../../rooms/room.service.js";
import { toRoomResponse } from "../../rooms/room.serializer.js";
import {
  roomJoinPayload,
  roomLeavePayload,
  roomReadyPayload,
  roomUpdatedEvent,
} from "../events.js";

type Ack = (response: unknown) => void;

export function registerRoomHandlers(
  io: Server,
  socket: Socket,
  roomService: RoomService,
  rateLimiter: FixedWindowRateLimiter,
): void {
  socket.on("room:join", async (payload: unknown, acknowledge?: Ack) => {
    await handle(socket, acknowledge, payload, roomJoinPayload, rateLimiter, "room:join", async (input) => {
      const details = await roomService.join(
        requireAuthenticated(socket),
        input.roomId,
      );
      await socket.join(roomChannel(input.roomId));
      const response = toRoomResponse(details);
      io.to(roomChannel(input.roomId)).emit(roomUpdatedEvent, response);
      return response;
    });
  });

  socket.on("room:leave", async (payload: unknown, acknowledge?: Ack) => {
    await handle(socket, acknowledge, payload, roomLeavePayload, rateLimiter, "room:leave", async (input) => {
      await roomService.leave(requireAuthenticated(socket), input.roomId);
      socket.leave(roomChannel(input.roomId));
      return { roomId: input.roomId };
    });
  });

  socket.on("room:ready", async (payload: unknown, acknowledge?: Ack) => {
    await handle(socket, acknowledge, payload, roomReadyPayload, rateLimiter, "room:ready", async (input) => {
      const details = await roomService.setReady(
        requireAuthenticated(socket),
        input.roomId,
        input.ready,
      );
      const response = toRoomResponse(details);
      io.to(roomChannel(input.roomId)).emit(roomUpdatedEvent, response);
      return response;
    });
  });
}

function requireAuthenticated(socket: Socket) {
  if (!socket.data.authenticated) {
    throw new RepositoryError(
      "INTERNAL_SERVER_ERROR",
      "Socket authentication context is missing",
    );
  }
  return socket.data.authenticated;
}

async function handle<T>(
  socket: Socket,
  acknowledge: Ack | undefined,
  payload: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  rateLimiter: FixedWindowRateLimiter,
  eventName: string,
  operation: (input: T) => Promise<unknown>,
): Promise<void> {
  try {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      acknowledge?.({ code: "INVALID_REQUEST", message: "Request data is invalid" });
      return;
    }
    const userId = socket.data.authenticated?.user.id ?? socket.id;
    const result = rateLimiter.consume(`${userId}:${eventName}`);
    if (!result.allowed) {
      acknowledge?.({
        ok: false,
        code: "RATE_LIMITED",
        message: "Too many requests",
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }
    acknowledge?.({ ok: true, data: await operation(parsed.data) });
  } catch (error) {
    const code = error instanceof RepositoryError ? error.code : "INTERNAL_SERVER_ERROR";
    acknowledge?.({
      code,
      message: error instanceof RepositoryError ? error.message : "An unexpected error occurred",
    });
  }
}

function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}
