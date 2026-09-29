import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  InvalidCredentialsError,
  UsernameTakenError,
} from "./auth.errors.js";
import type { AuthRepository } from "./auth.repository.js";
import type { AuthenticatedUser, Session, User } from "./auth.types.js";

const SESSION_COOKIE = "catan_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const scrypt = promisify(scryptCallback);

export class AuthService {
  public constructor(private readonly repository: AuthRepository) {}

  public async createGuest(): Promise<{
    user: User;
    session: Session;
    token: string;
  }> {
    const user = await this.repository.createGuestUser(createGuestName());
    const { session, token } = await this.createSessionForUser(user);
    return { user, session, token };
  }

  public async createSessionForUser(user: User): Promise<{
    session: Session;
    token: string;
  }> {
    const token = randomBytes(32).toString("base64url");
    const session = await this.repository.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });

    return { session, token };
  }

  public async register(
    username: string,
    password: string,
  ): Promise<{ user: User; token: string }> {
    if (await this.repository.findUserByUsername(username)) {
      throw new UsernameTakenError();
    }
    const passwordHash = await hashPassword(password);
    const user = await this.repository.createPasswordUser(
      username,
      passwordHash,
    );
    const { token } = await this.createSessionForUser(user);
    return { user, token };
  }

  public async login(
    username: string,
    password: string,
  ): Promise<{ user: User; token: string }> {
    const user = await this.repository.findUserByUsername(username);
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw new InvalidCredentialsError();
    }
    const { token } = await this.createSessionForUser(user);
    return { user, token };
  }

  public async authenticate(
    token: string,
  ): Promise<AuthenticatedUser | undefined> {
    const session = await this.repository.findSessionByTokenHash(
      hashToken(token),
    );
    if (!session) {
      return undefined;
    }

    const user = await this.repository.findUserById(session.userId);
    return user ? { user, session } : undefined;
  }

  public async revoke(token: string): Promise<void> {
    const session = await this.repository.findSessionByTokenHash(hashToken(token));
    if (session) {
      await this.repository.revokeSession(session.id);
    }
  }

  public static readonly sessionCookie = SESSION_COOKIE;
}

function createGuestName(): string {
  return `Guest-${randomBytes(4).toString("hex")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, encodedHash] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !encodedHash) {
    return false;
  }
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
