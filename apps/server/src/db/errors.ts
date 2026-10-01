import { RepositoryError } from "./repository.errors.js";

export function databaseError(error: unknown): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const pg = error as { code?: string; constraint?: string } | null;
  if (pg?.code === "23505") {
    const codes = {
      users_username_unique: "USERNAME_TAKEN",
      users_email_unique: "ACCOUNT_CONFLICT",
      oauth_accounts_provider_unique: "ACCOUNT_CONFLICT",
      games_one_open_per_room: "GAME_ALREADY_OPEN",
      rooms_code_key: "ROOM_CODE_TAKEN",
    } as const;
    const code = codes[pg.constraint as keyof typeof codes];
    if (code) return new RepositoryError(code, "The requested value is already in use", { cause: error });
  }
  if (pg?.code === "40001" || pg?.code === "40P01") {
    return new RepositoryError("CONCURRENCY_CONFLICT", "Concurrent update prevented the operation", { cause: error });
  }
  if (pg?.code?.startsWith("08") || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P02", "57P03", "53300"].includes(pg?.code ?? "")) {
    return new RepositoryError("DATABASE_UNAVAILABLE", "Database is unavailable", { cause: error });
  }
  return new RepositoryError("INTERNAL_SERVER_ERROR", "Persistence operation failed", { cause: error });
}

export async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw databaseError(error); }
}
