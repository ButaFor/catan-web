import type { Server, Socket } from "socket.io";
import { RepositoryError } from "../../db/repository.errors.js";
import { RoomService } from "../../rooms/room.service.js";
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
): void {
  socket.on("room:join", async (payload: unknown, acknowledge?: Ack) => {
    await handle(socket, acknowledge, payload, roomJoinPayload, async (input) => {
      const details = await roomService.join(
        requireAuthenticated(socket),
        input.roomId,
      );
      await socket.join(roomChannel(input.roomId));
      io.to(roomChannel(input.roomId)).emit(roomUpdatedEvent, details);
      return details;
    });
  });

  socket.on("room:leave", async (payload: unknown, acknowledge?: Ack) => {
    await handle(socket, acknowledge, payload, roomLeavePayload, async (input) => {
      await roomService.leave(requireAuthenticated(socket), input.roomId);
      socket.leave(roomChannel(input.roomId));
      return { roomId: input.roomId };
    });
  });

  socket.on("room:ready", async (payload: unknown, acknowledge?: Ack) => {
    await handle(socket, acknowledge, payload, roomReadyPayload, async (input) => {
      const details = await roomService.setReady(
        requireAuthenticated(socket),
        input.roomId,
        input.ready,
      );
      io.to(roomChannel(input.roomId)).emit(roomUpdatedEvent, details);
      return details;
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
  operation: (input: T) => Promise<unknown>,
): Promise<void> {
  try {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      acknowledge?.({ code: "INVALID_REQUEST", message: "Request data is invalid" });
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
