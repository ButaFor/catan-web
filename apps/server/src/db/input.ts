import { z } from "zod";
import { RepositoryError, fail } from "./repository.errors.js";

export function uuid(value: string): string {
  if (!z.uuid().safeParse(value).success) fail("INVALID_PERSISTENCE_INPUT", "Expected a UUID");
  return value;
}
export function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) fail("INVALID_PERSISTENCE_INPUT", "Expected a positive PostgreSQL integer");
  return value;
}
export function pageLimit(value: number): number {
  positive(value);
  if (value > 1000) fail("INVALID_PERSISTENCE_INPUT", "Page size must not exceed 1000");
  return value;
}
export function jsonObject(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown): boolean {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    seen.add(item);
    const valid = (Array.isArray(item) ? Array.from(item) : Object.values(item)).every(visit);
    seen.delete(item);
    return valid;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object" || !visit(value)) {
    fail("INVALID_PERSISTENCE_INPUT", "Expected a JSON object without unsupported values");
  }
  return JSON.stringify(value);
}
export function parseInput<T>(parser: () => T): T {
  try { return parser(); } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("INVALID_PERSISTENCE_INPUT", "Persistence input failed validation", { cause: error });
  }
}
export function parseStored<T>(parser: () => T): T {
  try { return parser(); } catch (error) {
    if (error instanceof RepositoryError && error.code === "UNSUPPORTED_PERSISTED_VERSION") throw error;
    throw new RepositoryError("INTERNAL_SERVER_ERROR", "Stored data failed validation", { cause: error });
  }
}
