import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService } from './auth-service.js';
import { MessageDeliveryService } from './message-delivery.js';
import { loadConfig } from './config.js';
import { secureRandom, systemClock } from './crypto.js';
import { PostgresDatabase } from './database.js';
import { SmtpMailer } from './mailer.js';
import { runMigrations } from './migrations.js';
import { buildServer } from './server.js';
import { resolveSecretEnvironment } from './secrets.js';
import { SimpleWebAuthnProvider } from './webauthn.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig(await resolveSecretEnvironment(process.env));
  const database = new PostgresDatabase(config.databaseUrl);
  await runMigrations(database, resolve(currentDirectory, '../migrations'));
  const service = new AuthService(
    database,
    config,
    systemClock,
    secureRandom,
    new SmtpMailer(config),
    new SimpleWebAuthnProvider(config),
  );
  const delivery = new MessageDeliveryService(database, systemClock);
  const app = await buildServer({ config, database, service, delivery });
  const cleanupTimer = setInterval(() => {
    void Promise.all([service.cleanup(), delivery.cleanup()]).catch((error: unknown) => {
      app.log.error({ err: error }, 'Cleanup failed');
    });
  }, config.cleanupIntervalSeconds * 1000);
  cleanupTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    clearInterval(cleanupTimer);
    await app.close();
    await database.close();
  };
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  await app.listen({ host: config.httpHost, port: config.httpPort });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup failure';
  process.stderr.write(`Babylon backend failed to start: ${message}\n`);
  process.exitCode = 1;
});
