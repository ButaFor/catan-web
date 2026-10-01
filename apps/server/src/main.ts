import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Pool } from "pg";
import {
  createPool,
  PgAuthRepository,
  PgRoomRepository,
} from "./db/index.js";
import { AuthRepository } from "./auth/auth.repository.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { AuthService } from "./auth/auth.service.js";
import { GoogleOAuthService } from "./auth/oauth/google.service.js";
import { loadConfig } from "./config/env.js";
import type { AppConfig } from "./config/types.js";
import { InMemoryRoomRepository } from "./rooms/room.repository.js";
import { registerRoomRoutes } from "./rooms/room.routes.js";
import { RoomService } from "./rooms/room.service.js";
import { roomRulesCodec } from "./rooms/room.rules.codec.js";
import { registerCors } from "./http/plugins/cors.js";
import { registerErrorHandler } from "./http/plugins/error-handler.js";
import { registerHealthRoutes } from "./http/routes/health.routes.js";
import { createRealtimeServer } from "./realtime/socket.js";

export function buildApp(config: AppConfig = loadConfig()) {
 const app = Fastify({ logger: true });
 const pool: Pool | undefined = config.database.url
   ? createPool({ connectionString: config.database.url })
   : undefined;
 const authRepository = pool
   ? new PgAuthRepository(pool)
   : new AuthRepository(config.database.mockDbPath);
 const authService = new AuthService(authRepository, config.auth);
 const roomRepository = pool
   ? new PgRoomRepository(pool, roomRulesCodec)
   : new InMemoryRoomRepository();
 const roomService = new RoomService(roomRepository);
 const googleOAuth = new GoogleOAuthService(
   authRepository,
   authService,
   config.googleOAuth,
 );

 app.register(cookie);
 app.register(rateLimit, {
   global: true,
   max: config.auth.rateLimitMax,
   timeWindow: config.auth.rateLimitWindowSeconds * 1000,
   errorResponseBuilder: () => ({
     statusCode: 429,
     code: "RATE_LIMITED",
     message: "Too many requests",
   }),
 });
 registerCors(app, config.server);
 registerHealthRoutes(app);
 app.register(async (instance) =>
   registerAuthRoutes(instance, authService, googleOAuth, config.auth),
 );
 app.register(async (instance) =>
   registerRoomRoutes(instance, roomService, authService),
 );
 registerErrorHandler(app);
 if (pool) {
   app.addHook("onClose", async () => {
     await pool.end();
   });
 }
 createRealtimeServer(app.server, authService, roomService, config.auth);

 return app;
}

const config = loadConfig();
if (config.server.nodeEnv !== "test") {
 const app = buildApp(config);
 await app.listen({ port: config.server.port, host: config.server.host });
}
