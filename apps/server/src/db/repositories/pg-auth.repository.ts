import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { normalizeEmail, type AuthRepositoryPort, type CreateOAuthUser, type OAuthAccount, type Session } from "../contracts/auth.js";
import { databaseOperation } from "../errors.js";
import { transaction } from "../transaction.js";
import { fail } from "../repository.errors.js";
import { pageLimit, uuid } from "../input.js";
import { userFromRow, oauthFromRow, sessionFromRow, type UserRow, type OAuthRow, type SessionRow } from "../rows.js";

export class PgAuthRepository implements AuthRepositoryPort {
  constructor(private readonly pool: Pool) {}

  createGuestUser(displayName: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<UserRow>(
        "INSERT INTO users(id, display_name, is_guest) VALUES ($1, $2, true) RETURNING *", [randomUUID(), displayName]);
      return userFromRow(result.rows[0]!);
    });
  }
  createPasswordUser(username: string, passwordHash: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<UserRow>(
        "INSERT INTO users(id, display_name, is_guest, username, password_hash) VALUES ($1, $2, false, $2, $3) RETURNING *",
        [randomUUID(), username.trim(), passwordHash]);
      return userFromRow(result.rows[0]!);
    });
  }
  // Caller must verify provider email before invoking this persistence operation.
  createOAuthUser(input: CreateOAuthUser) {
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const result = await client.query<UserRow>(
        "INSERT INTO users(id, display_name, is_guest, email, email_verified, avatar_url) VALUES ($1, $2, false, $3, true, $4) RETURNING *",
        [id, input.displayName, normalizeEmail(input.email), input.avatarUrl ?? null]);
      await client.query(
        "INSERT INTO oauth_accounts(id, user_id, provider, provider_account_id) VALUES ($1, $2, 'google', $3)",
        [randomUUID(), id, input.providerAccountId]);
      return userFromRow(result.rows[0]!);
    });
  }
  findUserById(id: string) { return this.findUser("id = $1", uuid(id)); }
  findUserByUsername(username: string) { return this.findUser("lower(username) = lower($1)", username.trim()); }
  findUserByEmail(email: string) { return this.findUser("email = $1", normalizeEmail(email)); }
  private findUser(predicate: string, value: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<UserRow>("SELECT * FROM users WHERE " + predicate, [value]);
      return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
    });
  }
  findOAuthAccount(provider: OAuthAccount["provider"], providerAccountId: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<OAuthRow>("SELECT * FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2", [provider, providerAccountId]);
      const account = result.rows[0];
      if (!account) return undefined;
      const user = await this.findUserById(account.user_id);
      if (!user) fail("INTERNAL_SERVER_ERROR", "OAuth user is missing");
      return { account: oauthFromRow(account), user };
    });
  }
  linkOAuthAccount(userId: string, provider: OAuthAccount["provider"], providerAccountId: string) {
    uuid(userId);
    return transaction(this.pool, async (client) => {
      const users = await client.query<UserRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const user = users.rows[0];
      if (!user) fail("NOT_FOUND", "User not found");
      if (user.is_guest || !user.email_verified) fail("ACCOUNT_CONFLICT", "Verified account email is required");
      await client.query("INSERT INTO oauth_accounts(id, user_id, provider, provider_account_id) VALUES ($1, $2, $3, $4) ON CONFLICT (provider, provider_account_id) DO NOTHING", [randomUUID(), userId, provider, providerAccountId]);
      const binding = await client.query<OAuthRow>("SELECT * FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2", [provider, providerAccountId]);
      if (binding.rows[0]?.user_id !== userId) fail("ACCOUNT_CONFLICT", "OAuth identity belongs to another user");
    });
  }
  createSession(session: Omit<Session, "id">) {
    uuid(session.userId);
    return databaseOperation(async () => {
      const result = await this.pool.query<SessionRow>("INSERT INTO sessions(id, user_id, token_hash, created_at, expires_at, revoked_at) SELECT $1, id, $3, $4, $5, $6 FROM users WHERE id = $2 RETURNING *",
        [randomUUID(), session.userId, session.tokenHash, session.createdAt, session.expiresAt, session.revokedAt ?? null]);
      if (!result.rows[0]) fail("NOT_FOUND", "Session user not found");
      return sessionFromRow(result.rows[0]!);
    });
  }
  findSessionByTokenHash(tokenHash: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()", [tokenHash]);
      return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
    });
  }
  async revokeSession(sessionId: string) {
    uuid(sessionId);
    await databaseOperation(() => this.pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]));
  }
  async cleanupExpiredSessions(limit = 500): Promise<number> {
    pageLimit(limit);
    return databaseOperation(async () => {
      const result = await this.pool.query("WITH expired AS (SELECT id FROM sessions WHERE expires_at <= now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM sessions USING expired WHERE sessions.id = expired.id", [limit]);
      return result.rowCount ?? 0;
    });
  }
}
