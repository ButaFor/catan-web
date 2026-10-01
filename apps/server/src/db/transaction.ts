import type { Pool, PoolClient } from "pg";
import { databaseOperation } from "./errors.js";
export function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return databaseOperation(async () => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  });
}
