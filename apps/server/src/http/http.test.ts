import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

const { buildApp } = await import("../main.js");
const { loadConfig } = await import("../config/env.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  delete process.env.CORS_ORIGIN;
});

async function createApp(corsOrigin?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catan-http-"));
  temporaryDirectories.push(directory);
  process.env.MOCK_DB_PATH = path.join(directory, "mock-db.json");
  if (corsOrigin) process.env.CORS_ORIGIN = corsOrigin;
  else delete process.env.CORS_ORIGIN;
  const app = buildApp(loadConfig());
  await app.ready();
  return app;
}

describe("HTTP infrastructure", () => {
  it("serves the health endpoint", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("adds CORS headers when an origin is configured", async () => {
    const app = await createApp("https://client.example");
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://client.example" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://client.example",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });
});
