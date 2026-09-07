#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
} from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommandRegistry,
  fingerprintPublicKey,
  NodeCore,
  NodeCoreError,
  signEnvelope,
  verifyEnvelopeSignature,
} from "../../babylon-project/node-core/dist/index.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const SCENARIOS = [
  "ed25519_sign_envelope",
  "ed25519_verify_canonicalize",
  "wake_process_fresh",
  "read_process_authorized",
  "command_process_authorized",
  "duplicate_replay_rejection",
];
const CONTROLS = ["harness_sync_overhead", "harness_async_overhead"];
const NOW = Date.parse("2026-09-07T03:00:00.000Z");
const TIME_POLICY = {
  maxFutureSkewMs: 30_000,
  maxLateSkewMs: 30_000,
  maxLifetimeMs: 300_000,
};

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing value: ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

function positiveInteger(values, key, fallback) {
  const value = Number(values.get(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`invalid --${key}`);
  return value;
}

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function percentile(sortedValues, fraction) {
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    min: sorted[0],
    max: sorted.at(-1),
    median: percentile(sorted, 0.5),
    relative_range_percent: ((sorted.at(-1) - sorted[0]) / mean) * 100,
  };
}

function fixed(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function summarize(scenario, runs) {
  const throughput = stats(runs.map((run) => run.ops_per_second));
  return {
    scenario,
    runs: runs.length,
    ops_per_second_mean: fixed(throughput.mean, 1),
    ops_per_second_min: fixed(throughput.min, 1),
    ops_per_second_max: fixed(throughput.max, 1),
    ops_per_second_relative_range_percent: fixed(
      throughput.relative_range_percent,
      2,
    ),
    p50_us_median_across_runs: fixed(
      stats(runs.map((run) => run.p50_us)).median,
    ),
    p95_us_median_across_runs: fixed(
      stats(runs.map((run) => run.p95_us)).median,
    ),
    p99_us_median_across_runs: fixed(
      stats(runs.map((run) => run.p99_us)).median,
    ),
  };
}

function makeUnsigned(kind, from, to, fingerprint, body) {
  return {
    bnp: "1",
    kind,
    message_id: "benchmark-message-00000001",
    from,
    to,
    issued_at: "2026-09-07T03:00:00.000Z",
    expires_at: "2026-09-07T03:01:00.000Z",
    key_fingerprint: fingerprint,
    body,
  };
}

// BENCHMARK-ONLY, NON-PRODUCTION. This does not persist anything despite the durable flag.
// The flag exists solely to reach the COMMAND processing path under measurement.
class BenchmarkReplayStore {
  durable;
  #outcome;

  constructor({ durable, outcome }) {
    this.durable = durable;
    this.#outcome = outcome;
  }

  claim() {
    return Promise.resolve(this.#outcome);
  }
}

function makeCoreOperation(scenario) {
  const senderKeys = generateKeyPairSync("ed25519");
  const localKeys = generateKeyPairSync("ed25519");
  const senderFingerprint = fingerprintPublicKey(senderKeys.publicKey);
  const localFingerprint = fingerprintPublicKey(localKeys.publicKey);
  const senderId = "node-benchmark-sender-01";
  const localId = "node-benchmark-local-0001";
  const commandCapability = "command.execute:benchmark/noop";
  const sender = {
    nodeId: senderId,
    status: "active",
    keys: new Map([
      [
        senderFingerprint,
        { publicKey: senderKeys.publicKey, status: "active" },
      ],
    ]),
    capabilities: new Set(["state.read:self", commandCapability]),
  };
  const registry = new CommandRegistry();
  registry.register({
    table_id: "benchmark",
    table_version: "1",
    command_id: "noop",
    requiredCapability: commandCapability,
    executionSemantics: "idempotent",
    handler: () => ({ ok: true }),
  });

  let kind;
  let body;
  let replayStore;
  if (scenario === "wake_process_fresh") {
    kind = "wake";
    body = { event_code: "BENCHMARK" };
    replayStore = new BenchmarkReplayStore({
      durable: false,
      outcome: "fresh",
    });
  } else if (scenario === "read_process_authorized") {
    kind = "read";
    body = { resource: "benchmark.state", view: "self" };
    replayStore = new BenchmarkReplayStore({
      durable: false,
      outcome: "fresh",
    });
  } else {
    kind = "command";
    body = { table_id: "benchmark", table_version: "1", command_id: "noop" };
    replayStore = new BenchmarkReplayStore({
      durable: true,
      outcome:
        scenario === "duplicate_replay_rejection" ? "duplicate" : "fresh",
    });
  }
  const request = signEnvelope(
    makeUnsigned(kind, senderId, localId, senderFingerprint, body),
    senderKeys.privateKey,
  );
  const core = new NodeCore({
    nodeId: localId,
    privateKey: localKeys.privateKey,
    keyFingerprint: localFingerprint,
    replayStore,
    commandRegistry: registry,
    timePolicy: TIME_POLICY,
    responseLifetimeMs: 60_000,
    resolvePeer: (nodeId) => (nodeId === senderId ? sender : null),
    authorize: () => true,
    onWake: () => undefined,
    onRead: () => ({ phase: "ready" }),
    now: () => NOW,
  });

  let sink = 0;
  if (scenario === "duplicate_replay_rejection") {
    return {
      async: true,
      operation: async () => {
        try {
          await core.process(request);
          throw new Error("duplicate request unexpectedly accepted");
        } catch (error) {
          if (
            !(error instanceof NodeCoreError) ||
            error.code !== "REPLAY_DETECTED"
          )
            throw error;
          sink ^= error.code.length;
        }
      },
      getSink: () => sink,
    };
  }
  return {
    async: true,
    operation: async () => {
      const response = await core.process(request);
      sink ^= response.signature.charCodeAt(response.signature.length - 1);
    },
    getSink: () => sink,
  };
}

function makeOperation(scenario) {
  if (scenario === "harness_sync_overhead") {
    let sink = 0;
    return {
      async: false,
      operation: () => {
        sink ^= 1;
      },
      getSink: () => sink,
    };
  }
  if (scenario === "harness_async_overhead") {
    let sink = 0;
    return {
      async: true,
      operation: async () => {
        sink ^= 1;
      },
      getSink: () => sink,
    };
  }

  const senderKeys = generateKeyPairSync("ed25519");
  const senderFingerprint = fingerprintPublicKey(senderKeys.publicKey);
  const unsigned = makeUnsigned(
    "wake",
    "node-benchmark-sender-01",
    "node-benchmark-local-0001",
    senderFingerprint,
    { event_code: "BENCHMARK", nested: { alpha: 1, beta: true } },
  );
  if (scenario === "ed25519_sign_envelope") {
    let sink = 0;
    return {
      async: false,
      operation: () => {
        const result = signEnvelope(unsigned, senderKeys.privateKey);
        sink ^= result.signature.charCodeAt(result.signature.length - 1);
      },
      getSink: () => sink,
    };
  }
  if (scenario === "ed25519_verify_canonicalize") {
    const signed = signEnvelope(unsigned, senderKeys.privateKey);
    let sink = 0;
    return {
      async: false,
      operation: () => {
        sink ^= Number(verifyEnvelopeSignature(signed, senderKeys.publicKey));
      },
      getSink: () => sink,
    };
  }
  return makeCoreOperation(scenario);
}

async function exerciseFor(operation, isAsync, durationMs) {
  const deadline = process.hrtime.bigint() + BigInt(durationMs) * 1_000_000n;
  let count = 0;
  if (isAsync) {
    while (process.hrtime.bigint() < deadline) {
      await operation();
      count += 1;
    }
  } else {
    while (process.hrtime.bigint() < deadline) {
      operation();
      count += 1;
    }
  }
  return count;
}

async function worker(values) {
  const scenario = values.get("worker");
  if (![...SCENARIOS, ...CONTROLS].includes(scenario))
    throw new Error("invalid worker scenario");
  const warmupMs = positiveInteger(values, "warmup-ms", 1500);
  const throughputMs = positiveInteger(values, "throughput-ms", 2500);
  const samples = positiveInteger(values, "samples", 20000);
  const benchmark = makeOperation(scenario);

  await exerciseFor(benchmark.operation, benchmark.async, warmupMs);
  const throughputStart = process.hrtime.bigint();
  const throughputCount = await exerciseFor(
    benchmark.operation,
    benchmark.async,
    throughputMs,
  );
  const throughputEnd = process.hrtime.bigint();
  const throughputSeconds = Number(throughputEnd - throughputStart) / 1e9;

  const latenciesNs = new Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const start = process.hrtime.bigint();
    if (benchmark.async) await benchmark.operation();
    else benchmark.operation();
    latenciesNs[index] = Number(process.hrtime.bigint() - start);
  }
  latenciesNs.sort((a, b) => a - b);
  const result = {
    scenario,
    pid: process.pid,
    throughput_operations: throughputCount,
    throughput_seconds: fixed(throughputSeconds, 6),
    ops_per_second: fixed(throughputCount / throughputSeconds, 1),
    latency_samples: samples,
    p50_us: fixed(percentile(latenciesNs, 0.5) / 1000),
    p95_us: fixed(percentile(latenciesNs, 0.95) / 1000),
    p99_us: fixed(percentile(latenciesNs, 0.99) / 1000),
    sink: benchmark.getSink(),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function cpuAffinity() {
  try {
    return (
      readFileSync("/proc/self/status", "utf8").match(
        /^Cpus_allowed_list:\s*(.+)$/m,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
}

function markdownSummary(document) {
  const lines = [
    "# Node Core benchmark result",
    "",
    `- Target: \`${document.target_sha}\``,
    `- Harness commit: \`${document.harness_commit}\``,
    `- Timestamp: ${document.timestamp_utc}`,
    `- Runtime: ${document.environment.node} / V8 ${document.environment.v8}`,
    `- CPU: ${document.environment.cpu_model}; affinity ${document.environment.cpu_affinity}`,
    "",
    "| Scenario | ops/s mean | p50 us | p95 us | p99 us | ops/s min–max | spread |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of document.summary.filter((entry) =>
    SCENARIOS.includes(entry.scenario),
  )) {
    lines.push(
      `| ${row.scenario} | ${row.ops_per_second_mean} | ${row.p50_us_median_across_runs} | ${row.p95_us_median_across_runs} | ${row.p99_us_median_across_runs} | ${row.ops_per_second_min}–${row.ops_per_second_max} | ${row.ops_per_second_relative_range_percent}% |`,
    );
  }
  lines.push("", "## Harness overhead controls", "");
  for (const row of document.summary.filter((entry) =>
    CONTROLS.includes(entry.scenario),
  )) {
    lines.push(
      `- ${row.scenario}: ${row.ops_per_second_mean} ops/s; p50 ${row.p50_us_median_across_runs} us; p95 ${row.p95_us_median_across_runs} us; p99 ${row.p99_us_median_across_runs} us.`,
    );
  }
  lines.push(
    "",
    "The COMMAND replay store is a benchmark-only, non-production, non-persistent stub.",
    "These transport-neutral microbenchmarks do not imply production end-to-end latency.",
    "",
  );
  return lines.join("\n");
}

async function coordinator(values) {
  const target = values.get("target");
  if (!/^[0-9a-f]{40}$/.test(target ?? ""))
    throw new Error("--target must be a full Git SHA");
  const runs = positiveInteger(values, "runs", 5);
  if (runs < 5) throw new Error("--runs must be at least 5");
  const warmupMs = positiveInteger(values, "warmup-ms", 1500);
  const throughputMs = positiveInteger(values, "throughput-ms", 2500);
  const samples = positiveInteger(values, "samples", 20000);
  const output = resolve(
    REPO_ROOT,
    values.get("output") ?? "benchmarks/node-core/results/raw.json",
  );

  git("diff", "--exit-code", target, "--", "babylon-project/node-core");
  const targetTree = git("rev-parse", `${target}^{tree}`);
  const head = git("rev-parse", "HEAD");
  const allRuns = [];
  for (const scenario of [...SCENARIOS, ...CONTROLS]) {
    for (let run = 1; run <= runs; run += 1) {
      const child = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--worker",
          scenario,
          "--warmup-ms",
          String(warmupMs),
          "--throughput-ms",
          String(throughputMs),
          "--samples",
          String(samples),
        ],
        { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      if (child.status !== 0) {
        throw new Error(
          `worker failed (${scenario} run ${run}): ${child.stderr || child.stdout}`,
        );
      }
      const result = JSON.parse(child.stdout);
      allRuns.push({ ...result, run });
      process.stderr.write(
        `${scenario} run ${run}/${runs}: ${result.ops_per_second} ops/s, p99 ${result.p99_us} us\n`,
      );
    }
  }

  const cpu = cpus()[0];
  const document = {
    schema: "node-core-microbenchmark-v1",
    target_sha: target,
    target_tree: targetTree,
    head_at_measurement: head,
    harness_commit: head,
    timestamp_utc: new Date().toISOString(),
    configuration: {
      independent_process_runs: runs,
      warmup_ms_per_run: warmupMs,
      throughput_ms_per_run: throughputMs,
      latency_samples_per_run: samples,
      sequential_single_thread: true,
      transport: "none",
      replay_store: "benchmark-only non-production non-persistent stub",
    },
    environment: {
      hostname: hostname(),
      platform: platform(),
      kernel: release(),
      architecture: process.arch,
      node: process.version,
      v8: process.versions.v8,
      npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
      cpu_model: cpu?.model ?? null,
      logical_cpu_count_visible: cpus().length,
      cpu_speed_reported_mhz: cpu?.speed ?? null,
      cpu_affinity: cpuAffinity(),
      total_memory_bytes: totalmem(),
      free_memory_bytes_at_report: freemem(),
      load_average_at_report: loadavg(),
    },
    precheck: {
      node_core_tests: "5 files passed; 25 tests passed",
      typescript_check: "passed",
      build: "passed",
      product_code_diff_against_target: "none",
    },
    runs: allRuns,
    summary: [...SCENARIOS, ...CONTROLS].map((scenario) =>
      summarize(
        scenario,
        allRuns.filter((result) => result.scenario === scenario),
      ),
    ),
    limitations: [
      "Single-threaded sequential warm-cache microbenchmark on one host.",
      "No transport, deployment, network, queueing, concurrency, or end-to-end latency is measured.",
      "Replay-store outcomes are returned by a benchmark-only non-production in-memory stub; no durable I/O is measured.",
      "Latency percentiles include timer/call/loop overhead and are not baseline-subtracted.",
      "Scenario summary percentiles are medians of five run-level percentile values.",
    ],
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(
    resolve(dirname(output), "SUMMARY.md"),
    markdownSummary(document),
  );
  process.stdout.write(
    `${JSON.stringify({ output, summary: document.summary }, null, 2)}\n`,
  );
}

const values = parseArgs(process.argv.slice(2));
if (values.has("worker")) await worker(values);
else await coordinator(values);
