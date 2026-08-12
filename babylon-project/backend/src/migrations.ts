import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './types.js';

export async function runMigrations(database: Database, directory: string): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = await readFile(join(directory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await database.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = $1',
      [file],
    );
    if (existing.rowCount === 1) {
      if (existing.rows[0]?.checksum !== checksum) {
        throw new Error(`Migration checksum mismatch: ${file}`);
      }
      continue;
    }
    await database.transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
    });
  }
}
