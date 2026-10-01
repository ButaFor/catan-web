import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { AuthRepository } from "./auth/auth.repository.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { AuthService } from "./auth/auth.service.js";
import { GoogleOAuthService } from "./auth/oauth/google.service.js";
import { loadConfig } from "./config/env.js";
import type { AppConfig } from "./config/types.js";
import {
  InvalidCredentialsError,
  OAuthConfigurationError,
  UsernameTakenError,
} from "./auth/auth.errors.js";
import { RepositoryError } from "./db/repository.errors.js";
import { InMemoryRoomRepository } from "./rooms/room.repository.js";
import { registerRoomRoutes } from "./rooms/room.routes.js";
import { RoomService } from "./rooms/room.service.js";

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
 app.get("/health", async () => ({ status: "ok" }));
 app.register(async (instance) =>
   registerAuthRoutes(instance, authService, googleOAuth, config.auth),
 );
 app.register(async (instance) =>
   registerRoomRoutes(instance, roomService, authService),
 );

 app.setErrorHandler((error, request, reply) => {
   const errorObject = error instanceof Error ? error : undefined;
   const errorName = errorObject?.name;

   if (errorName === "ZodError") {
     return reply.code(400).send({
       code: "INVALID_REQUEST",
       message: "Request data is invalid",
     });
   }

   if (errorObject?.name === "AuthenticationError") {
     return reply.code(401).send({
       code: "AUTHENTICATION_REQUIRED",
       message: errorObject.message,
     });
   }

   if (errorObject instanceof OAuthConfigurationError) {
     return reply.code(503).send({
       code: errorObject.code,
       message: "Google OAuth is not configured",
     });
   }

   if (errorObject instanceof InvalidCredentialsError) {
     return reply.code(401).send({
       code: errorObject.code,
       message: errorObject.message,
     });
   }

   if (errorObject instanceof UsernameTakenError) {
     return reply.code(409).send({
       code: errorObject.code,
       message: errorObject.message,
     });
   }

   if (errorObject instanceof RepositoryError) {
     const status = repositoryErrorStatus(errorObject.code);
     return reply.code(status).send({
       code: errorObject.code,
       message: repositoryErrorMessage(errorObject.code),
     });
   }

   request.log.error(error instanceof Error ? error : { error });
   return reply.code(500).send({
     code: "INTERNAL_SERVER_ERROR",
     message: "An unexpected error occurred",
   });
 });

 return app;
}

function repositoryErrorStatus(
 code: RepositoryError["code"],
): 400 | 403 | 404 | 409 | 422 | 500 | 503 {
 if (code === "NOT_FOUND") return 404;
 if (
   code === "FORBIDDEN" ||
   code === "ACCOUNT_CONFLICT" ||
   code === "USERNAME_TAKEN" ||
   code === "ROOM_CODE_TAKEN" ||
   code === "ROOM_FULL" ||
   code === "INVALID_STATE_TRANSITION" ||
   code === "GAME_ALREADY_OPEN" ||
   code === "CONCURRENCY_CONFLICT"
 ) {
   return code === "FORBIDDEN" ? 403 : 409;
 }
 if (code === "INVALID_PERSISTENCE_INPUT") return 500;
 if (
   code === "UNSUPPORTED_PERSISTED_VERSION" ||
   code === "DATABASE_UNAVAILABLE"
 ) {
   return 503;
 }
 return 500;
}

function repositoryErrorMessage(code: RepositoryError["code"]): string {
 const messages: Record<RepositoryError["code"], string> = {
   NOT_FOUND: "The requested resource was not found",
   FORBIDDEN: "You do not have permission to perform this action",
   INVALID_STATE_TRANSITION: "The requested state transition is invalid",
   GAME_ALREADY_OPEN: "The room already has an open game",
   CONCURRENCY_CONFLICT: "The resource was changed; please retry",
   ACCOUNT_CONFLICT: "The account conflicts with an existing identity",
   USERNAME_TAKEN: "Username is already taken",
   ROOM_CODE_TAKEN: "Room code is already taken",
   ROOM_FULL: "Room capacity has been reached",
   INVALID_PERSISTENCE_INPUT: "The server produced invalid persistence data",
   UNSUPPORTED_PERSISTED_VERSION:
     "The stored data version is not supported",
   DATABASE_UNAVAILABLE: "The database is temporarily unavailable",
   INTERNAL_SERVER_ERROR: "An unexpected error occurred",
 };
 return messages[code];
}

const config = loadConfig();
if (config.server.nodeEnv !== "test") {
 const app = buildApp(config);
 await app.listen({ port: config.server.port, host: config.server.host });
}
