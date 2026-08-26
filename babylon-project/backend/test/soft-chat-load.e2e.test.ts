import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';
import { addSeconds, hash, pkceChallenge, secureRandom, systemClock } from '../src/crypto.js';
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
const comparisonRun = process.env.SOFT_CHAT_LOAD_COMPARISON === '1';
const pollIntervalMs = Number(process.env.SOFT_CHAT_LOAD_POLL_INTERVAL_MS ?? '50');
const requestedPoolMax = Number(process.env.SOFT_CHAT_LOAD_POOL_MAX ?? '20');
const clientRampMs = Number(process.env.SOFT_CHAT_LOAD_CLIENT_RAMP_MS ?? '0');
const warmupMs = Number(process.env.SOFT_CHAT_LOAD_WARMUP_MS ?? '0');
const separateServerProcess = process.env.SOFT_CHAT_LOAD_SEPARATE_SERVER === '1';
const requestedModes = (process.env.SOFT_CHAT_LOAD_MODES ?? 'shared-phased,independent-streaming')
  .split(',')
  .map((value) => value.trim()) as LoadMode[];

type LoadMode = 'shared-phased' | 'independent-streaming';
interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
interface PoolSample {
  at: string;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}
interface PostgresDiagnostics {
  activityAvailable: boolean;
  activityError?: string;
  statementsAvailable: boolean;
  statementsError?: string;
  waitEvents: { waitEventType: string | null; waitEvent: string | null; samples: number }[];
  maxLockWaitingQueries: number;
  maxActiveConnections: number;
  lockWaitingQueries: {
    query: string;
    waitEvent: string | null;
    queryElapsedMs: number;
    blockingPids: number[];
  }[];
  topQueries: { query: string; calls: number; totalExecTimeMs: number }[];
}

type AcquisitionStage = 'authentication' | 'accept' | 'pendingFetch' | 'acknowledge';
type AcquisitionSummaries = Record<AcquisitionStage, LatencySummary>;
interface RuntimeDiagnostics {
  cpuPercent: number;
  eventLoopUtilizationPercent: number;
  eventLoopDelayMs: LatencySummary;
}
interface WindowDiagnostics {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  connectionAcquisitionWaitMs: AcquisitionSummaries;
  pool: {
    maxTotalCount: number;
    minIdleCount: number;
    maxWaitingCount: number;
    samples: PoolSample[];
  };
  postgres: PostgresDiagnostics;
  runtime: RuntimeDiagnostics;
  driverRuntime: RuntimeDiagnostics;
}

type ErrorCounts = Record<string, number>;
interface StageResult {
  mode: LoadMode;
  requestedConcurrentClients: number;
  authenticatedClients: number;
  messagesAttempted: number;
  messagesSucceeded: number;
  messagesFailed: number;
  ackSucceeded: number;
  ackFailed: number;
  throughputMessagesPerSecond: number;
  latencyMs: {
    authentication: LatencySummary;
    accept: LatencySummary;
    pendingFetch: LatencySummary;
    acknowledge: LatencySummary;
    sendToVisible: LatencySummary;
    visibleToAck: LatencySummary;
    sendToAck: LatencySummary;
  };
  reconnectRamp: WindowDiagnostics & {
    authenticationLatencyMs: LatencySummary;
    poolAtWarmupEnd: PoolSample;
  };
  connectionAcquisitionWaitMs: AcquisitionSummaries;
  pool: {
    maxTotalCount: number;
    minIdleCount: number;
    maxWaitingCount: number;
    samples: PoolSample[];
  };
  postgres: PostgresDiagnostics;
  runtime: RuntimeDiagnostics;
  driverRuntime: RuntimeDiagnostics;
  pendingFetchRequests: number;
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
const summarize = (values: number[]): LatencySummary => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
};
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
const increment = (counts: ErrorCounts, name: string) => (counts[name] = (counts[name] ?? 0) + 1);
const decodeQuotedPrintable = (value: string) =>
  value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

interface ServiceTimings {
  authentication: number[];
  accept: number[];
  pendingFetch: number[];
  acknowledge: number[];
  connectionAcquisition: Record<AcquisitionStage, number[]>;
}

let activeTimings: ServiceTimings | undefined;
const acquisitionStage = new AsyncLocalStorage<{
  stage: AcquisitionStage;
  timings: ServiceTimings | undefined;
}>();

const emptyServiceTimings = (): ServiceTimings => ({
  authentication: [],
  accept: [],
  pendingFetch: [],
  acknowledge: [],
  connectionAcquisition: {
    authentication: [],
    accept: [],
    pendingFetch: [],
    acknowledge: [],
  },
});

const summarizeAcquisition = (timings: ServiceTimings): AcquisitionSummaries => ({
  authentication: summarize(timings.connectionAcquisition.authentication),
  accept: summarize(timings.connectionAcquisition.accept),
  pendingFetch: summarize(timings.connectionAcquisition.pendingFetch),
  acknowledge: summarize(timings.connectionAcquisition.acknowledge),
});

class InstrumentedPostgresDatabase extends PostgresDatabase {
  private recordConnectionAcquisition(started: number) {
    const context = acquisitionStage.getStore();
    if (context) {
      context.timings?.connectionAcquisition[context.stage].push(performance.now() - started);
    }
  }

  override async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    const started = performance.now();
    const client = await this.pool.connect();
    this.recordConnectionAcquisition(started);
    try {
      return await client.query<R>(text, values);
    } finally {
      client.release();
    }
  }

  override async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const started = performance.now();
    const client = await this.pool.connect();
    this.recordConnectionAcquisition(started);
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

class InstrumentedAuthService extends AuthService {
  override async authenticate(accessToken: string) {
    const started = performance.now();
    const timings = activeTimings;
    try {
      return await acquisitionStage.run({ stage: 'authentication', timings }, () =>
        super.authenticate(accessToken),
      );
    } finally {
      timings?.authentication.push(performance.now() - started);
    }
  }
}

class InstrumentedDeliveryService extends MessageDeliveryService {
  override async accept(input: Parameters<MessageDeliveryService['accept']>[0]) {
    const started = performance.now();
    const timings = activeTimings;
    try {
      return await acquisitionStage.run({ stage: 'accept', timings }, () => super.accept(input));
    } finally {
      timings?.accept.push(performance.now() - started);
    }
  }

  override async listPending(recipientUserId: string, limit: number) {
    const started = performance.now();
    const timings = activeTimings;
    try {
      return await acquisitionStage.run({ stage: 'pendingFetch', timings }, () =>
        super.listPending(recipientUserId, limit),
      );
    } finally {
      timings?.pendingFetch.push(performance.now() - started);
    }
  }

  override async acknowledge(recipientUserId: string, requestId: string, senderUserId: string) {
    const started = performance.now();
    const timings = activeTimings;
    try {
      return await acquisitionStage.run({ stage: 'acknowledge', timings }, () =>
        super.acknowledge(recipientUserId, requestId, senderUserId),
      );
    } finally {
      timings?.acknowledge.push(performance.now() - started);
    }
  }
}

interface LoadIdentity {
  accessToken: string;
  userId: string;
}

interface IndependentClient {
  sender: LoadIdentity;
  recipient: LoadIdentity;
}

interface RemoteWindowResult {
  timings: ServiceTimings;
  poolSamples: PoolSample[];
  runtime: RuntimeDiagnostics;
}

interface ServerProcessController {
  process: ChildProcess;
  request<T>(type: 'start-window' | 'stop-window' | 'snapshot-timings' | 'pool-sample'): Promise<T>;
  close(): Promise<void>;
}

async function startServerProcess(input: {
  databaseUrl: string;
  backendPort: number;
  smtpPort: number;
}): Promise<ServerProcessController> {
  const childPath = fileURLToPath(new URL('./soft-chat-load-server-process.ts', import.meta.url));
  const child = fork(childPath, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      SOFT_CHAT_LOAD_CHILD_DATABASE_URL: input.databaseUrl,
      SOFT_CHAT_LOAD_CHILD_BACKEND_PORT: String(input.backendPort),
      SOFT_CHAT_LOAD_CHILD_SMTP_PORT: String(input.smtpPort),
      SOFT_CHAT_LOAD_CHILD_POOL_MAX: String(requestedPoolMax),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  child.on('message', (message: unknown) => {
    const response = message as {
      type?: string;
      id?: number;
      value?: unknown;
      error?: string;
    };
    if (response.type === 'ready') {
      readyResolve?.();
      return;
    }
    if (response.id === undefined) return;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(new Error(response.error));
    else waiter.resolve(response.value);
  });
  child.once('error', (error) => readyReject?.(error));
  child.once('exit', (code, signal) => {
    const error = new Error(`Soft Chat server process exited (${code ?? signal ?? 'unknown'}).`);
    readyReject?.(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  await ready;

  const request = <T>(
    type: 'start-window' | 'stop-window' | 'snapshot-timings' | 'pool-sample' | 'shutdown',
  ) =>
    new Promise<T>((resolveRequest, rejectRequest) => {
      const id = ++sequence;
      pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
      });
      child.send({ id, type }, (error) => {
        if (!error) return;
        pending.delete(id);
        rejectRequest(error);
      });
    });

  return {
    process: child,
    request,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await request<null>('shutdown');
      await new Promise<void>((done) => child.once('exit', () => done()));
    },
  };
}

suite('Soft Chat production-path capacity', () => {
  let adminDatabase: PostgresDatabase;
  let database: PostgresDatabase;
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let serverProcess: ServerProcessController | undefined;
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
    database = new InstrumentedPostgresDatabase(isolatedDatabaseUrl);
    if (!Number.isInteger(requestedPoolMax) || requestedPoolMax < 1 || requestedPoolMax > 200) {
      throw new Error('SOFT_CHAT_LOAD_POOL_MAX must be an integer between 1 and 200.');
    }
    if (!Number.isFinite(clientRampMs) || clientRampMs < 0) {
      throw new Error('SOFT_CHAT_LOAD_CLIENT_RAMP_MS must be a non-negative number.');
    }
    if (!Number.isFinite(warmupMs) || warmupMs < 0) {
      throw new Error('SOFT_CHAT_LOAD_WARMUP_MS must be a non-negative number.');
    }
    database.pool.options.max = requestedPoolMax;
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
    if (separateServerProcess) {
      if (requestedModes.some((mode) => mode !== 'independent-streaming')) {
        throw new Error(
          'SOFT_CHAT_LOAD_SEPARATE_SERVER=1 currently supports independent-streaming only.',
        );
      }
      serverProcess = await startServerProcess({
        databaseUrl: isolatedDatabaseUrl,
        backendPort,
        smtpPort,
      });
    } else {
      const service = new InstrumentedAuthService(
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
        delivery: new InstrumentedDeliveryService(
          database,
          systemClock,
          config.messageDeliveryBindingSecret,
        ),
      });
      await app.listen({ host: '127.0.0.1', port: backendPort });
    }
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
    await serverProcess?.close();
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

  async function seedIndependentClients(
    count: number,
    label: string,
  ): Promise<IndependentClient[]> {
    const now = systemClock.now();
    const accessExpiresAt = addSeconds(now, 30 * 60);
    const sessionExpiresAt = addSeconds(now, 60 * 60);
    const rows = Array.from({ length: count * 2 }, (_, index) => {
      const role = index % 2 === 0 ? 'sender' : 'recipient';
      const pair = Math.floor(index / 2);
      const accessToken = randomBytes(32).toString('base64url');
      return {
        role,
        pair,
        accessToken,
        userId: randomUUID(),
        deviceId: randomUUID(),
        familyId: randomUUID(),
        sessionId: randomUUID(),
        email: `load-${label}-${pair}-${role}@example.test`,
        deviceHash: hash(`load-device-${label}-${pair}-${role}`).toString('base64'),
        accessTokenHash: hash(accessToken).toString('base64'),
      };
    });
    const payload = JSON.stringify(
      rows.map((row) => ({
        user_id: row.userId,
        device_id: row.deviceId,
        family_id: row.familyId,
        session_id: row.sessionId,
        email: row.email,
        device_hash: row.deviceHash,
        access_token_hash: row.accessTokenHash,
      })),
    );
    await database.transaction(async (client) => {
      await client.query(
        `INSERT INTO users(id,email,status,email_verified_at,created_at,updated_at)
         SELECT user_id::uuid,email,'active',$2,$2,$2
           FROM jsonb_to_recordset($1::jsonb) AS x(user_id text,email text)`,
        [payload, now],
      );
      await client.query(
        `INSERT INTO devices
         (id,user_id,name,platform,client_device_key_hash,created_at,last_used_at)
         SELECT device_id::uuid,user_id::uuid,'Independent load client','linux',
                decode(device_hash,'base64'),$2,$2
           FROM jsonb_to_recordset($1::jsonb)
             AS x(device_id text,user_id text,device_hash text)`,
        [payload, now],
      );
      await client.query(
        `INSERT INTO refresh_token_families(id,user_id,device_id,created_at)
         SELECT family_id::uuid,user_id::uuid,device_id::uuid,$2
           FROM jsonb_to_recordset($1::jsonb)
             AS x(family_id text,user_id text,device_id text)`,
        [payload, now],
      );
      await client.query(
        `INSERT INTO sessions
         (id,user_id,device_id,family_id,access_token_hash,access_expires_at,created_at,last_used_at,
          last_refreshed_at,inactivity_expires_at,expires_at,authentication_method,assurance_level,
          authenticated_at,step_up_at,security_version)
         SELECT x.session_id::uuid,x.user_id::uuid,x.device_id::uuid,x.family_id::uuid,
                decode(x.access_token_hash,'base64'),$2,$3,$3,$3,$2,$4,
                'webauthn_uv','aal2',$3,$3,u.security_version
           FROM jsonb_to_recordset($1::jsonb)
             AS x(session_id text,user_id text,device_id text,family_id text,access_token_hash text)
           JOIN users u ON u.id=x.user_id::uuid`,
        [payload, accessExpiresAt, now, sessionExpiresAt],
      );
    });
    return Array.from({ length: count }, (_, index) => {
      const sender = rows[index * 2]!;
      const recipient = rows[index * 2 + 1]!;
      return {
        sender: { accessToken: sender.accessToken, userId: sender.userId },
        recipient: { accessToken: recipient.accessToken, userId: recipient.userId },
      };
    });
  }

  async function startDiagnostics() {
    const poolSamples: PoolSample[] = [];
    const waitCounts = new Map<string, number>();
    const lockWaitingQueries = new Map<string, PostgresDiagnostics['lockWaitingQueries'][number]>();
    let maxLockWaitingQueries = 0;
    let maxActiveConnections = 0;
    let activityError: string | undefined;
    let statementsError: string | undefined;
    const statementBaseline = new Map<string, { calls: number; totalExecTimeMs: number }>();
    try {
      const extension = await adminDatabase.query<{ installed: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements') installed`,
      );
      if (extension.rows[0]?.installed) {
        const baseline = await adminDatabase.query<{
          queryid: string;
          calls: string;
          total_exec_time: number;
        }>(
          `SELECT queryid::text,calls::text,total_exec_time FROM pg_stat_statements
            WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())`,
        );
        for (const row of baseline.rows) {
          statementBaseline.set(row.queryid, {
            calls: Number(row.calls),
            totalExecTimeMs: row.total_exec_time,
          });
        }
      } else {
        statementsError = 'pg_stat_statements extension is not installed';
      }
    } catch (error) {
      statementsError = String(error);
    }
    const runtimeStartedAt = performance.now();
    const cpuStarted = process.cpuUsage();
    const eventLoopStarted = performance.eventLoopUtilization();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
    if (serverProcess) await serverProcess.request<null>('start-window');
    let sampling = false;
    const poolTimer = serverProcess
      ? undefined
      : setInterval(() => {
          poolSamples.push({
            at: new Date().toISOString(),
            totalCount: database.pool.totalCount,
            idleCount: database.pool.idleCount,
            waitingCount: database.pool.waitingCount,
          });
        }, 25);
    const postgresTimer = setInterval(() => {
      if (sampling) return;
      sampling = true;
      void adminDatabase
        .query<{
          pid: number;
          state: string;
          wait_event_type: string | null;
          wait_event: string | null;
          query: string;
          query_elapsed_ms: string;
          blocking_pids: number[];
          connection_count: string;
        }>(
          `SELECT pid,state,wait_event_type,wait_event,left(query,500) query,
                  extract(epoch FROM (clock_timestamp()-query_start))*1000 query_elapsed_ms,
                  pg_blocking_pids(pid) blocking_pids,
                  count(*) OVER ()::text connection_count
             FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()`,
        )
        .then((result) => {
          let lockWaiting = 0;
          for (const row of result.rows) {
            maxActiveConnections = Math.max(maxActiveConnections, Number(row.connection_count));
            if (row.state === 'idle') continue;
            const key = JSON.stringify([row.wait_event_type, row.wait_event]);
            waitCounts.set(key, (waitCounts.get(key) ?? 0) + 1);
            if (row.wait_event_type === 'Lock') {
              lockWaiting += 1;
              lockWaitingQueries.set(`${row.pid}:${row.query}`, {
                query: row.query,
                waitEvent: row.wait_event,
                queryElapsedMs: Number(row.query_elapsed_ms),
                blockingPids: row.blocking_pids,
              });
            }
          }
          maxLockWaitingQueries = Math.max(maxLockWaitingQueries, lockWaiting);
        })
        .catch((error: unknown) => {
          activityError = String(error);
        })
        .finally(() => {
          sampling = false;
        });
    }, 250);
    return async () => {
      if (poolTimer) clearInterval(poolTimer);
      clearInterval(postgresTimer);
      eventLoopDelay.disable();
      const runtimeDurationMs = performance.now() - runtimeStartedAt;
      const cpu = process.cpuUsage(cpuStarted);
      const eventLoop = performance.eventLoopUtilization(eventLoopStarted);
      const eventLoopSamples = eventLoopDelay.count;
      const milliseconds = (nanoseconds: number) => nanoseconds / 1_000_000;
      const driverRuntime: RuntimeDiagnostics = {
        cpuPercent:
          runtimeDurationMs === 0 ? 0 : ((cpu.user + cpu.system) / 1000 / runtimeDurationMs) * 100,
        eventLoopUtilizationPercent: eventLoop.utilization * 100,
        eventLoopDelayMs:
          eventLoopSamples === 0
            ? { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
            : {
                count: eventLoopSamples,
                p50: milliseconds(eventLoopDelay.percentile(50)),
                p95: milliseconds(eventLoopDelay.percentile(95)),
                p99: milliseconds(eventLoopDelay.percentile(99)),
                max: milliseconds(eventLoopDelay.max),
              },
      };
      const remoteDiagnostics = serverProcess
        ? await serverProcess.request<RemoteWindowResult>('stop-window')
        : undefined;
      while (sampling) await delay(10);
      let topQueries: PostgresDiagnostics['topQueries'] = [];
      if (!statementsError) {
        try {
          const result = await adminDatabase.query<{
            queryid: string;
            query: string;
            calls: string;
            total_exec_time: number;
          }>(
            `SELECT queryid::text,left(query,500) query,calls::text,total_exec_time
               FROM pg_stat_statements
              WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
                AND query NOT ILIKE '%pg_stat%'`,
          );
          topQueries = result.rows
            .map((row) => {
              const baseline = statementBaseline.get(row.queryid) ?? {
                calls: 0,
                totalExecTimeMs: 0,
              };
              return {
                query: row.query,
                calls: Number(row.calls) - baseline.calls,
                totalExecTimeMs: row.total_exec_time - baseline.totalExecTimeMs,
              };
            })
            .filter((row) => row.calls > 0)
            .sort((left, right) => right.totalExecTimeMs - left.totalExecTimeMs)
            .slice(0, 15);
        } catch (error) {
          statementsError = String(error);
        }
      }
      const waitEvents = [...waitCounts.entries()].map(([key, samples]) => {
        const [waitEventType, waitEvent] = JSON.parse(key) as [string | null, string | null];
        return { waitEventType, waitEvent, samples };
      });
      return {
        poolSamples: remoteDiagnostics?.poolSamples ?? poolSamples,
        runtime: remoteDiagnostics?.runtime ?? driverRuntime,
        driverRuntime,
        serviceTimings: remoteDiagnostics?.timings,
        postgres: {
          activityAvailable: !activityError,
          ...(activityError ? { activityError } : {}),
          statementsAvailable: !statementsError,
          ...(statementsError ? { statementsError } : {}),
          waitEvents,
          maxLockWaitingQueries,
          maxActiveConnections,
          lockWaitingQueries: [...lockWaitingQueries.values()].slice(0, 25),
          topQueries,
        } satisfies PostgresDiagnostics,
      };
    };
  }

  function summarizePool(poolSamples: PoolSample[]) {
    return {
      maxTotalCount: Math.max(0, ...poolSamples.map((sample) => sample.totalCount)),
      minIdleCount:
        poolSamples.length === 0 ? 0 : Math.min(...poolSamples.map((sample) => sample.idleCount)),
      maxWaitingCount: Math.max(0, ...poolSamples.map((sample) => sample.waitingCount)),
      samples: poolSamples,
    };
  }

  const currentPoolSample = async (): Promise<PoolSample> =>
    serverProcess
      ? serverProcess.request<PoolSample>('pool-sample')
      : {
          at: new Date().toISOString(),
          totalCount: database.pool.totalCount,
          idleCount: database.pool.idleCount,
          waitingCount: database.pool.waitingCount,
        };

  async function runStage(
    mode: LoadMode,
    count: number,
    shared?: { sender: LoadIdentity; recipient: LoadIdentity },
  ): Promise<StageResult> {
    const errors: ErrorCounts = {};
    const startedMessages = new Map<string, number>();
    const visibleMessages = new Map<string, number>();
    const acknowledgedMessages = new Map<string, number>();
    const expectedPayloads = new Map<string, string>();
    const seen = new Set<string>();
    let authenticatedClients = 0;
    const authenticatedIndices: number[] = [];
    let messagesSucceeded = 0;
    let ackSucceeded = 0;
    let duplicateDeliveries = 0;
    let contentViolations = 0;
    let pendingFetchRequests = 0;
    let unhealthy = false;
    let workersRunning = true;
    const workerPromises: Promise<void>[] = [];
    const initialAuthenticationLatencies: number[] = [];
    const independent =
      mode === 'independent-streaming'
        ? await seedIndependentClients(count, `${Date.now()}-${count}`)
        : undefined;
    if (mode === 'shared-phased' && !shared) throw new Error('Shared identities are required.');
    const healthTimer = setInterval(() => {
      void fetch(`${baseUrl}/health/ready`)
        .then((response) => {
          if (!response.ok) unhealthy = true;
        })
        .catch(() => (unhealthy = true));
    }, 1000);
    const prepareMessage = (requestId: string, index: number) => {
      startedMessages.set(requestId, performance.now());
      const text =
        index % 3 === 0
          ? 'Pepper load ordinary text'
          : index % 3 === 1
            ? '🫡👩🏽‍💻'
            : 'Pepper load Hello 🌍!';
      const payload = Buffer.from(text, 'utf8').toString('base64');
      expectedPayloads.set(requestId, payload);
      return payload;
    };
    const acknowledgeItem = async (
      item: Record<string, unknown>,
      recipient: LoadIdentity,
      sender: LoadIdentity,
    ) => {
      const requestId = item.requestId as string;
      if (seen.has(requestId)) duplicateDeliveries += 1;
      seen.add(requestId);
      visibleMessages.set(requestId, visibleMessages.get(requestId) ?? performance.now());
      if (item.payload !== expectedPayloads.get(requestId)) {
        increment(errors, 'receive:PAYLOAD_ALTERED');
        contentViolations += 1;
      }
      try {
        await authorized(`/api/v1/messages/${requestId}/ack`, recipient.accessToken, {
          method: 'POST',
          body: JSON.stringify({ senderId: sender.userId }),
        });
        if (!acknowledgedMessages.has(requestId)) {
          ackSucceeded += 1;
          acknowledgedMessages.set(requestId, performance.now());
        }
      } catch (error) {
        increment(errors, `ack:${String(error)}`);
      }
    };

    const startIndependentWorker = (index: number) => {
      const client = independent![index]!;
      workerPromises.push(
        (async () => {
          while (workersRunning && !unhealthy) {
            try {
              pendingFetchRequests += 1;
              const pending = await authorized(
                '/api/v1/messages/pending?limit=100',
                client.recipient.accessToken,
              );
              const items = (pending.items as Record<string, unknown>[] | undefined) ?? [];
              for (const item of items) {
                if (expectedPayloads.has(item.requestId as string)) {
                  await acknowledgeItem(item, client.recipient, client.sender);
                }
              }
            } catch (error) {
              increment(errors, `receive:${String(error)}`);
              return;
            }
            await delay(pollIntervalMs);
          }
        })(),
      );
    };

    const reconnectTimings = emptyServiceTimings();
    activeTimings = serverProcess ? undefined : reconnectTimings;
    const stopReconnectDiagnostics = await startDiagnostics();
    const reconnectStarted = new Date();
    await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        if (clientRampMs > 0) await delay((index * clientRampMs) / count);
        try {
          if (independent) {
            const authenticate = async (identity: LoadIdentity) => {
              const started = performance.now();
              try {
                await authorized('/api/v1/me', identity.accessToken);
              } finally {
                initialAuthenticationLatencies.push(performance.now() - started);
              }
            };
            await Promise.all([
              authenticate(independent[index]!.sender),
              authenticate(independent[index]!.recipient),
            ]);
          } else {
            const started = performance.now();
            await authorized(
              '/api/v1/me',
              index % 2 === 0 ? shared!.sender.accessToken : shared!.recipient.accessToken,
            );
            initialAuthenticationLatencies.push(performance.now() - started);
          }
          authenticatedClients += 1;
          authenticatedIndices.push(index);
          if (independent) startIndependentWorker(index);
        } catch (error) {
          increment(errors, `authentication:${String(error)}`);
        }
      }),
    );
    const reconnectAuthenticationLatency = summarize(initialAuthenticationLatencies);
    const reconnectTimingSnapshot = serverProcess
      ? await serverProcess.request<ServiceTimings>('snapshot-timings')
      : reconnectTimings;
    const reconnectAuthenticationAcquisition = summarize(
      reconnectTimingSnapshot.connectionAcquisition.authentication,
    );
    if (warmupMs > 0) await delay(warmupMs);
    const poolAtWarmupEnd = await currentPoolSample();
    activeTimings = undefined;
    const reconnectFinished = new Date();
    const reconnectDiagnostics = await stopReconnectDiagnostics();
    const effectiveReconnectTimings = reconnectDiagnostics.serviceTimings ?? reconnectTimings;
    const reconnectAcquisition = summarizeAcquisition(effectiveReconnectTimings);
    reconnectAcquisition.authentication = reconnectAuthenticationAcquisition;
    const reconnectRamp: StageResult['reconnectRamp'] = {
      startedAt: reconnectStarted.toISOString(),
      finishedAt: reconnectFinished.toISOString(),
      durationMs: reconnectFinished.getTime() - reconnectStarted.getTime(),
      authenticationLatencyMs: reconnectAuthenticationLatency,
      connectionAcquisitionWaitMs: reconnectAcquisition,
      pool: summarizePool(reconnectDiagnostics.poolSamples),
      poolAtWarmupEnd,
      postgres: reconnectDiagnostics.postgres,
      runtime: reconnectDiagnostics.runtime,
      driverRuntime: reconnectDiagnostics.driverRuntime,
    };

    const timings = emptyServiceTimings();
    activeTimings = serverProcess ? undefined : timings;
    const stopSteadyDiagnostics = await startDiagnostics();
    const started = new Date();
    const requests = authenticatedIndices.map((index) => ({ index, requestId: randomUUID() }));

    if (independent) {
      await Promise.all(
        requests.map(async ({ requestId, index }) => {
          const client = independent[index]!;
          const payload = prepareMessage(requestId, index);
          try {
            await authorized('/api/v1/messages', client.sender.accessToken, {
              method: 'POST',
              body: JSON.stringify({
                requestId,
                recipientId: client.recipient.userId,
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
      const deadline = performance.now() + 30_000;
      while (ackSucceeded < messagesSucceeded && performance.now() < deadline && !unhealthy) {
        await delay(10);
      }
      if (ackSucceeded < messagesSucceeded) increment(errors, 'receive:TIMEOUT');
    } else {
      await Promise.all(
        requests.map(async ({ requestId, index }) => {
          const payload = prepareMessage(requestId, index);
          try {
            await authorized('/api/v1/messages', shared!.sender.accessToken, {
              method: 'POST',
              body: JSON.stringify({
                requestId,
                recipientId: shared!.recipient.userId,
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
          pendingFetchRequests += 1;
          const pending = await authorized(
            '/api/v1/messages/pending?limit=100',
            shared!.recipient.accessToken,
          );
          items = (pending.items as Record<string, unknown>[] | undefined) ?? [];
        } catch (error) {
          increment(errors, `receive:${String(error)}`);
          break;
        }
        if (items.length === 0) break;
        await Promise.all(
          items.map((item) => acknowledgeItem(item, shared!.recipient, shared!.sender)),
        );
      }
    }
    const finished = new Date();
    const durationMs = finished.getTime() - started.getTime();
    workersRunning = false;
    await Promise.all(workerPromises);
    clearInterval(healthTimer);
    activeTimings = undefined;
    const diagnostics = await stopSteadyDiagnostics();
    const effectiveTimings = diagnostics.serviceTimings ?? timings;
    const sendToVisible = [...visibleMessages].map(
      ([requestId, visible]) => visible - startedMessages.get(requestId)!,
    );
    const visibleToAck = [...acknowledgedMessages].map(
      ([requestId, acknowledged]) => acknowledged - visibleMessages.get(requestId)!,
    );
    const sendToAck = [...acknowledgedMessages].map(
      ([requestId, acknowledged]) => acknowledged - startedMessages.get(requestId)!,
    );
    const latencyMs = {
      authentication: summarize(effectiveTimings.authentication),
      accept: summarize(effectiveTimings.accept),
      pendingFetch: summarize(effectiveTimings.pendingFetch),
      acknowledge: summarize(effectiveTimings.acknowledge),
      sendToVisible: summarize(sendToVisible),
      visibleToAck: summarize(visibleToAck),
      sendToAck: summarize(sendToAck),
    };
    const pool = summarizePool(diagnostics.poolSamples);
    const messagesFailed = authenticatedClients - messagesSucceeded;
    const ackFailed = messagesSucceeded - ackSucceeded;
    const errorRate =
      (messagesFailed + ackFailed) / Math.max(1, authenticatedClients + messagesSucceeded);
    const p99 = latencyMs.sendToAck.p99;
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
      mode,
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
      latencyMs,
      reconnectRamp,
      connectionAcquisitionWaitMs: summarizeAcquisition(effectiveTimings),
      pool,
      postgres: diagnostics.postgres,
      runtime: diagnostics.runtime,
      driverRuntime: diagnostics.driverRuntime,
      pendingFetchRequests,
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
      for (const mode of requestedModes) {
        if (!['shared-phased', 'independent-streaming'].includes(mode)) {
          throw new Error(`Unsupported SOFT_CHAT_LOAD_MODES value: ${mode}`);
        }
      }
      const stages: StageResult[] = [];
      for (const mode of requestedModes) {
        const shared =
          mode === 'shared-phased'
            ? {
                sender: await register(`load-sender-${runId}@example.test`, 0),
                recipient: await register(`load-recipient-${runId}@example.test`, 1),
              }
            : undefined;
        for (const requested of requestedStages) {
          const result = await runStage(mode, requested, shared);
          stages.push(result);
          if (result.result === 'FAIL' && !comparisonRun) break;
        }
      }
      const report = {
        harness: 'Babylon Soft Chat production delivery/ACK capacity',
        startedAt: runStarted.toISOString(),
        finishedAt: new Date().toISOString(),
        databaseIsolation: `ephemeral PostgreSQL schema ${schema} (dropped after run)`,
        clientModels: {
          'shared-phased':
            'Control: two real WebAuthn accounts/sessions shared by every virtual client; all sends finish before batched pending/ACK processing starts.',
          'independent-streaming':
            'Diagnostic: test-only users, devices, and authenticated sessions are seeded only in the ephemeral schema; every virtual sender/recipient pair has independent rows and continuously polls/ACKs while sending. This measures already-authenticated independent clients, not passkey enrollment capacity.',
        },
        thresholds: { maxErrorRate, maxP99Ms },
        requestedStages,
        requestedModes,
        comparisonRun,
        separateServerProcess,
        pollIntervalMs,
        configuredPoolMax: requestedPoolMax,
        clientRampMs,
        warmupMs,
        stages,
        stopReason: stages.some((stage) => stage.result === 'FAIL')
          ? comparisonRun
            ? 'comparison completed all requested stages with one or more threshold failures'
            : 'a mode stopped after its first threshold failure'
          : 'all requested stages completed',
      };
      await mkdir(outputRoot, { recursive: true });
      const base = resolve(outputRoot, `soft-chat-load-${runId}`);
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      const header =
        'mode,started_at,finished_at,requested_clients,authenticated_clients,messages_attempted,messages_succeeded,messages_failed,ack_succeeded,ack_failed,throughput_messages_per_second,pending_fetch_requests,reconnect_authentication_p99_ms,reconnect_pool_max_waiting,reconnect_postgres_max_connections,reconnect_server_cpu_percent,reconnect_server_event_loop_utilization_percent,reconnect_server_event_loop_delay_p99_ms,reconnect_driver_cpu_percent,reconnect_driver_event_loop_utilization_percent,reconnect_driver_event_loop_delay_p99_ms,authentication_p99_ms,accept_p99_ms,pending_fetch_p99_ms,acknowledge_p99_ms,send_to_visible_p99_ms,visible_to_ack_p99_ms,send_to_ack_p99_ms,send_to_ack_max_ms,auth_connection_wait_p99_ms,accept_connection_wait_p99_ms,pending_connection_wait_p99_ms,ack_connection_wait_p99_ms,pool_max_total,pool_min_idle,pool_max_waiting,postgres_max_connections,postgres_max_lock_waiting,server_cpu_percent,server_event_loop_utilization_percent,server_event_loop_delay_p99_ms,driver_cpu_percent,driver_event_loop_utilization_percent,driver_event_loop_delay_p99_ms,duplicates,exactly_once_violations,duration_ms,result,reason\n';
      const csv = stages
        .map((stage) =>
          [
            stage.mode,
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
            stage.pendingFetchRequests,
            stage.reconnectRamp.authenticationLatencyMs.p99,
            stage.reconnectRamp.pool.maxWaitingCount,
            stage.reconnectRamp.postgres.maxActiveConnections,
            stage.reconnectRamp.runtime.cpuPercent,
            stage.reconnectRamp.runtime.eventLoopUtilizationPercent,
            stage.reconnectRamp.runtime.eventLoopDelayMs.p99,
            stage.reconnectRamp.driverRuntime.cpuPercent,
            stage.reconnectRamp.driverRuntime.eventLoopUtilizationPercent,
            stage.reconnectRamp.driverRuntime.eventLoopDelayMs.p99,
            stage.latencyMs.authentication.p99,
            stage.latencyMs.accept.p99,
            stage.latencyMs.pendingFetch.p99,
            stage.latencyMs.acknowledge.p99,
            stage.latencyMs.sendToVisible.p99,
            stage.latencyMs.visibleToAck.p99,
            stage.latencyMs.sendToAck.p99,
            stage.latencyMs.sendToAck.max,
            stage.connectionAcquisitionWaitMs.authentication.p99,
            stage.connectionAcquisitionWaitMs.accept.p99,
            stage.connectionAcquisitionWaitMs.pendingFetch.p99,
            stage.connectionAcquisitionWaitMs.acknowledge.p99,
            stage.pool.maxTotalCount,
            stage.pool.minIdleCount,
            stage.pool.maxWaitingCount,
            stage.postgres.maxActiveConnections,
            stage.postgres.maxLockWaitingQueries,
            stage.runtime.cpuPercent,
            stage.runtime.eventLoopUtilizationPercent,
            stage.runtime.eventLoopDelayMs.p99,
            stage.driverRuntime.cpuPercent,
            stage.driverRuntime.eventLoopUtilizationPercent,
            stage.driverRuntime.eventLoopDelayMs.p99,
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
            `${stage.result} ${stage.mode} ${stage.requestedConcurrentClients} clients: reconnect auth p99 ${stage.reconnectRamp.authenticationLatencyMs.p99.toFixed(1)}ms, reconnect pool waiting max ${stage.reconnectRamp.pool.maxWaitingCount}; steady ${stage.ackSucceeded}/${stage.messagesAttempted} delivered+ACK, ${stage.throughputMessagesPerSecond} msg/s, send→ACK p99 ${stage.latencyMs.sendToAck.p99.toFixed(1)}ms, pool waiting max ${stage.pool.maxWaitingCount}, connection wait p99 auth/accept/pending/ACK ${stage.connectionAcquisitionWaitMs.authentication.p99.toFixed(1)}/${stage.connectionAcquisitionWaitMs.accept.p99.toFixed(1)}/${stage.connectionAcquisitionWaitMs.pendingFetch.p99.toFixed(1)}/${stage.connectionAcquisitionWaitMs.acknowledge.p99.toFixed(1)}ms, lock wait max ${stage.postgres.maxLockWaitingQueries}, server Node CPU ${stage.runtime.cpuPercent.toFixed(1)}%, server event-loop utilization ${stage.runtime.eventLoopUtilizationPercent.toFixed(1)}%, server event-loop delay p99 ${stage.runtime.eventLoopDelayMs.p99.toFixed(1)}ms, driver Node CPU ${stage.driverRuntime.cpuPercent.toFixed(1)}%, driver event-loop utilization ${stage.driverRuntime.eventLoopUtilizationPercent.toFixed(1)}%, driver event-loop delay p99 ${stage.driverRuntime.eventLoopDelayMs.p99.toFixed(1)}ms — ${stage.reason}`,
        )
        .join('\n');
      await writeFile(
        `${base}.txt`,
        `Babylon Soft Chat load run ${runStarted.toISOString()}\n${summary}\nStop: ${report.stopReason}\n`,
      );
      expect(stages.length).toBeGreaterThan(0);
      expect(stages.every((stage) => stage.result === 'PASS')).toBe(true);
    },
    30 * 60_000,
  );
});
