import { Pool } from "pg";
export type DatabaseConfig = { connectionString: string; max?: number; options?: string; onIdleError?: (error: Error) => void };
export function createPool(config: DatabaseConfig): Pool {
  const { onIdleError, ...connection } = config;
  const pool = new Pool({ ...connection, max: config.max ?? 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  // Idle clients may fail independently of a query; do not crash the process or log credentials.
  pool.on("error", (error: Error) => { onIdleError?.(error); });
  return pool;
}
