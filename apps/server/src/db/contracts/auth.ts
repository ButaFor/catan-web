export type User = {
  id: string; displayName: string; isGuest: boolean; createdAt: string;
  email?: string; emailVerified?: boolean; avatarUrl?: string; username?: string; passwordHash?: string;
};
export type OAuthAccount = { id: string; userId: string; provider: "google"; providerAccountId: string; createdAt: string };
export type Session = { id: string; userId: string; tokenHash: string; createdAt: string; expiresAt: string; revokedAt?: string };

export type CreateOAuthUser = {
  displayName: string;
  email: string;
  avatarUrl?: string;
  providerAccountId: string;
};

export interface AuthRepositoryPort {
  createGuestUser(displayName: string): Promise<User>;
  createOAuthUser(input: CreateOAuthUser): Promise<User>;
  createPasswordUser(username: string, passwordHash: string): Promise<User>;
  findUserById(id: string): Promise<User | undefined>;
  findUserByUsername(username: string): Promise<User | undefined>;
  findUserByEmail(email: string): Promise<User | undefined>;
  findOAuthAccount(provider: OAuthAccount["provider"], providerAccountId: string): Promise<{ account: OAuthAccount; user: User } | undefined>;
  linkOAuthAccount(userId: string, provider: OAuthAccount["provider"], providerAccountId: string): Promise<void>;
  createSession(session: Omit<Session, "id">): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | undefined>;
  revokeSession(sessionId: string): Promise<void>;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
