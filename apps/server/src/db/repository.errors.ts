export type RepositoryErrorCode =
  | "NOT_FOUND" | "FORBIDDEN" | "INVALID_STATE_TRANSITION"
  | "GAME_ALREADY_OPEN" | "CONCURRENCY_CONFLICT" | "ACCOUNT_CONFLICT"
  | "USERNAME_TAKEN" | "ROOM_CODE_TAKEN" | "ROOM_FULL"
  | "INVALID_PERSISTENCE_INPUT" | "UNSUPPORTED_PERSISTED_VERSION"
  | "DATABASE_UNAVAILABLE" | "INTERNAL_SERVER_ERROR";

export class RepositoryError extends Error {
  public constructor(public readonly code: RepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryError";
  }
}

export function fail(code: RepositoryErrorCode, message: string): never {
  throw new RepositoryError(code, message);
}
