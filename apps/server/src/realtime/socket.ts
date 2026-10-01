import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { AuthService } from "../auth/auth.service.js";
import { createAuthenticationMiddleware } from "./middleware/authentication.js";
import { registerRoomHandlers } from "./handlers/room.handler.js";
import { RoomService } from "../rooms/room.service.js";
import { FixedWindowRateLimiter } from "../auth/auth.rate-limit.js";
import type { AuthConfig, ServerConfig } from "../config/types.js";

export function createRealtimeServer(
  httpServer: HttpServer,
  authService: AuthService,
  roomService: RoomService,
  config: AuthConfig,
  serverConfig: ServerConfig,
): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: serverConfig.corsOrigin ?? false,
      credentials: true,
    },
  });
  const handshakeLimiter = new FixedWindowRateLimiter(
    config.rateLimitMax,
    config.rateLimitWindowSeconds * 1000,
  );
  const eventLimiter = new FixedWindowRateLimiter(
    config.rateLimitMax,
    config.rateLimitWindowSeconds * 1000,
  );
  io.use(createAuthenticationMiddleware(authService, handshakeLimiter));
  io.on("connection", (socket) => {
    registerRoomHandlers(io, socket, roomService, eventLimiter);
  });
  return io;
}
