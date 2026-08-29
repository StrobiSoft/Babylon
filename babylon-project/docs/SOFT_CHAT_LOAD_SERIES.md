# Soft Chat repeated measurement series

Issue [#33](https://github.com/StrobiSoft/Babylon/issues/33) defines the prospective
latency policy and the handoff checkpoints. This document describes the benchmark-only
automation that implements that policy. It does not change a production default.

## Latency modes

The existing one-run harness remains strict by default:

- `SOFT_CHAT_LOAD_LATENCY_POLICY=strict` (default) keeps the historical behavior and marks a
  stage failed when send-to-ACK p99 exceeds `SOFT_CHAT_LOAD_MAX_P99_MS`.
- `SOFT_CHAT_LOAD_LATENCY_POLICY=reference` records the same p99 and target miss, but the miss
  is advisory. Correctness and other hard failures still fail the stage.

Historical decisions are not recalculated with the prospective policy.

## Series command

Run a series from the exact code checkout being measured:

```bash
SOFT_CHAT_SERIES_KIND=exploratory \
SOFT_CHAT_SERIES_REPETITIONS=3 \
SOFT_CHAT_SERIES_OUTPUT_DIR='load-results/soft-chat/example-series' \
RUN_SOFT_CHAT_LOAD=1 \
SOFT_CHAT_LOAD_STAGES='500' \
SOFT_CHAT_LOAD_MODES='independent-streaming' \
SOFT_CHAT_LOAD_POOL_MAX='20' \
SOFT_CHAT_LOAD_POLL_INTERVAL_MS='500' \
SOFT_CHAT_LOAD_CLIENT_RAMP_MS='5000' \
SOFT_CHAT_LOAD_WARMUP_MS='2000' \
SOFT_CHAT_LOAD_SEPARATE_SERVER='1' \
TEST_DATABASE_URL='postgresql://user:password@127.0.0.1:5432/database' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE='/absolute/path/to/chrome' \
npm run load:soft-chat:series
```

The evaluator currently requires exactly one requested mode/stage per run so an aggregate cannot
silently combine unlike workloads.

The command:

- refuses tracked or staged changes;
- refuses to overwrite an existing series directory;
- records the exact Git commit and effective benchmark configuration;
- creates a separate `run-NN` directory for every repetition;
- requests reference-only latency handling when the measured checkout supports it;
- evaluates correctness and latency from the raw report, so an exact historical checkpoint can
  retain its original strict one-run exit status without being modified;
- preserves every individual report and target miss;
- writes per-run manifests, normalized results, and SHA-256 manifests;
- writes `aggregate.json`, `aggregate.txt`, `series-result.json`, and a complete series
  `SHA256SUMS`.

The database password is not copied into the manifest. The recorded database target contains only
protocol, host, port, and database name.

## Aggregated metrics

For every numeric metric, the evaluator records mean, median, minimum, and maximum:

- per-run send-to-ACK p99 and count at or below the reference target;
- throughput;
- pending request and acquisition counts;
- authentication acquisitions;
- maximum pool waiting;
- server and driver CPU;
- server and driver event-loop utilization.

It also records the exact runs that fail a hard correctness gate.

## Evaluation kinds

### Exploratory

`SOFT_CHAT_SERIES_KIND=exploratory` defaults to three repetitions. Latency remains visible but
does not decide the series. The series passes only when every hard correctness gate passes.
Hypothesis-specific causal classification remains governed by its preregistration; the generic
evaluator does not invent or reinterpret causal thresholds.

### Release candidate

`SOFT_CHAT_SERIES_KIND=release-candidate` requires exactly ten repetitions. A series passes only
when all of these are true:

1. every run passes the hard correctness gates;
2. the arithmetic mean of the ten per-run send-to-ACK p99 values is at most 2000 ms (or the
   explicitly recorded reference target);
3. at least five of the ten individual p99 values are at or below that target.

An outlier is never removed or hidden.

## Hard gates

The evaluator treats these as hard failures:

- authenticated, delivered, or acknowledged message count differs from the requested client count;
- any duplicate delivery;
- any exactly-once violation;
- any reported benchmark error;
- any lock-wait regression.

The historical B0, B0.1, P1, P2, and B0.1.1 checkpoints and their artifacts remain immutable.
