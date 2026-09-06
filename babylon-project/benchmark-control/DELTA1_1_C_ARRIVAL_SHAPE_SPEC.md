# Δ1.1 C — arrival-shape / rank-latency diagnostic

Status: approved measurement definition

## Purpose

Replace the previous C/D parameter-resizing experiments with a diagnostic experiment that distinguishes a finite batch-drain/capacity ceiling from per-message critical-path outliers.

This experiment MUST NOT change Babylon production behavior. Instrumentation is benchmark-only.

## Baseline

Run on the exact current Δ1.1 state (historical B state):

- commit identity on VM103: `296d4c104a437475e01c7598501ae073e439461e`
- workload: 500 clients
- mode: `independent-streaming`
- pool: 20
- poll interval: 500 ms
- pending scheduler: fixed-grid
- client ramp: 5000 ms
- warmup: 2000 ms
- separate server process: enabled
- comparison mode: enabled
- database: isolated `babylon_bench` on port 55433
- correctness guardrails unchanged

## Required per-message trace fields

For every logical message, record one durable trace row keyed by the message/test identifier containing at least:

1. `send_rank` — monotonic order in which send start was initiated in the measured 500-message set.
2. `send_start_ts_ms` — monotonic high-resolution timestamp immediately before the HTTP send request is initiated.
3. `accept_ts_ms` — timestamp when the sender observes successful server acceptance, if separately observable.
4. `visible_ts_ms` — timestamp when the recipient first observes the message in pending-fetch/visibility processing.
5. `ack_ts_ms` — timestamp when ACK completes successfully.
6. Derived intervals: `send_to_accept_ms`, `accept_to_visible_ms`, `send_to_visible_ms`, `visible_to_ack_ms`, `send_to_ack_ms`.
7. Receiver/client identity or rank sufficient to correlate fan-out and avoid conflating multiple clients.

Use the same monotonic clock domain for all driver-side timestamps. Do not use wall-clock timestamps to compute latency.

## Required aggregate output

In addition to all existing Δ1.1 metrics, emit:

- rank-vs-send→ACK correlation (Spearman and Pearson where meaningful)
- rank-vs-send→visible correlation
- linear slope estimate in ms/message for send→ACK and send→visible
- p50/p90/p95/p99 for rank buckets `1-50`, `51-100`, ..., `451-500`
- first 10 and worst 10 per-message rows
- queue/drain estimate: messages/sec inferred from the fitted rank-latency slope, when the fit is meaningful
- residual/outlier summary after removing the fitted rank trend
- existing pool waiting, pending-fetch count, authentication/accept/pending/ACK p99 and correctness counters

Preserve the raw per-message trace as CSV or JSONL alongside the normal benchmark artifacts.

## Interpretation gates

### C1 — batch-drain/capacity ceiling supported

Treat the batch-drain hypothesis as strongly supported when send→visible and/or send→ACK latency rises materially with message rank, the fitted trend explains a substantial part of tail variance, and late-rank buckets are systematically slower than early-rank buckets.

### C2 — per-message critical-path hotspot supported

Treat the critical-path/outlier hypothesis as stronger when rank has little explanatory power but a subset of messages have large residual latency spikes, especially if one internal interval (auth, accept→visible, pending, visible→ACK) dominates those residuals.

### C3 — mixed mechanism

If a rank trend exists but large residual outliers remain, classify as mixed: finite drain capacity plus one or more independent contention/hotspot mechanisms.

Do not promote a new Δ state from this diagnostic alone. Use its evidence to select the next single-variable optimization experiment with Zoltán.

## Retired experiments

The previous pool-only C (`POOL_MAX=40`) and polling-resize D (`POLL_INTERVAL_MS=750`) are not part of this round. Their historical results remain evidence and must not be deleted or rewritten.
