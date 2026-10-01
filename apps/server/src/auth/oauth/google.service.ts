import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { OAuthConfigurationError } from "../auth.errors.js";
import {
  normalizeEmail,
  type AuthRepositoryPort,
} from "../../db/contracts/auth.js";
import type { AuthService } from "../auth.service.js";
import type { User } from "../auth.types.js";

const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleAuthorization = {
  url: string;
  state: string;
  verifier: string;
};

export class GoogleOAuthService {
  public constructor(
    private readonly repository: AuthRepositoryPort,
    private readonly authService: AuthService,
    private readonly config?: GoogleConfig,
  ) {}

  public createAuthorization(): GoogleAuthorization {
    const config = this.requireConfig();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const parameters = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    return {
      url: `${GOOGLE_AUTHORIZATION_URL}?${parameters.toString()}`,
      state,
      verifier,
    };
  }

  public async completeAuthorization(
    code: string,
    verifier: string,
  ): Promise<{ user: User; token: string }> {
    const config = this.requireConfig();
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Google token exchange failed");
    }

    const tokenPayload = (await tokenResponse.json()) as unknown;
    if (!isAccessTokenResponse(tokenPayload)) {
      throw new Error("Google returned an invalid token response");
    }

    const userResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
      },
    });
    if (!userResponse.ok) {
      throw new Error("Google user info request failed");
    }

    const profile = (await userResponse.json()) as unknown;
    if (!isGoogleProfile(profile) || profile.email_verified !== true) {
      throw new Error("Google account does not have a verified email");
    }

    const existingAccount = await this.repository.findOAuthAccount(
      "google",
      profile.sub,
    );
    let user = existingAccount?.user;
    if (!user) {
      user = await this.repository.findUserByEmail(
        normalizeEmail(profile.email),
      );
      if (user) {
        await this.repository.linkOAuthAccount(user.id, "google", profile.sub);
      }
    }
    user ??= await this.repository.createOAuthUser({
      displayName: profile.name ?? profile.email.split("@")[0] ?? "Google user",
      email: normalizeEmail(profile.email),
      ...(profile.picture ? { avatarUrl: profile.picture } : {}),
      providerAccountId: profile.sub,
    });

    const { token } = await this.authService.createSessionForUser(user);
    return { user, token };
  }

  public static verifyState(expected: string, received: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    return (
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
    );
  }

  private requireConfig(): GoogleConfig {
    if (!this.config) {
      throw new OAuthConfigurationError();
    }
    return this.config;
  }
}

function isAccessTokenResponse(
  value: unknown,
): value is { access_token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "access_token" in value &&
    typeof value.access_token === "string"
  );
}

function isGoogleProfile(
  value: unknown,
): value is {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.sub === "string" &&
    typeof profile.email === "string" &&
    typeof profile.email_verified === "boolean" &&
    (profile.name === undefined || typeof profile.name === "string") &&
    (profile.picture === undefined || typeof profile.picture === "string")
  );
}
