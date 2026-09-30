import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.js";

describe("loadConfig", () => {
  it("loads development defaults", () => {
    const config = loadConfig({});

    expect(config.server).toMatchObject({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
    });
    expect(config.auth).toMatchObject({
      secureCookies: false,
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      oauthStateTtlSeconds: 600,
    });
    expect(config.googleOAuth).toBeUndefined();
    expect(config.database.mockDbPath).toMatch(/apps[\\/]server[\\/]data[\\/]mock-db\.json$/);
  });

  it("normalizes custom server and auth settings", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8080",
      SESSION_TTL_SECONDS: "3600",
      OAUTH_STATE_TTL_SECONDS: "120",
      MOCK_DB_PATH: "C:\\data\\mock-db.json",
      CORS_ORIGIN: "https://play.butafor.online",
    });

    expect(config.server).toEqual({
      nodeEnv: "production",
      host: "0.0.0.0",
      port: 8080,
      corsOrigin: "https://play.butafor.online",
    });
    expect(config.auth).toMatchObject({
      secureCookies: true,
      sessionTtlMs: 3600000,
      oauthStateTtlSeconds: 120,
    });
    expect(config.database.mockDbPath).toBe("C:\\data\\mock-db.json");
  });

  it("loads a complete Google OAuth configuration", () => {
    const config = loadConfig({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "http://127.0.0.1:3000/auth/google/callback",
    });

    expect(config.googleOAuth).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:3000/auth/google/callback",
    });
  });

  it("rejects partial or malformed configuration", () => {
    expect(() =>
      loadConfig({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "secret-value",
      }),
    ).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() =>
      loadConfig({
        GOOGLE_REDIRECT_URI: "not-a-url",
      }),
    ).toThrow(/GOOGLE_REDIRECT_URI/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ SESSION_TTL_SECONDS: "0" })).toThrow(
      /SESSION_TTL_SECONDS/,
    );
  });

  it("does not include secret values in validation errors", () => {
    const secret = "super-secret-value";

    expect(() =>
      loadConfig({
        GOOGLE_CLIENT_SECRET: secret,
        GOOGLE_REDIRECT_URI: "not-a-url",
      }),
    ).toThrow(new RegExp(`^((?!${secret}).)*$`));
  });
});
