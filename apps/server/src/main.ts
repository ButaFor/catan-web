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

export function buildApp(config: AppConfig = loadConfig()) {
 const app = Fastify({ logger: true });
 const authRepository = new AuthRepository(config.database.mockDbPath);
 const authService = new AuthService(authRepository, config.auth);
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

   request.log.error(error instanceof Error ? error : { error });
   return reply.code(500).send({
     code: "INTERNAL_SERVER_ERROR",
     message: "An unexpected error occurred",
   });
 });

 return app;
}

const config = loadConfig();
if (config.server.nodeEnv !== "test") {
 const app = buildApp(config);
 await app.listen({ port: config.server.port, host: config.server.host });
}
