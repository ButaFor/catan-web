import type { RulesCodec } from "../db/contracts/game.js";
import type { RoomRules } from "./room.types.js";

export const roomRulesCodec: RulesCodec<RoomRules> = {
  parseRules(version, value): RoomRules {
    if (version !== 1 || !isEmptyObject(value)) {
      throw new Error("Unsupported room rules");
    }
    return {};
  },
};

function isEmptyObject(value: unknown): value is Record<string, never> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
