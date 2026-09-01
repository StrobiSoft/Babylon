import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function environment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/babylon',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '3000',
    PUBLIC_BACKEND_URL: 'http://localhost:3000',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: 'http://localhost:3000',
    ADMIN_BOOTSTRAP_TOKEN: 'a'.repeat(32),
    MESSAGE_DELIVERY_BINDING_SECRET: 'b'.repeat(32),
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    EMAIL_FROM: 'Babylon <test@localhost>',
    ALLOWED_CLIENT_ORIGINS: 'http://localhost:3000',
    RETURN_PROFILES_JSON: JSON.stringify({
      local: { clientId: 'client', uri: 'http://127.0.0.1:43821/callback', development: true },
    }),
  };
}

describe('configuration', () => {
  it('loads a valid environment with secure defaults', () => {
    const config = loadConfig(environment());
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.authActivityWriteThrottleEnabled).toBe(false);
    expect(config.webauthnOrigins).toEqual(['http://localhost:3000']);
    expect(config.returnProfiles.local?.clientId).toBe('client');
  });

  it('enables bounded authentication activity-write throttling only explicitly', () => {
    expect(
      loadConfig({ ...environment(), AUTH_ACTIVITY_WRITE_THROTTLE_ENABLED: '1' })
        .authActivityWriteThrottleEnabled,
    ).toBe(true);
    expect(() =>
      loadConfig({ ...environment(), AUTH_ACTIVITY_WRITE_THROTTLE_ENABLED: 'true' }),
    ).toThrow(/Invalid configuration/);
  });

  it.each([
    'DATABASE_URL',
    'ADMIN_BOOTSTRAP_TOKEN',
    'MESSAGE_DELIVERY_BINDING_SECRET',
    'WEBAUTHN_RP_ID',
    'RETURN_PROFILES_JSON',
  ])('rejects missing or invalid %s without printing values', (name) => {
    const env = environment();
    delete env[name];
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('pass@');
      expect(String(error)).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    }
  });

  it('rejects production HTTP and development callback profiles', () => {
    expect(() => loadConfig({ ...environment(), NODE_ENV: 'production' })).toThrow(
      /HTTPS|production-safe/,
    );
  });

  it('rejects non-loopback HTTP callback URLs', () => {
    const env = environment();
    env.RETURN_PROFILES_JSON = JSON.stringify({
      unsafe: { clientId: 'client', uri: 'http://example.test/callback', development: true },
    });
    expect(() => loadConfig(env)).toThrow(/return profile/);
  });

  it('rejects mismatched RP IDs, origin paths, and non-loopback HTTP origins', () => {
    expect(() => loadConfig({ ...environment(), WEBAUTHN_RP_ID: 'example.test' })).toThrow(
      /WEBAUTHN_RP_ID/,
    );
    expect(() =>
      loadConfig({ ...environment(), WEBAUTHN_ORIGINS: 'https://login.example.test/path' }),
    ).toThrow(/exact origins/);
    expect(() =>
      loadConfig({ ...environment(), ALLOWED_CLIENT_ORIGINS: 'http://client.example.test' }),
    ).toThrow(/HTTPS/);
  });
});
