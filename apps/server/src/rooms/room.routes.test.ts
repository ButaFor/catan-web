import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI =
  "http://127.0.0.1:3000/auth/google/callback";

const { buildApp } = await import("../main.js");
const { loadConfig } = await import("../config/env.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function createAuthenticatedApp() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catan-room-"));
  temporaryDirectories.push(directory);
  process.env.MOCK_DB_PATH = path.join(directory, "mock-db.json");
  const app = buildApp(loadConfig());
  await app.ready();
  const guest = await app.inject({
    method: "POST",
    url: "/auth/guest",
    payload: {},
  });
  return { app, cookie: cookieHeader(guest.headers["set-cookie"]) };
}

describe("rooms HTTP integration", () => {
  it("creates, reads, joins, and updates readiness", async () => {
    const first = await createAuthenticatedApp();
    const created = await first.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { cookie: first.cookie },
      payload: { name: "Test room", capacity: 3 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "Test room",
      capacity: 3,
      status: "waiting",
      members: [{ ready: false }],
    });
    const roomId = created.json().id as string;

    const details = await first.app.inject({
      method: "GET",
      url: `/rooms/${roomId}`,
      headers: { cookie: first.cookie },
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().members).toHaveLength(1);

    const ready = await first.app.inject({
      method: "POST",
      url: `/rooms/${roomId}/ready`,
      headers: { cookie: first.cookie },
      payload: { ready: true },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().members[0].ready).toBe(true);
    await first.app.close();
  });

  it("requires authentication for room operations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "catan-room-"));
    temporaryDirectories.push(directory);
    process.env.MOCK_DB_PATH = path.join(directory, "mock-db.json");
    const app = buildApp(loadConfig());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { name: "Private room", capacity: 4 },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
    await app.close();
  });

  it("supports host transfer, rules update, and room closure", async () => {
    const first = await createAuthenticatedApp();
    const secondGuest = await first.app.inject({
      method: "POST",
      url: "/auth/guest",
      payload: {},
    });
    const secondCookie = cookieHeader(secondGuest.headers["set-cookie"]);
    const created = await first.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { cookie: first.cookie },
      payload: { name: "Lifecycle room", capacity: 3 },
    });
    const roomId = created.json().id as string;
    await first.app.inject({
      method: "POST",
      url: `/rooms/${roomId}/join`,
      headers: { cookie: secondCookie },
    });

    const transferred = await first.app.inject({
      method: "POST",
      url: `/rooms/${roomId}/host`,
      headers: { cookie: first.cookie },
      payload: { nextHostUserId: secondGuest.json().id },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().hostUserId).toBe(secondGuest.json().id);

    const updated = await first.app.inject({
      method: "PUT",
      url: `/rooms/${roomId}/rules`,
      headers: { cookie: secondCookie },
      payload: { expectedVersion: transferred.json().version, rulesVersion: 1, rules: {} },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().currentRules).toEqual({ rulesVersion: 1, rules: {} });

    const closed = await first.app.inject({
      method: "POST",
      url: `/rooms/${roomId}/close`,
      headers: { cookie: secondCookie },
    });
    expect(closed.statusCode).toBe(204);
    const details = await first.app.inject({
      method: "GET",
      url: `/rooms/${roomId}`,
      headers: { cookie: secondCookie },
    });
    expect(details.json().status).toBe("closed");
    await first.app.close();
  });

  it("rate-limits authenticated room requests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "catan-room-"));
    temporaryDirectories.push(directory);
    process.env.MOCK_DB_PATH = path.join(directory, "mock-db.json");
    process.env.AUTH_RATE_LIMIT_MAX = "2";
    const app = buildApp(loadConfig());
    await app.ready();

    const guest = await app.inject({
      method: "POST",
      url: "/auth/guest",
      payload: {},
    });
    const cookie = cookieHeader(guest.headers["set-cookie"]);
    const first = await app.inject({
      method: "POST",
      url: "/rooms",
      headers: { cookie },
      payload: { name: "Limited room", capacity: 3 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/rooms",
      headers: { cookie },
      payload: { name: "Blocked room", capacity: 3 },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(second.headers["retry-after"]).toBeDefined();
    await app.close();
    delete process.env.AUTH_RATE_LIMIT_MAX;
  });
});
