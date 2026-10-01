import type { FastifyInstance } from "fastify";
import {
  InvalidCredentialsError,
  OAuthConfigurationError,
  UsernameTakenError,
} from "../../auth/auth.errors.js";
import { RepositoryError } from "../../db/repository.errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
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
