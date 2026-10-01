import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { AuthRepository } from "./auth/auth.repository.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { AuthService } from "./auth/auth.service.js";
import { GoogleOAuthService } from "./auth/oauth/google.service.js";
import { loadConfig } from "./config/env.js";
import type { AppConfig } from "./config/types.js";
import { InMemoryRoomRepository } from "./rooms/room.repository.js";
import { registerRoomRoutes } from "./rooms/room.routes.js";
import { RoomService } from "./rooms/room.service.js";
import { registerCors } from "./http/plugins/cors.js";
import { registerErrorHandler } from "./http/plugins/error-handler.js";
import { registerHealthRoutes } from "./http/routes/health.routes.js";
import { createRealtimeServer } from "./realtime/socket.js";

export function buildApp(config: AppConfig = loadConfig()) {
 const app = Fastify({ logger: true });
 const authRepository = new AuthRepository(config.database.mockDbPath);
 const authService = new AuthService(authRepository, config.auth);
 const roomService = new RoomService(new InMemoryRoomRepository());
 const googleOAuth = new GoogleOAuthService(
   authRepository,
   authService,
   config.googleOAuth,
 );

 app.register(cookie);
 registerCors(app, config.server);
 registerHealthRoutes(app);
 app.register(async (instance) =>
   registerAuthRoutes(instance, authService, googleOAuth, config.auth),
 );
 app.register(async (instance) =>
   registerRoomRoutes(instance, roomService, authService),
 );
 registerErrorHandler(app);
 createRealtimeServer(app.server, authService, roomService);

 return app;
}

const config = loadConfig();
if (config.server.nodeEnv !== "test") {
 const app = buildApp(config);
 await app.listen({ port: config.server.port, host: config.server.host });
}
