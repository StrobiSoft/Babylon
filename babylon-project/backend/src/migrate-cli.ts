import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { resolveSecretEnvironment } from './secrets.js';

const environment = await resolveSecretEnvironment(process.env);
const databaseUrl = environment['DATABASE_URL'];
if (!databaseUrl?.startsWith('postgresql://')) {
  throw new Error('DATABASE_URL must be a postgresql:// URL');
}
const database = new PostgresDatabase(databaseUrl);
try {
  await runMigrations(database, resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'));
  process.stdout.write('Migrations applied successfully.\n');
} finally {
  await database.close();
}
