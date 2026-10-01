import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { AuthService } from "../auth/auth.service.js";
import { createAuthenticationMiddleware } from "./middleware/authentication.js";
import { registerRoomHandlers } from "./handlers/room.handler.js";
import { RoomService } from "../rooms/room.service.js";

export function createRealtimeServer(
  httpServer: HttpServer,
  authService: AuthService,
  roomService: RoomService,
): Server {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });
  io.use(createAuthenticationMiddleware(authService));
  io.on("connection", (socket) => {
    registerRoomHandlers(io, socket, roomService);
  });
  return io;
}
