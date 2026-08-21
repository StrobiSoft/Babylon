import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';
import { PostgresDatabase } from '../src/database.js';
import { runMigrations } from '../src/migrations.js';
import { buildServer } from '../src/server.js';
import {
  DeterministicRandom,
  FakeClock,
  FakeWebAuthn,
  MemoryMailer,
  testConfig,
} from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('HTTP API and browser security', () => {
  const database = new PostgresDatabase(databaseUrl ?? 'postgresql://unused');
  const config = testConfig(databaseUrl ?? 'postgresql://unused');
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await runMigrations(
      database,
      resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'),
    );
  });

  beforeEach(async () => {
    if (app) await app.close();
    await database.query('TRUNCATE users,invitations,audit_log RESTART IDENTITY CASCADE');
    const service = new AuthService(
      database,
      config,
      new FakeClock(),
      new DeterministicRandom(),
      new MemoryMailer(),
      new FakeWebAuthn(),
    );
    app = await buildServer({ config, database, service });
  });

  afterAll(async () => {
    if (app) await app.close();
    await database.close();
  });

  it('returns live and ready health responses', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ data: { status: 'live' } });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ data: { status: 'ready' } });
  });

  it('requires the exact admin bearer token', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      payload: { email: 'a@example.test' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: { authorization: `Bearer ${'x'.repeat(40)}` },
      payload: { email: 'a@example.test' },
    });
    const valid = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: { authorization: `Bearer ${config.adminBootstrapToken}` },
      payload: { email: 'a@example.test' },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(valid.statusCode).toBe(201);
    expect(valid.json().data.invitationCode).toHaveLength(43);
  });

  it('rejects malformed JSON, unknown fields, wrong types, and oversized bodies', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding/resume',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding/resume',
      payload: { email: 'a@example.test', admin: true },
    });
    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding/resume',
      payload: { email: 42 },
    });
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding/resume',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: `${'a'.repeat(100_000)}@example.test` }),
    });
    expect(malformed.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(wrongType.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).not.toContain('a'.repeat(100));
  });

  it('adds security headers and enforces the explicit CORS allowlist', async () => {
    const page = await app.inject({
      method: 'GET',
      url: '/auth/authenticate',
      headers: { origin: 'http://localhost:4200' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    const sameOrigin = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: new URL(config.publicBackendUrl).origin },
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers['access-control-allow-origin']).toBe(
      new URL(config.publicBackendUrl).origin,
    );
    const denied = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('stack');
  });

  it('serves functional WebAuthn pages without browser storage or inline scripts', async () => {
    for (const url of ['/verify-email', '/auth/register', '/auth/authenticate']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('/assets/auth.js');
      expect(response.body).not.toContain('<script>');
    }
    const script = await app.inject({ method: 'GET', url: '/assets/auth.js' });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain('navigator.credentials.create');
    expect(script.body).toContain('navigator.credentials.get');
    expect(script.body).toContain("history.replaceState(null, '', location.pathname)");
    expect(script.body).not.toContain('localStorage');
    expect(script.body).not.toContain('sessionStorage');
    expect(script.body).not.toContain('console.');
  });

  it('rate limits a sensitive endpoint and returns consistent errors with request IDs', async () => {
    const responses = [];
    for (let index = 0; index < 12; index += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/api/v1/onboarding/resume',
          payload: { email: 'unknown@example.test' },
        }),
      );
    }
    expect(responses.some((response) => response.statusCode === 429)).toBe(true);
    const limited = responses.find((response) => response.statusCode === 429);
    expect(limited?.json().error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited?.json().error.requestId).toBeTruthy();
  });
});
