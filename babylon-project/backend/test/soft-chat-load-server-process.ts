import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { AuthService } from '../src/auth-service.js';
import { secureRandom, systemClock } from '../src/crypto.js';
import { PostgresDatabase } from '../src/database.js';
import { SmtpMailer } from '../src/mailer.js';
import { MessageDeliveryService } from '../src/message-delivery.js';
import { buildServer } from '../src/server.js';
import { SimpleWebAuthnProvider } from '../src/webauthn.js';
import { testConfig } from './helpers.js';

type AcquisitionStage = 'authentication' | 'accept' | 'pendingFetch' | 'acknowledge';

interface ServiceTimings {
  authentication: number[];
  accept: number[];
  pendingFetch: number[];
  acknowledge: number[];
  connectionAcquisition: Record<AcquisitionStage, number[]>;
}

interface PoolSample {
  at: string;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

interface RuntimeDiagnostics {
  cpuPercent: number;
  eventLoopUtilizationPercent: number;
  eventLoopDelayMs: {
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
}

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the Soft Chat load server process.`);
  return value;
};

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

let activeTimings: ServiceTimings | undefined;
const acquisitionStage = new AsyncLocalStorage<{
  stage: AcquisitionStage;
  timings: ServiceTimings | undefined;
}>();

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

function startWindowDiagnostics(database: InstrumentedPostgresDatabase) {
  const poolSamples: PoolSample[] = [];
  const runtimeStartedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  const eventLoopStarted = performance.eventLoopUtilization();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  const poolTimer = setInterval(() => {
    poolSamples.push({
      at: new Date().toISOString(),
      totalCount: database.pool.totalCount,
      idleCount: database.pool.idleCount,
      waitingCount: database.pool.waitingCount,
    });
  }, 25);

  return () => {
    clearInterval(poolTimer);
    eventLoopDelay.disable();
    const runtimeDurationMs = performance.now() - runtimeStartedAt;
    const cpu = process.cpuUsage(cpuStarted);
    const eventLoop = performance.eventLoopUtilization(eventLoopStarted);
    const eventLoopSamples = eventLoopDelay.count;
    const milliseconds = (nanoseconds: number) => nanoseconds / 1_000_000;
    const runtime: RuntimeDiagnostics = {
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
    return { poolSamples, runtime };
  };
}

async function main() {
  const databaseUrl = required('SOFT_CHAT_LOAD_CHILD_DATABASE_URL');
  const backendPort = Number(required('SOFT_CHAT_LOAD_CHILD_BACKEND_PORT'));
  const smtpPort = Number(required('SOFT_CHAT_LOAD_CHILD_SMTP_PORT'));
  const poolMax = Number(required('SOFT_CHAT_LOAD_CHILD_POOL_MAX'));
  const database = new InstrumentedPostgresDatabase(databaseUrl);
  database.pool.options.max = poolMax;
  const baseUrl = `http://localhost:${backendPort}`;
  const config = testConfig(databaseUrl);
  config.publicBackendUrl = baseUrl;
  config.webauthnOrigins = [baseUrl];
  config.smtpPort = smtpPort;
  const service = new InstrumentedAuthService(
    database,
    config,
    systemClock,
    secureRandom,
    new SmtpMailer(config),
    new SimpleWebAuthnProvider(config),
  );
  const app = await buildServer({
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

  let stopWindow: (() => { poolSamples: PoolSample[]; runtime: RuntimeDiagnostics }) | undefined;
  let shuttingDown = false;
  const send = (message: unknown) => process.send?.(message);

  process.on('message', (message: unknown) => {
    const request = message as { id?: number; type?: string };
    if (request.id === undefined || !request.type) return;
    void (async () => {
      try {
        if (request.type === 'start-window') {
          if (stopWindow) throw new Error('A diagnostics window is already active.');
          activeTimings = emptyServiceTimings();
          stopWindow = startWindowDiagnostics(database);
          send({ id: request.id, value: null });
          return;
        }
        if (request.type === 'snapshot-timings') {
          send({ id: request.id, value: structuredClone(activeTimings ?? emptyServiceTimings()) });
          return;
        }
        if (request.type === 'pool-sample') {
          send({
            id: request.id,
            value: {
              at: new Date().toISOString(),
              totalCount: database.pool.totalCount,
              idleCount: database.pool.idleCount,
              waitingCount: database.pool.waitingCount,
            } satisfies PoolSample,
          });
          return;
        }
        if (request.type === 'stop-window') {
          if (!stopWindow || !activeTimings) throw new Error('No diagnostics window is active.');
          const timings = activeTimings;
          activeTimings = undefined;
          const diagnostics = stopWindow();
          stopWindow = undefined;
          send({ id: request.id, value: { timings, ...diagnostics } });
          return;
        }
        if (request.type === 'shutdown') {
          if (shuttingDown) return;
          shuttingDown = true;
          activeTimings = undefined;
          stopWindow?.();
          stopWindow = undefined;
          await app.close();
          await database.close();
          send({ id: request.id, value: null });
          setImmediate(() => process.disconnect());
          return;
        }
        throw new Error(`Unknown server-process command: ${request.type}`);
      } catch (error) {
        send({ id: request.id, error: String(error) });
      }
    })();
  });

  process.once('disconnect', () => {
    if (!shuttingDown) {
      void app.close().finally(() => database.close());
    }
  });
  send({ type: 'ready' });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
