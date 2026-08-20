import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

describe('communication security acceptance gates', () => {
  it('keeps sensitive authentication content out of platform capture surfaces', async () => {
    const [activity, windowsRunner, app] = await Promise.all([
      source(
        '../../client/android/app/src/main/kotlin/com/babylonproject/babylon_client/MainActivity.kt',
      ),
      source('../../client/windows/runner/win32_window.cpp'),
      source('../../client/lib/src/app.dart'),
    ]);

    expect(activity).toContain('WindowManager.LayoutParams.FLAG_SECURE');
    expect(windowsRunner).toContain('WDA_EXCLUDEFROMCAPTURE');
    expect(windowsRunner).toContain('WDA_MONITOR');
    expect(windowsRunner).toMatch(/if \(!SetWindowDisplayAffinity/);
    expect(app).toContain("Key('privacy-shield')");
  });

  it('keeps retired and unapproved communication capabilities out of the current client', async () => {
    const [manifest, pubspec] = await Promise.all([
      source('../../client/android/app/src/main/AndroidManifest.xml'),
      source('../../client/pubspec.yaml'),
    ]);

    const permissions = [...manifest.matchAll(/<uses-permission[^>]+android:name="([^"]+)"/g)]
      .map((match) => match[1])
      .sort();
    expect(permissions).toEqual(['android.permission.INTERNET']);

    const dependencySection = pubspec
      .split('\ndependencies:\n')[1]
      ?.split('\ndev_dependencies:\n')[0];
    expect(dependencySection).toBeDefined();
    const dependencies = [...(dependencySection ?? '').matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm)]
      .map((match) => match[1])
      .sort();
    expect(dependencies).toEqual([
      'crypto',
      'cryptography',
      'flutter',
      'flutter_localizations',
      'flutter_secure_storage',
      'http',
      'package_info_plus',
      'path_provider',
      'url_launcher',
    ]);
  });

  it('keeps media, location and SMS endpoints out until their gates are implemented', async () => {
    const server = await source('../src/server.ts');
    const routes = [
      ...new Set(
        [...server.matchAll(/app\.(?:get|post|patch|delete)\('([^']+)'/g)].map((match) => match[1]),
      ),
    ].sort();
    expect(routes).toEqual(
      [
        '/api/v1/admin/invitations',
        '/api/v1/admin/users/:id/status',
        '/api/v1/devices',
        '/api/v1/devices/:id',
        '/api/v1/email-verification/confirm',
        '/api/v1/email-verification/resend',
        '/api/v1/me',
        '/api/v1/messages',
        '/api/v1/messages/:requestId',
        '/api/v1/messages/:requestId/ack',
        '/api/v1/messages/pending',
        '/api/v1/native-auth/exchange',
        '/api/v1/native-auth/start',
        '/api/v1/onboarding/accept-invitation',
        '/api/v1/onboarding/resume',
        '/api/v1/passkeys',
        '/api/v1/passkeys/:id',
        '/api/v1/passkeys/add',
        '/api/v1/passkeys/authentication/options',
        '/api/v1/passkeys/authentication/verify',
        '/api/v1/passkeys/registration/options',
        '/api/v1/passkeys/registration/verify',
        '/api/v1/recovery/codes/regenerate',
        '/api/v1/recovery/complete',
        '/api/v1/recovery/start',
        '/api/v1/security-events',
        '/api/v1/sessions',
        '/api/v1/sessions/:id',
        '/api/v1/sessions/logout',
        '/api/v1/sessions/refresh',
        '/api/v1/sessions/revoke-all',
        '/api/v1/sessions/revoke-others',
        '/assets/auth.css',
        '/assets/auth.js',
        '/auth/authenticate',
        '/auth/register',
        '/health/live',
        '/health/ready',
        '/verify-email',
      ].sort(),
    );
  });
});
