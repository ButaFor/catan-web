import type { Socket } from "socket.io";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import type { AuthService } from "../../auth/auth.service.js";
import { FixedWindowRateLimiter } from "../../auth/auth.rate-limit.js";

declare module "socket.io" {
  interface SocketData {
    authenticated?: AuthenticatedUser;
  }
}

export function createAuthenticationMiddleware(
  authService: AuthService,
  rateLimiter: FixedWindowRateLimiter,
) {
  return async (socket: Socket, next: (error?: Error) => void) => {
    try {
      const result = rateLimiter.consume(`handshake:${socket.handshake.address}`);
      if (!result.allowed) {
        next(new Error("RATE_LIMITED"));
        return;
      }
      const token = readCookie(
        socket.handshake.headers.cookie,
        authService.sessionCookie,
      );
      const authenticated = token
        ? await authService.authenticate(token)
        : undefined;
      if (!authenticated) {
        next(new Error("AUTHENTICATION_REQUIRED"));
        return;
      }
      socket.data.authenticated = authenticated;
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("AUTHENTICATION_FAILED"));
    }
  };
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(item.slice(separator + 1));
  }
  return undefined;
}
