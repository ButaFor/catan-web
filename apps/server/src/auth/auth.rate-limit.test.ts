import { describe, expect, it } from "vitest";
import { AuthRateLimiter } from "./auth.rate-limit.js";

describe("AuthRateLimiter", () => {
  it("limits requests within a fixed window", () => {
    let now = 1_000;
    const limiter = new AuthRateLimiter(2, 10_000, () => now);

    expect(limiter.consume("client").allowed).toBe(true);
    expect(limiter.consume("client").remaining).toBe(0);
    expect(limiter.consume("client")).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 10,
    });

    now += 10_000;
    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("keeps limits independent for different keys", () => {
    const limiter = new AuthRateLimiter(1, 60_000, () => 1_000);

    expect(limiter.consume("first").allowed).toBe(true);
    expect(limiter.consume("first").allowed).toBe(false);
    expect(limiter.consume("second").allowed).toBe(true);
  });
});
