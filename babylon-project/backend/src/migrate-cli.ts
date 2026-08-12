import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { PostgresDatabase } from './database.js';
import { runMigrations } from './migrations.js';

const config = loadConfig(process.env);
const database = new PostgresDatabase(config.databaseUrl);
try {
  await runMigrations(database, resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'));
  process.stdout.write('Migrations applied successfully.\n');
} finally {
  await database.close();
}
