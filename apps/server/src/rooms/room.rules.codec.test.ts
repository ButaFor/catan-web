import { describe, expect, it } from "vitest";
import { roomRulesCodec } from "./room.rules.codec.js";

describe("room rules codec", () => {
  it("accepts the current empty room rules schema", () => {
    expect(roomRulesCodec.parseRules(1, {})).toEqual({});
  });

  it("rejects unsupported versions and non-empty rules", () => {
    expect(() => roomRulesCodec.parseRules(2, {})).toThrow();
    expect(() => roomRulesCodec.parseRules(1, { target: 10 })).toThrow();
  });
});
