import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const secretNames = ['DATABASE_URL', 'POSTGRES_PASSWORD', 'ADMIN_BOOTSTRAP_TOKEN'] as const;

/**
 * Resolves development environment variables without coupling configuration to one secret store.
 * Precedence: explicit environment value, NAME_FILE, systemd CREDENTIALS_DIRECTORY/NAME.
 */
export async function resolveSecretEnvironment(
  source: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const resolved = { ...source };
  for (const name of secretNames) {
    if (resolved[name]) continue;
    const explicitFile = source[`${name}_FILE`];
    const credentialFile = source['CREDENTIALS_DIRECTORY']
      ? join(source['CREDENTIALS_DIRECTORY'], name)
      : undefined;
    const path = explicitFile ?? credentialFile;
    if (!path) continue;
    const value = (await readFile(path, { encoding: 'utf8', flag: 'r' })).trimEnd();
    if (!value) throw new Error(`Secret file for ${name} is empty`);
    resolved[name] = value;
  }
  return resolved;
}
