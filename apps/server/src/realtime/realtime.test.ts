import { describe, expect, it, vi } from "vitest";
import { createAuthenticationMiddleware } from "./middleware/authentication.js";

describe("realtime authentication", () => {
  it("authenticates a socket from the session cookie", async () => {
    const authenticated = {
      user: {
        id: "user-1",
        displayName: "Guest",
        isGuest: true,
        createdAt: new Date().toISOString(),
      },
      session: {
        id: "session-1",
        userId: "user-1",
        tokenHash: "hash",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const authService = {
      sessionCookie: "catan_session",
      authenticate: vi.fn().mockResolvedValue(authenticated),
    };
    const data: { authenticated?: unknown } = {};
    const socket = {
      handshake: {
        headers: {
          cookie: "other=value; catan_session=token%2Bvalue",
        },
      },
      data,
    };
    const next = vi.fn();

    await createAuthenticationMiddleware(authService as never)(
      socket as never,
      next,
    );

    expect(authService.authenticate).toHaveBeenCalledWith("token+value");
    expect(socket.data.authenticated).toEqual(authenticated);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects sockets without a valid session", async () => {
    const authService = {
      sessionCookie: "catan_session",
      authenticate: vi.fn().mockResolvedValue(undefined),
    };
    const socket = {
      handshake: { headers: {} },
      data: {} as { authenticated?: unknown },
    };
    const next = vi.fn();

    await createAuthenticationMiddleware(authService as never)(
      socket as never,
      next,
    );

    expect(authService.authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: "AUTHENTICATION_REQUIRED" }),
    );
  });
});
