import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeEmail,
  type AuthRepositoryPort,
  type CreateOAuthUser,
  type OAuthAccount,
  type Session,
  type User,
} from "../db/contracts/auth.js";

type MockDatabase = {
  users: User[];
  sessions: Session[];
  oauthAccounts: OAuthAccount[];
};

const emptyDatabase: MockDatabase = {
  users: [],
  sessions: [],
  oauthAccounts: [],
};

export class AuthRepository implements AuthRepositoryPort {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async createGuestUser(displayName: string): Promise<User> {
    const database = await this.readDatabase();
    const user: User = {
      id: randomUUID(),
      displayName,
      isGuest: true,
      createdAt: new Date().toISOString(),
    };

    database.users.push(user);
    await this.writeDatabase(database);
    return user;
  }

  public async createOAuthUser(input: CreateOAuthUser): Promise<User> {
    const database = await this.readDatabase();
    const user: User = {
      id: randomUUID(),
      displayName: input.displayName,
      isGuest: false,
      createdAt: new Date().toISOString(),
      email: normalizeEmail(input.email),
      emailVerified: true,
      ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    };

    database.users.push(user);
    database.oauthAccounts.push({
      id: randomUUID(),
      userId: user.id,
      provider: "google",
      providerAccountId: input.providerAccountId,
      createdAt: new Date().toISOString(),
    });
    await this.writeDatabase(database);
    return user;
  }

  public async createPasswordUser(
    username: string,
    passwordHash: string,
  ): Promise<User> {
    const database = await this.readDatabase();
    const user: User = {
      id: randomUUID(),
      displayName: username,
      username,
      passwordHash,
      isGuest: false,
      createdAt: new Date().toISOString(),
    };
    database.users.push(user);
    await this.writeDatabase(database);
    return user;
  }

  public async findUserByUsername(username: string): Promise<User | undefined> {
    const database = await this.readDatabase();
    return database.users.find(
      (user) => user.username?.toLowerCase() === username.toLowerCase(),
    );
  }

  public async findOAuthAccount(
    provider: OAuthAccount["provider"],
    providerAccountId: string,
  ): Promise<{ account: OAuthAccount; user: User } | undefined> {
    const database = await this.readDatabase();
    const account = database.oauthAccounts.find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.providerAccountId === providerAccountId,
    );

    if (!account) {
      return undefined;
    }

    const user = database.users.find((candidate) => candidate.id === account.userId);
    return user ? { account, user } : undefined;
  }

  public async findUserByEmail(email: string): Promise<User | undefined> {
    const database = await this.readDatabase();
    const normalizedEmail = normalizeEmail(email);
    return database.users.find(
      (user) => user.email && normalizeEmail(user.email) === normalizedEmail,
    );
  }

  public async linkOAuthAccount(
    userId: string,
    provider: OAuthAccount["provider"],
    providerAccountId: string,
  ): Promise<void> {
    const database = await this.readDatabase();
    if (
      database.oauthAccounts.some(
        (account) =>
          account.provider === provider &&
          account.providerAccountId === providerAccountId,
      )
    ) {
      return;
    }

    database.oauthAccounts.push({
      id: randomUUID(),
      userId,
      provider,
      providerAccountId,
      createdAt: new Date().toISOString(),
    });
    await this.writeDatabase(database);
  }

  public async createSession(
    session: Omit<Session, "id">,
  ): Promise<Session> {
    const database = await this.readDatabase();
    const createdSession: Session = { id: randomUUID(), ...session };

    database.sessions.push(createdSession);
    await this.writeDatabase(database);
    return createdSession;
  }

  public async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<Session | undefined> {
    const database = await this.readDatabase();
    return database.sessions.find(
      (session) =>
        session.tokenHash === tokenHash &&
        !session.revokedAt &&
        new Date(session.expiresAt).getTime() > Date.now(),
    );
  }

  public async findUserById(userId: string): Promise<User | undefined> {
    const database = await this.readDatabase();
    return database.users.find((user) => user.id === userId);
  }

  public async revokeSession(sessionId: string): Promise<void> {
    const database = await this.readDatabase();
    const session = database.sessions.find(
      (candidate) => candidate.id === sessionId,
    );

    if (!session || session.revokedAt) {
      return;
    }

    session.revokedAt = new Date().toISOString();
    await this.writeDatabase(database);
  }

  private async readDatabase(): Promise<MockDatabase> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);

      if (!isMockDatabase(parsed)) {
        throw new Error("Mock database has an invalid format");
      }

      return {
        ...parsed,
        oauthAccounts: parsed.oauthAccounts ?? [],
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        await this.writeDatabase(emptyDatabase);
        return structuredClone(emptyDatabase);
      }

      throw error;
    }
  }

  private async writeDatabase(database: MockDatabase): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
      await rename(temporaryPath, this.filePath);
    });

    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}

function isMockDatabase(value: unknown): value is MockDatabase {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    users?: unknown;
    sessions?: unknown;
    oauthAccounts?: unknown;
  };
  return (
    Array.isArray(candidate.users) &&
    Array.isArray(candidate.sessions) &&
    (candidate.oauthAccounts === undefined ||
      Array.isArray(candidate.oauthAccounts))
  );
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
