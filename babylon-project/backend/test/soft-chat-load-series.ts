import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  evaluateSoftChatSeries,
  type SoftChatRunMeasurement,
  type SoftChatSeriesKind,
} from './soft-chat-load-aggregate.js';

interface LoadStage {
  requestedConcurrentClients: number;
  authenticatedClients: number;
  messagesSucceeded: number;
  messagesFailed: number;
  ackSucceeded: number;
  ackFailed: number;
  throughputMessagesPerSecond: number;
  latencyMs: { sendToAck: { p99: number } };
  connectionAcquisitionWaitMs: {
    authentication: { count: number };
    pendingFetch: { count: number };
  };
  pool: { maxWaitingCount: number };
  postgres: { maxLockWaitingQueries: number };
  runtime: { cpuPercent: number; eventLoopUtilizationPercent: number };
  driverRuntime: { cpuPercent: number; eventLoopUtilizationPercent: number };
  pendingFetchRequests: number;
  duplicateDeliveries: number;
  exactlyOnceViolations: number;
  errors: Record<string, number>;
}

interface LoadReport {
  stages: LoadStage[];
}

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for a Soft Chat measurement series.`);
  return value;
};

const positiveInteger = (name: string, value: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

const positiveNumber = (name: string, value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
};

async function runProcess(
  command: string,
  args: string[],
  options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function gitOutput(args: string[]) {
  const result = await runProcess('git', args, { capture: true });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function ensureCleanTrackedWorktree() {
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet'],
  ]) {
    const result = await runProcess('git', args, { capture: true });
    if (result.code !== 0) {
      throw new Error('Tracked or staged changes detected; refusing to start the series.');
    }
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function sha256(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function writeChecksums(root: string, destination: string) {
  const files = (await listFiles(root)).filter((path) => path !== destination);
  const lines = await Promise.all(
    files.map(async (path) => `${await sha256(path)}  ${relative(root, path)}`),
  );
  await writeFile(destination, `${lines.join('\n')}\n`);
}

function safeDatabaseTarget(raw: string) {
  const url = new URL(raw);
  return `${url.protocol}//${url.hostname}:${url.port || 'default'}${url.pathname}`;
}

function measurementFromStage(
  run: number,
  reportPath: string,
  stage: LoadStage,
): SoftChatRunMeasurement {
  return {
    run,
    reportPath,
    sendToAckP99Ms: stage.latencyMs.sendToAck.p99,
    throughputMessagesPerSecond: stage.throughputMessagesPerSecond,
    pendingFetchRequests: stage.pendingFetchRequests,
    pendingAcquisitions: stage.connectionAcquisitionWaitMs.pendingFetch.count,
    authenticationAcquisitions: stage.connectionAcquisitionWaitMs.authentication.count,
    poolMaxWaiting: stage.pool.maxWaitingCount,
    serverCpuPercent: stage.runtime.cpuPercent,
    serverEventLoopUtilizationPercent: stage.runtime.eventLoopUtilizationPercent,
    driverCpuPercent: stage.driverRuntime.cpuPercent,
    driverEventLoopUtilizationPercent: stage.driverRuntime.eventLoopUtilizationPercent,
    correctness: {
      requestedClients: stage.requestedConcurrentClients,
      authenticatedClients: stage.authenticatedClients,
      messagesSucceeded: stage.messagesSucceeded,
      acknowledgementsSucceeded: stage.ackSucceeded,
      duplicateDeliveries: stage.duplicateDeliveries,
      exactlyOnceViolations: stage.exactlyOnceViolations,
      maxLockWaitingQueries: stage.postgres.maxLockWaitingQueries,
      errors: [
        ...Object.entries(stage.errors).map(([name, count]) => `${name}=${count}`),
        ...(stage.messagesFailed > 0 ? [`messagesFailed=${stage.messagesFailed}`] : []),
        ...(stage.ackFailed > 0 ? [`ackFailed=${stage.ackFailed}`] : []),
      ],
    },
  };
}

function aggregateText(aggregate: ReturnType<typeof evaluateSoftChatSeries>) {
  const metric = (name: string, value: { mean: number; median: number; min: number; max: number }) =>
    `${name}: mean ${value.mean}, median ${value.median}, min ${value.min}, max ${value.max}`;
  return [
    `Babylon Soft Chat ${aggregate.kind} series`,
    `Runs: ${aggregate.repetitions}`,
    `Decision: ${aggregate.decision.passed ? 'PASS' : 'FAIL'}`,
    `Decision reasons: ${aggregate.decision.reasons.join('; ')}`,
    `${metric('send-to-ACK p99 ms', aggregate.latency)}, at/below ${aggregate.latencyTargetMs} ms: ${aggregate.latency.atOrBelowTarget}/${aggregate.repetitions}`,
    metric('throughput msg/s', aggregate.throughputMessagesPerSecond),
    metric('pending requests', aggregate.pendingFetchRequests),
    metric('pending acquisitions', aggregate.pendingAcquisitions),
    metric('authentication acquisitions', aggregate.authenticationAcquisitions),
    metric('pool max waiting', aggregate.poolMaxWaiting),
    metric('server CPU percent', aggregate.serverCpuPercent),
    metric('server ELU percent', aggregate.serverEventLoopUtilizationPercent),
    metric('driver CPU percent', aggregate.driverCpuPercent),
    metric('driver ELU percent', aggregate.driverEventLoopUtilizationPercent),
    `Correctness failure runs: ${aggregate.correctnessFailureRuns.join(', ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const kind = (process.env.SOFT_CHAT_SERIES_KIND ?? 'exploratory') as SoftChatSeriesKind;
  if (!['exploratory', 'release-candidate'].includes(kind)) {
    throw new Error('SOFT_CHAT_SERIES_KIND must be exploratory or release-candidate.');
  }
  const repetitions = positiveInteger(
    'SOFT_CHAT_SERIES_REPETITIONS',
    process.env.SOFT_CHAT_SERIES_REPETITIONS ?? (kind === 'release-candidate' ? '10' : '3'),
  );
  if (kind === 'release-candidate' && repetitions !== 10) {
    throw new Error('A release-candidate series requires exactly 10 repetitions.');
  }
  const latencyTargetMs = positiveNumber(
    'SOFT_CHAT_SERIES_P99_TARGET_MS',
    process.env.SOFT_CHAT_SERIES_P99_TARGET_MS ??
      process.env.SOFT_CHAT_LOAD_MAX_P99_MS ??
      '2000',
  );
  const databaseUrl = required('TEST_DATABASE_URL');
  required('PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  await ensureCleanTrackedWorktree();
  const commit = await gitOutput(['rev-parse', 'HEAD']);
  const seriesRoot = resolve(
    process.env.SOFT_CHAT_SERIES_OUTPUT_DIR ??
      `load-results/soft-chat/series/${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`,
  );
  if (await pathExists(seriesRoot)) {
    throw new Error(`Refusing to overwrite existing series directory: ${seriesRoot}`);
  }
  await mkdir(dirname(seriesRoot), { recursive: true });
  await mkdir(seriesRoot);

  const configuration = {
    stages: process.env.SOFT_CHAT_LOAD_STAGES ?? '100,500,1000,2000,5000',
    modes: process.env.SOFT_CHAT_LOAD_MODES ?? 'shared-phased,independent-streaming',
    poolMax: process.env.SOFT_CHAT_LOAD_POOL_MAX ?? '20',
    pollIntervalMs: process.env.SOFT_CHAT_LOAD_POLL_INTERVAL_MS ?? '50',
    clientRampMs: process.env.SOFT_CHAT_LOAD_CLIENT_RAMP_MS ?? '0',
    warmupMs: process.env.SOFT_CHAT_LOAD_WARMUP_MS ?? '0',
    separateServer: process.env.SOFT_CHAT_LOAD_SEPARATE_SERVER ?? '0',
    maxErrorRate: process.env.SOFT_CHAT_LOAD_MAX_ERROR_RATE ?? '0.01',
    p99ReferenceTargetMs: String(latencyTargetMs),
    latencyPolicy: 'reference',
    databaseTarget: safeDatabaseTarget(databaseUrl),
    chromiumExecutable: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  };
  const startedAt = new Date().toISOString();
  await writeFile(
    join(seriesRoot, 'series-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        commit,
        kind,
        repetitions,
        configuration,
      },
      null,
      2,
    )}\n`,
  );

  const measurements: SoftChatRunMeasurement[] = [];
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (let run = 1; run <= repetitions; run += 1) {
    const runDir = join(seriesRoot, `run-${String(run).padStart(2, '0')}`);
    await mkdir(runDir);
    const runStartedAt = new Date().toISOString();
    await writeFile(
      join(runDir, 'run-manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          run,
          commit,
          kind,
          startedAt: runStartedAt,
          configuration,
        },
        null,
        2,
      )}\n`,
    );

    const execution = await runProcess(npm, ['run', 'load:soft-chat'], {
      env: {
        ...process.env,
        RUN_SOFT_CHAT_LOAD: '1',
        SOFT_CHAT_LOAD_LATENCY_POLICY: 'reference',
        SOFT_CHAT_LOAD_MAX_P99_MS: String(latencyTargetMs),
        SOFT_CHAT_LOAD_OUTPUT_DIR: runDir,
      },
    });
    const reportNames = (await readdir(runDir)).filter(
      (name) => name.startsWith('soft-chat-load-') && name.endsWith('.json'),
    );
    if (reportNames.length !== 1) {
      throw new Error(
        `Run ${run} produced ${reportNames.length} JSON reports; exactly one is required.`,
      );
    }
    const reportPath = join(runDir, reportNames[0]!);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as LoadReport;
    if (report.stages.length !== 1) {
      throw new Error(
        `Run ${run} contains ${report.stages.length} stages; series aggregation requires exactly one.`,
      );
    }
    const measurement = measurementFromStage(
      run,
      relative(seriesRoot, reportPath),
      report.stages[0]!,
    );
    measurements.push(measurement);
    await writeFile(
      join(runDir, 'run-result.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          run,
          startedAt: runStartedAt,
          finishedAt: new Date().toISOString(),
          harnessExitCode: execution.code,
          measurement,
        },
        null,
        2,
      )}\n`,
    );
    await writeChecksums(runDir, join(runDir, 'SHA256SUMS'));
  }

  const aggregate = evaluateSoftChatSeries(measurements, { kind, latencyTargetMs });
  await writeFile(join(seriesRoot, 'aggregate.json'), `${JSON.stringify(aggregate, null, 2)}\n`);
  await writeFile(join(seriesRoot, 'aggregate.txt'), `${aggregateText(aggregate)}\n`);
  await writeFile(
    join(seriesRoot, 'series-result.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        commit,
        configuration,
        aggregate,
      },
      null,
      2,
    )}\n`,
  );
  await writeChecksums(seriesRoot, join(seriesRoot, 'SHA256SUMS'));
  console.log(aggregateText(aggregate));
  console.log(`Artifacts: ${seriesRoot}`);
  process.exitCode = aggregate.decision.passed ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
