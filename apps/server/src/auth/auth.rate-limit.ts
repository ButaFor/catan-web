type Window = {
  count: number;
  expiresAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  public constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxRequests) || maxRequests < 1) {
      throw new Error("Rate limit max must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error("Rate limit window must be a positive integer");
    }
  }

  public get limit(): number {
    return this.maxRequests;
  }

  public consume(key: string): RateLimitResult {
    const now = this.now();
    this.removeExpired(now);
    const current = this.windows.get(key);

    if (!current || current.expiresAt <= now) {
      this.windows.set(key, {
        count: 1,
        expiresAt: now + this.windowMs,
      });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
      };
    }

    if (current.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((current.expiresAt - now) / 1000),
        ),
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - current.count,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.expiresAt - now) / 1000),
      ),
    };
  }

  private removeExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}

export class AuthRateLimiter extends FixedWindowRateLimiter {}
