import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSecretEnvironment } from '../src/secrets.js';

describe('secret source abstraction', () => {
  it('prefers explicit environment values over files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babylon-secrets-'));
    const path = join(directory, 'admin');
    await writeFile(path, 'from-file\n');
    const resolved = await resolveSecretEnvironment({
      ADMIN_BOOTSTRAP_TOKEN: 'from-environment',
      ADMIN_BOOTSTRAP_TOKEN_FILE: path,
    });
    expect(resolved.ADMIN_BOOTSTRAP_TOKEN).toBe('from-environment');
  });

  it('loads Docker-style files and systemd credentials without exposing content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babylon-credentials-'));
    await writeFile(join(directory, 'DATABASE_URL'), 'postgresql://test/database\n');
    const adminPath = join(directory, 'bootstrap');
    await writeFile(adminPath, 'file-bootstrap-token\n');
    const resolved = await resolveSecretEnvironment({
      CREDENTIALS_DIRECTORY: directory,
      ADMIN_BOOTSTRAP_TOKEN_FILE: adminPath,
    });
    expect(resolved.DATABASE_URL).toBe('postgresql://test/database');
    expect(resolved.ADMIN_BOOTSTRAP_TOKEN).toBe('file-bootstrap-token');
  });
});
