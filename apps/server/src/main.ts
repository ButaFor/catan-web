import Fastify from "fastify";
import cookie from "@fastify/cookie";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthRepository } from "./auth/auth.repository.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { AuthService } from "./auth/auth.service.js";
import { GoogleOAuthService } from "./auth/oauth/google.service.js";
import {
  InvalidCredentialsError,
  OAuthConfigurationError,
  UsernameTakenError,
} from "./auth/auth.errors.js";

export function buildApp() {
 const app = Fastify({ logger: true });
 const dataFile =
   process.env.MOCK_DB_PATH ??
   path.resolve(
     path.dirname(fileURLToPath(import.meta.url)),
     "../data/mock-db.json",
   );
 const authRepository = new AuthRepository(dataFile);
 const authService = new AuthService(authRepository);
 const googleOAuth = new GoogleOAuthService(
   authRepository,
   authService,
   getGoogleConfig(),
 );

 app.register(cookie);
 app.get("/health", async () => ({ status: "ok" }));
 app.register(async (instance) =>
   registerAuthRoutes(instance, authService, googleOAuth),
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

function getGoogleConfig() {
 const clientId = process.env.GOOGLE_CLIENT_ID;
 const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
 const redirectUri = process.env.GOOGLE_REDIRECT_URI;
 return clientId && clientSecret && redirectUri
   ? { clientId, clientSecret, redirectUri }
   : undefined;
}

if (process.env.NODE_ENV !== "test") {
 const app = buildApp();
 const port = Number(process.env.PORT ?? 3000);
 const host = process.env.HOST ?? "127.0.0.1";
 await app.listen({ port, host });
}
