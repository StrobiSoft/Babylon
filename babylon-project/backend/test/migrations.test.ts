import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../src/database.js';
import { runMigrations } from '../src/migrations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('transactional migration failure', () => {
  const admin = new PostgresDatabase(databaseUrl ?? 'postgresql://unused');
  const createdDatabases: string[] = [];

  afterAll(async () => {
    for (const name of createdDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin.close();
  });

  it('rolls back every statement in a failed migration', async () => {
    const name = `babylon_migration_${Date.now()}`;
    createdDatabases.push(name);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl ?? 'postgresql://unused');
    url.pathname = `/${name}`;
    const database = new PostgresDatabase(url.toString());
    const directory = await mkdtemp(join(tmpdir(), 'babylon-migrations-'));
    await writeFile(
      join(directory, '001_ok.sql'),
      'CREATE TABLE stable_table(id integer PRIMARY KEY);',
    );
    await writeFile(
      join(directory, '002_fails.sql'),
      'CREATE TABLE must_rollback(id integer); SELECT missing_function();',
    );
    await expect(runMigrations(database, directory)).rejects.toBeTruthy();
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    expect(tables.rows.map((row) => row.table_name)).toContain('stable_table');
    expect(tables.rows.map((row) => row.table_name)).not.toContain('must_rollback');
    await database.close();
  });
});
