import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

const enabled = process.env.RUN_SOFT_CHAT_LOAD === '1';
const suite = enabled ? describe : describe.skip;
const requestedStages = (process.env.SOFT_CHAT_LOAD_STAGES ?? '100,500,1000,2000,5000')
  .split(',')
  .map(Number);
const maxErrorRate = Number(process.env.SOFT_CHAT_LOAD_MAX_ERROR_RATE ?? '0.01');
const maxP99Ms = Number(process.env.SOFT_CHAT_LOAD_MAX_P99_MS ?? '2000');
const outputRoot = resolve(process.env.SOFT_CHAT_LOAD_OUTPUT_DIR ?? 'load-results/soft-chat');

type ErrorCounts = Record<string, number>;
interface StageResult {
  requestedConcurrentClients: number;
  authenticatedClients: number;
  messagesAttempted: number;
  messagesSucceeded: number;
  messagesFailed: number;
  ackSucceeded: number;
  ackFailed: number;
  throughputMessagesPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number };
  duplicateDeliveries: number;
  exactlyOnceViolations: number;
  errors: ErrorCounts;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: 'PASS' | 'FAIL';
  reason: string;
}

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when RUN_SOFT_CHAT_LOAD=1`);
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
const percentile = (sorted: number[], fraction: number) =>
  sorted.length === 0 ? 0 : sorted[Math.ceil(sorted.length * fraction) - 1]!;
const increment = (counts: ErrorCounts, name: string) => (counts[name] = (counts[name] ?? 0) + 1);
const decodeQuotedPrintable = (value: string) =>
  value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

suite('Soft Chat production-path capacity', () => {
  let adminDatabase: PostgresDatabase;
  let database: PostgresDatabase;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let smtp: SMTPServer;
  let callbackServer: Server;
  let browser: Browser;
  let baseUrl: string;
  let isolatedDatabaseUrl: string;
  let schema: string;
  let latestMail = '';
  const callbacks: ((value: { code: string; state: string }) => void)[] = [];

  beforeAll(async () => {
    const adminUrl = required('TEST_DATABASE_URL');
    const parsed = new URL(adminUrl);
    if (
      !['localhost', '127.0.0.1'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_LOAD_DATABASE !== '1'
    ) {
      throw new Error(
        'Refusing a non-loopback load database. Set ALLOW_REMOTE_LOAD_DATABASE=1 only for a dedicated test PostgreSQL instance.',
      );
    }
    schema = `soft_chat_load_${Date.now()}_${process.pid}`;
    adminDatabase = new PostgresDatabase(adminUrl);
    await adminDatabase.query(`CREATE SCHEMA ${schema}`);
    parsed.searchParams.set('options', `-csearch_path=${schema}`);
    isolatedDatabaseUrl = parsed.toString();
    database = new PostgresDatabase(isolatedDatabaseUrl);
    await runMigrations(database, resolve('backend/migrations'));

    const backendPort = await freePort();
    const smtpPort = await freePort();
    baseUrl = `http://localhost:${backendPort}`;
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
    const config = testConfig(isolatedDatabaseUrl);
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
      executablePath: required('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),
      headless: true,
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (callbackServer) await new Promise<void>((done) => callbackServer.close(() => done()));
    if (smtp) await new Promise<void>((done) => smtp.close(() => done()));
    await app?.close();
    await database?.close();
    if (adminDatabase && schema) await adminDatabase.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminDatabase?.close();
  });

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as {
      data?: Record<string, unknown>;
      error?: { code?: string };
    };
    if (!response.ok) throw new Error(`HTTP_${response.status}_${body.error?.code ?? 'UNKNOWN'}`);
    return body.data ?? {};
  }

  async function register(email: string, index: number) {
    const state = String.fromCharCode(97 + index).repeat(43);
    const verifier = String.fromCharCode(65 + index).repeat(64);
    const config = testConfig(isolatedDatabaseUrl);
    const invitation = await api('/api/v1/admin/invitations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.adminBootstrapToken}`,
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
        deviceName: `Load harness ${index}`,
        platform: 'linux',
        clientDeviceKey: `load-harness-device-key-${index}-000000000000000000`,
      }),
    });
    await context.close();
    return {
      accessToken: tokens.accessToken as string,
      userId: (await authorized('/api/v1/me', tokens.accessToken as string)).id as string,
    };
  }

  async function authorized(path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('content-type', 'application/json');
    return api(path, {
      ...init,
      headers,
    });
  }

  async function runStage(
    count: number,
    sender: { accessToken: string; userId: string },
    recipient: { accessToken: string; userId: string },
  ): Promise<StageResult> {
    const started = new Date();
    const errors: ErrorCounts = {};
    const latencies = new Map<string, number>();
    const startedMessages = new Map<string, number>();
    const expectedPayloads = new Map<string, string>();
    const seen = new Set<string>();
    let authenticatedClients = 0;
    let messagesSucceeded = 0;
    let ackSucceeded = 0;
    let duplicateDeliveries = 0;
    let contentViolations = 0;
    let unhealthy = false;
    const healthTimer = setInterval(() => {
      void fetch(`${baseUrl}/health/ready`)
        .then((response) => {
          if (!response.ok) unhealthy = true;
        })
        .catch(() => (unhealthy = true));
    }, 1000);

    await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        try {
          await authorized(
            '/api/v1/me',
            index % 2 === 0 ? sender.accessToken : recipient.accessToken,
          );
          authenticatedClients += 1;
        } catch (error) {
          increment(errors, `authentication:${String(error)}`);
        }
      }),
    );

    const requestIds = Array.from({ length: authenticatedClients }, () => randomUUID());
    await Promise.all(
      requestIds.map(async (requestId, index) => {
        startedMessages.set(requestId, performance.now());
        const text =
          index % 3 === 0
            ? 'Pepper load ordinary text'
            : index % 3 === 1
              ? '🫡👩🏽‍💻'
              : 'Pepper load Hello 🌍!';
        const payload = Buffer.from(text, 'utf8').toString('base64');
        expectedPayloads.set(requestId, payload);
        try {
          await authorized('/api/v1/messages', sender.accessToken, {
            method: 'POST',
            body: JSON.stringify({
              requestId,
              recipientId: recipient.userId,
              payloadFormat: 'transport-v1',
              payload,
            }),
          });
          messagesSucceeded += 1;
        } catch (error) {
          increment(errors, `send:${String(error)}`);
        }
      }),
    );

    while (ackSucceeded < messagesSucceeded && !unhealthy) {
      let items: Record<string, unknown>[];
      try {
        const pending = await authorized(
          '/api/v1/messages/pending?limit=100',
          recipient.accessToken,
        );
        items = (pending.items as Record<string, unknown>[] | undefined) ?? [];
      } catch (error) {
        increment(errors, `receive:${String(error)}`);
        break;
      }
      if (items.length === 0) break;
      await Promise.all(
        items.map(async (item) => {
          const requestId = item.requestId as string;
          if (seen.has(requestId)) duplicateDeliveries += 1;
          seen.add(requestId);
          if (item.payload !== expectedPayloads.get(requestId)) {
            increment(errors, 'receive:PAYLOAD_ALTERED');
            contentViolations += 1;
          }
          try {
            await authorized(`/api/v1/messages/${requestId}/ack`, recipient.accessToken, {
              method: 'POST',
              body: JSON.stringify({ senderId: sender.userId }),
            });
            if (!latencies.has(requestId)) {
              ackSucceeded += 1;
              latencies.set(requestId, performance.now() - startedMessages.get(requestId)!);
            }
          } catch (error) {
            increment(errors, `ack:${String(error)}`);
          }
        }),
      );
    }
    clearInterval(healthTimer);
    const finished = new Date();
    const durationMs = finished.getTime() - started.getTime();
    const sorted = [...latencies.values()].sort((a, b) => a - b);
    const messagesFailed = authenticatedClients - messagesSucceeded;
    const ackFailed = messagesSucceeded - ackSucceeded;
    const errorRate =
      (messagesFailed + ackFailed) / Math.max(1, authenticatedClients + messagesSucceeded);
    const p99 = percentile(sorted, 0.99);
    const authFailureRate = (count - authenticatedClients) / count;
    const failures: string[] = [];
    if (unhealthy) failures.push('backend health check failed');
    if (authFailureRate > maxErrorRate)
      failures.push(
        `authentication failure rate ${(authFailureRate * 100).toFixed(2)}% exceeded ${(maxErrorRate * 100).toFixed(2)}%`,
      );
    if (errorRate > maxErrorRate)
      failures.push(
        `message/ACK error rate ${(errorRate * 100).toFixed(2)}% exceeded ${(maxErrorRate * 100).toFixed(2)}%`,
      );
    if (p99 > maxP99Ms) failures.push(`p99 ${p99.toFixed(1)}ms exceeded ${maxP99Ms}ms`);
    if (duplicateDeliveries > 0)
      failures.push(`${duplicateDeliveries} duplicate deliveries observed`);
    if (contentViolations > 0) failures.push(`${contentViolations} altered payloads observed`);
    return {
      requestedConcurrentClients: count,
      authenticatedClients,
      messagesAttempted: authenticatedClients,
      messagesSucceeded,
      messagesFailed,
      ackSucceeded,
      ackFailed,
      throughputMessagesPerSecond: Number(
        (ackSucceeded / Math.max(0.001, durationMs / 1000)).toFixed(2),
      ),
      latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99 },
      duplicateDeliveries,
      exactlyOnceViolations: duplicateDeliveries + contentViolations,
      errors,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs,
      result: failures.length === 0 ? 'PASS' : 'FAIL',
      reason: failures.join('; ') || 'all thresholds satisfied',
    };
  }

  it(
    'ramps virtual authenticated clients and stops conservatively',
    async () => {
      const runStarted = new Date();
      const runId = runStarted.toISOString().replaceAll(':', '-').replaceAll('.', '-');
      const sender = await register(`load-sender-${runId}@example.test`, 0);
      const recipient = await register(`load-recipient-${runId}@example.test`, 1);
      const stages: StageResult[] = [];
      for (const requested of requestedStages) {
        const result = await runStage(requested, sender, recipient);
        stages.push(result);
        if (result.result === 'FAIL') break;
      }
      const report = {
        harness: 'Babylon Soft Chat production delivery/ACK capacity',
        startedAt: runStarted.toISOString(),
        finishedAt: new Date().toISOString(),
        databaseIsolation: `ephemeral PostgreSQL schema ${schema} (dropped after run)`,
        clientModel:
          'virtual HTTP clients sharing two accounts authenticated by real invitation/email/WebAuthn/PKCE exchange',
        thresholds: { maxErrorRate, maxP99Ms },
        requestedStages,
        stages,
        stopReason:
          stages.at(-1)?.result === 'FAIL'
            ? stages.at(-1)!.reason
            : 'all requested stages completed',
      };
      await mkdir(outputRoot, { recursive: true });
      const base = resolve(outputRoot, `soft-chat-load-${runId}`);
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      const header =
        'started_at,finished_at,requested_clients,authenticated_clients,messages_attempted,messages_succeeded,messages_failed,ack_succeeded,ack_failed,throughput_messages_per_second,p50_ms,p95_ms,p99_ms,duplicates,exactly_once_violations,duration_ms,result,reason\n';
      const csv = stages
        .map((stage) =>
          [
            stage.startedAt,
            stage.finishedAt,
            stage.requestedConcurrentClients,
            stage.authenticatedClients,
            stage.messagesAttempted,
            stage.messagesSucceeded,
            stage.messagesFailed,
            stage.ackSucceeded,
            stage.ackFailed,
            stage.throughputMessagesPerSecond,
            stage.latencyMs.p50,
            stage.latencyMs.p95,
            stage.latencyMs.p99,
            stage.duplicateDeliveries,
            stage.exactlyOnceViolations,
            stage.durationMs,
            stage.result,
            JSON.stringify(stage.reason),
          ].join(','),
        )
        .join('\n');
      await writeFile(`${base}.csv`, `${header}${csv}\n`);
      const summary = stages
        .map(
          (stage) =>
            `${stage.result} ${stage.requestedConcurrentClients} clients: ${stage.ackSucceeded}/${stage.messagesAttempted} delivered+ACK, ${stage.throughputMessagesPerSecond} msg/s, p99 ${stage.latencyMs.p99.toFixed(1)}ms — ${stage.reason}`,
        )
        .join('\n');
      await writeFile(
        `${base}.txt`,
        `Babylon Soft Chat load run ${runStarted.toISOString()}\n${summary}\nStop: ${report.stopReason}\n`,
      );
      expect(stages.length).toBeGreaterThan(0);
    },
    30 * 60_000,
  );
});
