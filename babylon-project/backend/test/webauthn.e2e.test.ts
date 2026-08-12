import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';
import type { Config } from '../src/config.js';
import { pkceChallenge, secureRandom, systemClock } from '../src/crypto.js';
import { PostgresDatabase } from '../src/database.js';
import { SmtpMailer } from '../src/mailer.js';
import { runMigrations } from '../src/migrations.js';
import { buildServer } from '../src/server.js';
import { SimpleWebAuthnProvider } from '../src/webauthn.js';
import { state, testConfig, verifier } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const enabled = Boolean(databaseUrl && executablePath && process.env.RUN_WEBAUTHN_E2E === '1');
const describeE2E = enabled ? describe : describe.skip;

async function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

describeE2E('real browser WebAuthn vertical slice', () => {
  let database: PostgresDatabase;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let smtp: SMTPServer;
  let callbackServer: Server;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;
  let backendPort: number;
  let config: Config;
  let smtpMessage = '';
  const callbacks: ((value: { code: string; state: string }) => void)[] = [];

  beforeAll(async () => {
    backendPort = await freePort('::1');
    const smtpPort = await freePort();
    baseUrl = `http://localhost:${backendPort}`;
    database = new PostgresDatabase(databaseUrl ?? 'postgresql://unused');
    await runMigrations(
      database,
      resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'),
    );
    await database.query('TRUNCATE users,invitations,audit_log RESTART IDENTITY CASCADE');
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        smtpMessage = '';
        stream.on('data', (chunk: Buffer) => (smtpMessage += chunk.toString('utf8')));
        stream.on('end', () => callback());
      },
    });
    await new Promise<void>((resolveListen, reject) => {
      smtp.once('error', reject);
      smtp.listen(smtpPort, '127.0.0.1', resolveListen);
    });
    config = testConfig(databaseUrl ?? 'postgresql://unused');
    config.publicBackendUrl = baseUrl;
    config.webauthnOrigins = [baseUrl];
    config.smtpPort = smtpPort;
    const service = new AuthService(
      database,
      config,
      systemClock,
      secureRandom,
      new SmtpMailer(config),
      new SimpleWebAuthnProvider(config),
    );
    app = await buildServer({ config, database, service });
    await app.listen({ host: '::1', port: backendPort });

    callbackServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1:43821');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      response.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'no-referrer' });
      response.end('<!doctype html><p>Visszatérhetsz a Babylon teszthez.</p>');
      const resolveCallback = callbacks.shift();
      if (code && returnedState && resolveCallback) resolveCallback({ code, state: returnedState });
    });
    await new Promise<void>((resolveListen, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(43821, '127.0.0.1', resolveListen);
    });
    browser = await chromium.launch({ executablePath: executablePath ?? '', headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolveClose) => callbackServer?.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => smtp?.close(() => resolveClose()));
    await app?.close();
    await database?.close();
  });

  const callback = () =>
    new Promise<{ code: string; state: string }>((resolveCallback) =>
      callbacks.push(resolveCallback),
    );

  async function waitForCallback(
    result: Promise<{ code: string; state: string }>,
    label: string,
  ): Promise<{ code: string; state: string }> {
    return Promise.race([
      result,
      page.waitForTimeout(5_000).then(async () => {
        throw new Error(
          `${label} did not redirect: ${await page.locator('#status').textContent()}`,
        );
      }),
    ]);
  }

  async function api(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body =
      response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
    return {
      status: response.status,
      data: (body.data ?? body.error ?? {}) as Record<string, unknown>,
    };
  }

  async function restartBackend(): Promise<void> {
    await app.close();
    await database.close();
    database = new PostgresDatabase(databaseUrl ?? 'postgresql://unused');
    const service = new AuthService(
      database,
      config,
      systemClock,
      secureRandom,
      new SmtpMailer(config),
      new SimpleWebAuthnProvider(config),
    );
    app = await buildServer({ config, database, service });
    await app.listen({ host: '::1', port: backendPort });
  }

  async function start(
    operation: 'register' | 'authenticate',
    flowState: string,
    flowVerifier: string,
  ) {
    return api('/api/v1/native-auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'babylon-flutter',
        returnProfile: 'desktop-local',
        pkceChallenge: pkceChallenge(flowVerifier),
        state: flowState,
        operation,
      }),
    });
  }

  async function browserLogin(flowState: string, flowVerifier: string) {
    const started = await start('authenticate', flowState, flowVerifier);
    expect(started.status).toBe(201);
    const received = callback();
    await page.goto(started.data.browserUrl as string);
    await page.locator('#action').click();
    const returned = await waitForCallback(received, 'authentication');
    expect(returned.state).toBe(flowState);
    const exchange = await api('/api/v1/native-auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        returnCode: returned.code,
        clientId: 'babylon-flutter',
        pkceVerifier: flowVerifier,
        state: flowState,
        deviceName: 'Virtuális Chromium',
        platform: 'windows',
        clientDeviceKey: 'e2e-device-key-that-is-long-enough-000000000',
      }),
    });
    expect(exchange.status).toBe(200);
    return exchange.data as { accessToken: string; refreshToken: string };
  }

  it('completes invitation, e-mail, passkey, session, rotation and device revocation', async () => {
    const live = await api('/health/live');
    const ready = await api('/health/ready');
    expect(live).toEqual({ status: 200, data: { status: 'live' } });
    expect(ready).toEqual({ status: 200, data: { status: 'ready' } });

    const invitation = await api('/api/v1/admin/invitations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testConfig(databaseUrl ?? '').adminBootstrapToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'e2e@example.test' }),
    });
    expect(invitation.status).toBe(201);
    const started = await start('register', state, verifier);
    expect(started.status).toBe(201);
    const accepted = await api('/api/v1/onboarding/accept-invitation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'e2e@example.test',
        invitationCode: invitation.data.invitationCode,
        transactionToken: started.data.transactionToken,
        state,
      }),
    });
    expect(accepted.status).toBe(202);
    const decodedMail = decodeQuotedPrintable(smtpMessage);
    const verificationLink = /http:\/\/localhost:\d+\/verify-email#[^\s]+/.exec(decodedMail)?.[0];
    expect(verificationLink).toBeTruthy();
    const registrationCallback = callback();
    await page.goto(verificationLink!);
    await page.locator('#action').click();
    const returned = await waitForCallback(registrationCallback, 'registration');
    const registrationExchange = await api('/api/v1/native-auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        returnCode: returned.code,
        clientId: 'babylon-flutter',
        pkceVerifier: verifier,
        state,
        deviceName: 'Virtuális Chromium',
        platform: 'windows',
        clientDeviceKey: 'e2e-device-key-that-is-long-enough-000000000',
      }),
    });
    expect(registrationExchange.status).toBe(200);
    const firstAccess = registrationExchange.data.accessToken as string;
    expect(
      (await api('/api/v1/me', { headers: { authorization: `Bearer ${firstAccess}` } })).status,
    ).toBe(200);
    const persistedRows = await database.query<{
      users: string;
      devices: string;
      sessions: string;
    }>(
      `SELECT
         (SELECT count(*) FROM users)::text AS users,
         (SELECT count(*) FROM devices)::text AS devices,
         (SELECT count(*) FROM sessions)::text AS sessions`,
    );
    expect(persistedRows.rows[0]).toEqual({ users: '1', devices: '1', sessions: '1' });

    await restartBackend();
    expect(await api('/health/ready')).toEqual({ status: 200, data: { status: 'ready' } });
    expect(
      (await api('/api/v1/me', { headers: { authorization: `Bearer ${firstAccess}` } })).status,
    ).toBe(200);
    expect(
      (
        await api('/api/v1/sessions/logout', {
          method: 'POST',
          headers: { authorization: `Bearer ${firstAccess}`, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(204);

    const loginState = 'l'.repeat(43);
    const loginVerifier = 'b'.repeat(64);
    const login = await browserLogin(loginState, loginVerifier);
    const refresh = await api('/api/v1/sessions/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(refresh.status).toBe(200);
    expect(refresh.data.refreshToken).not.toBe(login.refreshToken);
    expect(
      (
        await api('/api/v1/sessions/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: login.refreshToken }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await api('/api/v1/me', {
          headers: { authorization: `Bearer ${refresh.data.accessToken as string}` },
        })
      ).status,
    ).toBe(401);

    const finalLogin = await browserLogin('z'.repeat(43), 'c'.repeat(64));
    const devices = await api('/api/v1/devices', {
      headers: { authorization: `Bearer ${finalLogin.accessToken}` },
    });
    expect(devices.status).toBe(200);
    const items = devices.data.items as { id: string }[];
    expect(items).toHaveLength(1);
    const deviceId = items[0]?.id;
    expect(
      (
        await api(`/api/v1/devices/${deviceId}`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${finalLogin.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'Átnevezett eszköz' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(`/api/v1/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${finalLogin.accessToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (await api('/api/v1/me', { headers: { authorization: `Bearer ${finalLogin.accessToken}` } }))
        .status,
    ).toBe(401);
  }, 60_000);
});
