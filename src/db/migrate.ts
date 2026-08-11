import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from './client';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

export async function migrate(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await sql`SELECT id FROM schema_migrations`).map((r) => r.id),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Multiple statements must run as a single transaction
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx`INSERT INTO schema_migrations (id) VALUES (${file})`;
    });
    console.log(`[DB] Applied migration ${file}`);
  }
}

if (import.meta.main) {
  await migrate();
  await sql.end();
}
