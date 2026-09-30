import { describe, expect, it } from "vitest";
import { databaseError } from "../errors.js";
import { jsonObject, parseStored } from "../input.js";
import { RepositoryError } from "../repository.errors.js";

describe("database boundaries", () => {
  it("maps only recognized uniqueness constraints to application conflicts", () => {
    expect(databaseError({ code: "23505", constraint: "users_email_unique" }).code).toBe("ACCOUNT_CONFLICT");
    const unknown = databaseError({ code: "23505", constraint: "unknown_key", detail: "secret" });
    expect(unknown.code).toBe("INTERNAL_SERVER_ERROR");
    expect(unknown.message).not.toContain("secret");
    expect(unknown).not.toHaveProperty("constraint");
  });
  it("preserves concurrency, unavailable and typed errors", () => {
    for (const code of ["40001", "40P01"]) expect(databaseError({ code }).code).toBe("CONCURRENCY_CONFLICT");
    for (const code of ["08006", "ECONNREFUSED", "57P01"]) expect(databaseError({ code }).code).toBe("DATABASE_UNAVAILABLE");
    const original = new RepositoryError("NOT_FOUND", "Missing game");
    expect(databaseError(original)).toBe(original);
  });
  it("rejects lossy JSON values and accepts finite nested objects", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [cycle, { v: undefined }, { v: NaN }, { v: Infinity }, { v: new Date() }, { v: BigInt(1) }, { v: new Array(2) }, []]) {
      expect(() => jsonObject(value)).toThrow(RepositoryError);
    }
    const value = { nested: [1, null, "ok", { enabled: true }] };
    expect(JSON.parse(jsonObject(value))).toEqual(value);
  });
  it("distinguishes unsupported persisted formats from corrupt persisted data", () => {
    const unsupported = new RepositoryError("UNSUPPORTED_PERSISTED_VERSION", "Version 99");
    expect(() => parseStored(() => { throw unsupported; })).toThrow(unsupported);
    expect(() => parseStored(() => { throw new Error("Invalid shape"); })).toThrow(expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }));
  });
});
