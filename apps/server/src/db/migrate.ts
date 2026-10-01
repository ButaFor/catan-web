import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createPool } from "./pool.js";

export async function migrate(pool: Pool, directory = fileURLToPath(new URL("../../migrations/", import.meta.url))): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error("No SQL migrations found");
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  let broken = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext(current_database()), hashtext(current_schema() || ':catan-migrations'))");
    locked = true;
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const existing = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations ORDER BY name");
    if (existing.rows.some((row) => !files.includes(row.name))) throw new Error("Applied migration is missing from disk");
    for (const name of files) {
      const sql = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
      const previous = existing.rows.find((row) => row.name === name);
      if (previous) {
        if (previous.checksum !== checksum) throw new Error("Applied migration has changed: " + name);
        continue;
      }
      if (existing.rows.some((row) => row.name > name)) throw new Error("Cannot insert a migration before an applied migration");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { broken = true; }
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      if (locked && !broken) await client.query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext(current_schema() || ':catan-migrations'))");
    } catch (error) {
      broken = true;
      throw error;
    } finally { client.release(broken); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required by the migration CLI");
  const pool = createPool({ connectionString });
  try { console.log("Applied migrations:", await migrate(pool)); }
  finally { await pool.end(); }
}
