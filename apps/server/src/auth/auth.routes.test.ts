import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI =
  "http://127.0.0.1:3000/auth/google/callback";

const { buildApp } = await import("../main.js");
const { loadConfig } = await import("../config/env.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createTestApp() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catan-auth-"));
  temporaryDirectories.push(directory);
  process.env.MOCK_DB_PATH = path.join(directory, "mock-db.json");
  const app = buildApp(loadConfig());
  await app.ready();
  return app;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("auth HTTP integration", () => {
  it("registers, authenticates, logs in, and logs out a password user", async () => {
    const app = await createTestApp();
    const registration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: "alice", password: "correct horse battery" },
    });

    expect(registration.statusCode).toBe(201);
    expect(registration.json()).toMatchObject({
      username: "alice",
      isGuest: false,
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: "alice", password: "another password" },
    });
    expect(duplicate.statusCode).toBe(409);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice", password: "correct horse battery" },
    });
    expect(login.statusCode).toBe(200);

    const cookie = cookieHeader(login.headers["set-cookie"]);
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe("alice");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice", password: "wrong password" },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    await app.close();
  });

  it("completes Google callback and creates a local session", async () => {
    const app = await createTestApp();
    const googleProfile = {
      sub: "google-user-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
      picture: "https://example.com/alice.png",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "google-token" }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(googleProfile), { status: 200 }),
        ),
    );

    const start = await app.inject({
      method: "GET",
      url: "/auth/google",
    });
    const oauthCookies = cookieHeader(start.headers["set-cookie"]);
    expect(start.statusCode).toBe(302);
    const locationHeader = start.headers.location;
    expect(locationHeader).toBeTruthy();
    if (!locationHeader) {
      throw new Error("OAuth redirect did not contain a location");
    }
    const location = new URL(locationHeader);
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    if (!state) {
      throw new Error("OAuth redirect did not contain state");
    }

    const callback = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=google-code&state=${state}`,
      headers: { cookie: oauthCookies },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({
      displayName: "Alice",
      email: "alice@example.com",
      isGuest: false,
    });
    expect(callback.headers["set-cookie"]).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
