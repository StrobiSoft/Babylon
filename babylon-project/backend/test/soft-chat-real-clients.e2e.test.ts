import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';
import { pkceChallenge, secureRandom, systemClock } from '../src/crypto.js';
import { PostgresDatabase } from '../src/database.js';
import { SmtpMailer } from '../src/mailer.js';
import { MessageDeliveryService } from '../src/message-delivery.js';
import { runMigrations } from '../src/migrations.js';
import { buildServer } from '../src/server.js';
import { SimpleWebAuthnProvider } from '../src/webauthn.js';
import { testConfig } from './helpers.js';

const enabled = process.env.RUN_REAL_CLIENT_HARNESS === '1';
const suite = enabled ? describe : describe.skip;
const databaseUrl = process.env.TEST_DATABASE_URL;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const flutterPath = process.env.FLUTTER_EXECUTABLE;
const execFileAsync = promisify(execFile);

const required = (name: string, value: string | undefined) => {
  if (!value) throw new Error(`${name} is required when RUN_REAL_CLIENT_HARNESS=1`);
  return value;
};
const freePort = () =>
  new Promise<number>((done, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No free port'));
      server.close(() => done(address.port));
    });
  });
const decodeQuotedPrintable = (value: string) =>
  value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

suite('two real production clients exchange Soft Chat messages', () => {
  let database: PostgresDatabase;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let smtp: SMTPServer;
  let callbackServer: Server;
  let browser: Browser;
  let baseUrl: string;
  let root: string;
  let latestMail = '';
  const callbacks: ((value: { code: string; state: string }) => void)[] = [];

  beforeAll(async () => {
    const db = required('TEST_DATABASE_URL', databaseUrl);
    const backendPort = await freePort();
    const smtpPort = await freePort();
    baseUrl = `http://localhost:${backendPort}`;
    root = await mkdtemp(join(tmpdir(), 'babylon-real-clients-'));
    database = new PostgresDatabase(db);
    await runMigrations(database, resolve('backend/migrations'));
    await database.query('TRUNCATE users,invitations,audit_log RESTART IDENTITY CASCADE');
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        latestMail = '';
        stream.on('data', (chunk: Buffer) => (latestMail += chunk.toString('utf8')));
        stream.on('end', () => callback());
      },
    });
    await new Promise<void>((done, reject) => {
      smtp.once('error', reject);
      smtp.listen(smtpPort, '127.0.0.1', done);
    });
    const config = testConfig(db);
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
    app = await buildServer({
      config,
      database,
      service,
      delivery: new MessageDeliveryService(
        database,
        systemClock,
        config.messageDeliveryBindingSecret,
      ),
    });
    await app.listen({ host: '127.0.0.1', port: backendPort });
    callbackServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1:43821');
      response.end('ok');
      const done = callbacks.shift();
      if (done && url.searchParams.get('code') && url.searchParams.get('state'))
        done({ code: url.searchParams.get('code')!, state: url.searchParams.get('state')! });
    });
    await new Promise<void>((done, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(43821, '127.0.0.1', done);
    });
    browser = await chromium.launch({
      executablePath: required('PLAYWRIGHT_CHROMIUM_EXECUTABLE', chromiumPath),
      headless: true,
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (callbackServer) await new Promise<void>((done) => callbackServer.close(() => done()));
    if (smtp) await new Promise<void>((done) => smtp.close(() => done()));
    await app?.close();
    await database?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(response.ok).toBe(true);
    return body.data;
  }

  async function register(email: string, index: number) {
    const state = String.fromCharCode(97 + index).repeat(43);
    const verifier = String.fromCharCode(65 + index).repeat(64);
    const invitation = await api('/api/v1/admin/invitations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testConfig(databaseUrl!).adminBootstrapToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    const started = await api('/api/v1/native-auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'babylon-flutter',
        returnProfile: 'desktop-local',
        pkceChallenge: pkceChallenge(verifier),
        state,
        operation: 'register',
      }),
    });
    await api('/api/v1/onboarding/accept-invitation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        invitationCode: invitation.invitationCode,
        transactionToken: started.transactionToken,
        state,
      }),
    });
    const link = /http:\/\/localhost:\d+\/verify-email#[^\s]+/.exec(
      decodeQuotedPrintable(latestMail),
    )?.[0];
    expect(link).toBeTruthy();
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
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
    const callback = new Promise<{ code: string; state: string }>((done) => callbacks.push(done));
    await page.goto(link!);
    await page.locator('#action').click();
    const returned = await callback;
    const tokens = await api('/api/v1/native-auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        returnCode: returned.code,
        clientId: 'babylon-flutter',
        pkceVerifier: verifier,
        state,
        deviceName: `Harness ${index}`,
        platform: 'linux',
        clientDeviceKey: `real-client-device-key-${index}-000000000000000000`,
      }),
    });
    await context.close();
    return tokens.refreshToken as string;
  }

  it('uses real authentication, delivery, ACK and persistent isolated stores', async () => {
    const tokenA = await register('client-a@example.test', 0);
    const tokenB = await register('client-b@example.test', 1);
    await execFileAsync(
      required('FLUTTER_EXECUTABLE', flutterPath),
      ['test', 'test/real_client_harness_test.dart', '--reporter=expanded'],
      {
        cwd: resolve('client'),
        env: {
          ...process.env,
          RUN_REAL_CLIENT_HARNESS: '1',
          BABYLON_BASE_URL: baseUrl,
          BABYLON_CLIENT_STORE_ROOT: root,
          BABYLON_CLIENT_A_REFRESH_TOKEN: tokenA,
          BABYLON_CLIENT_B_REFRESH_TOKEN: tokenB,
        },
      },
    );
    const translations = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM translation_pending_jobs',
    );
    expect(translations.rows[0]?.count).toBe('0');
  }, 90_000);
});
