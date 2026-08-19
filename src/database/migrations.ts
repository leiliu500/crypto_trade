import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export async function runMigrations(pool: Pool, directory = join(process.cwd(), "database", "migrations")): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const applied = new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const executed: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/i, "");
    if (applied.has(version)) continue;
    const sql = await readFile(join(directory, file), "utf8");
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [version]);
    executed.push(version);
  }
  return executed;
}
