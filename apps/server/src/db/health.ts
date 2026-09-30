import type { Pool } from "pg";
import { databaseOperation } from "./errors.js";
export async function checkDatabase(pool: Pool): Promise<void> {
  await databaseOperation(() => pool.query("SELECT 1"));
}
