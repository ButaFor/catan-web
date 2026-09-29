export type User = {
  id: string;
  displayName: string;
  isGuest: boolean;
  createdAt: string;
  email?: string;
  avatarUrl?: string;
  username?: string;
  passwordHash?: string;
};

export type OAuthAccount = {
  id: string;
  userId: string;
  provider: "google";
  providerAccountId: string;
  createdAt: string;
};

export type Session = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
};

export type AuthenticatedUser = {
  user: User;
  session: Session;
};
