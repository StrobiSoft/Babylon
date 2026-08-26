# Soft Chat capacity harness

This opt-in harness measures the real Fastify/PostgreSQL Soft Chat delivery and acknowledgement
path. It runs two deliberately different client models so session hot-row contention and phased
harness delay can be separated from production delivery behavior:

- `shared-phased` is the historical control. Two accounts are created through the real invitation,
  email-verification, WebAuthn, PKCE, callback, and token-exchange flow. Every virtual client shares
  those two sessions, all sends finish before batched pending/ACK processing starts, and the result
  intentionally preserves the old benchmark's contention and phasing.
- `independent-streaming` seeds test-only users, devices, and authenticated sessions directly into
  the run's ephemeral schema. Every virtual sender/recipient pair has independent session/device
  rows, and its pending/ACK loop runs continuously before and alongside its send. This models already
  authenticated independent clients; it does not measure passkey enrollment capacity and never
  bypasses production HTTP authentication, delivery, pending, or acknowledgement handling.

The database is never truncated. Each run creates a uniquely named PostgreSQL schema, applies all
versioned migrations within it, and drops it during cleanup. Non-loopback PostgreSQL hosts are
rejected unless `ALLOW_REMOTE_LOAD_DATABASE=1` is explicitly set for a dedicated test instance.

Run from `babylon-project/`:

```bash
RUN_SOFT_CHAT_LOAD=1 \
TEST_DATABASE_URL='postgresql://babylon_test:babylon_test@127.0.0.1:5432/babylon_load' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome \
npm run load:soft-chat
```

Optional controls are `SOFT_CHAT_LOAD_STAGES`, `SOFT_CHAT_LOAD_MAX_ERROR_RATE` (default `0.01`),
`SOFT_CHAT_LOAD_MAX_P99_MS` (default `2000`), `SOFT_CHAT_LOAD_OUTPUT_DIR`, and
`SOFT_CHAT_LOAD_MODES` (default `shared-phased,independent-streaming`). Each mode stops escalating
after its first failed stage, but the next requested mode still runs so the control remains
comparable. A stage fails when authentication or message/ACK errors exceed 1%, send-to-ACK p99
exceeds two seconds, a duplicate is observed, or the readiness endpoint becomes unhealthy.
`SOFT_CHAT_LOAD_POLL_INTERVAL_MS` controls the independent receivers' bounded polling cadence and
defaults to 50 ms; the report records the resulting pending-fetch request count. Set
`SOFT_CHAT_LOAD_COMPARISON=1` only for a bounded, explicitly requested comparison matrix: it runs
every listed stage even if an earlier stage misses a quality threshold, while preserving all FAIL
results and never adding stages beyond the requested list.
`SOFT_CHAT_LOAD_POOL_MAX` is a benchmark-only override for the harness-owned PostgreSQL pool and
defaults to the production value of 20. It accepts integers from 1 through 200, is recorded in the
JSON report, and does not change the production database class or its default.
`SOFT_CHAT_LOAD_CLIENT_RAMP_MS` distributes virtual-client authentication and receiver startup over
the configured number of milliseconds. `SOFT_CHAT_LOAD_WARMUP_MS` keeps the independent pending/ACK
workers running for a fixed warm-up after the final client is ready. Both default to zero so the
historical control remains reproducible. Account/session/device seeding and diagnostic baseline
queries occur before either measured window.

For the focused 100/500 comparison on Pepper, use:

```bash
RUN_SOFT_CHAT_LOAD=1 \
SOFT_CHAT_LOAD_COMPARISON=1 \
SOFT_CHAT_LOAD_STAGES='100,500' \
SOFT_CHAT_LOAD_MODES='shared-phased,independent-streaming' \
TEST_DATABASE_URL='postgresql://babylon_test:babylon_test@127.0.0.1:5432/babylon_load' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/playwright/chrome \
npm run load:soft-chat
```

For the focused three-run 500-client reconnect-versus-steady-state isolation on Pepper, keep the
production pool default and polling cadence explicit:

```bash
for run in 1 2 3; do
  RUN_SOFT_CHAT_LOAD=1 \
  SOFT_CHAT_LOAD_STAGES='500' \
  SOFT_CHAT_LOAD_MODES='independent-streaming' \
  SOFT_CHAT_LOAD_POOL_MAX=20 \
  SOFT_CHAT_LOAD_POLL_INTERVAL_MS=50 \
  SOFT_CHAT_LOAD_CLIENT_RAMP_MS=5000 \
  SOFT_CHAT_LOAD_WARMUP_MS=2000 \
  SOFT_CHAT_LOAD_OUTPUT_DIR="load-results/soft-chat/reconnect-isolation-${run}" \
  TEST_DATABASE_URL='postgresql://babylon_test:babylon_test@127.0.0.1:5432/babylon_load' \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/playwright/chrome \
  npm run load:soft-chat || true
done
```

The `|| true` allows all three controlled repetitions to run when the unchanged quality threshold
correctly marks an individual run as `FAIL`; each report retains the failure and its reason.

The report separates a reconnect/ramp window from the steady-state message window. After the final
client starts, the configured warm-up completes, the pool state is recorded, and business latency
histograms plus diagnostic baselines are reset. Only the steady-state send-to-ACK p99 is compared
with the unchanged two-second threshold.

The JSON report records p50/p95/p99/max for database-connection acquisition during authentication,
`MessageDeliveryService.accept`, pending fetch, and acknowledgement in each window. It also records
p50/p95/p99/max for the existing service and end-to-end latencies. PostgreSQL pool total/idle/waiting
counts, active connection maxima, and PostgreSQL diagnostics are reported independently for both
windows. When permissions permit, it also samples
`pg_stat_activity` wait events, bounded lock-wait query/blocker details, and includes per-stage
deltas for the top `pg_stat_statements` queries by total execution time. Missing activity and
statement diagnostics are reported independently and do not silently change the latency result.

Timestamped JSON, CSV, and text summaries are written under
`load-results/soft-chat/` by default. This generated directory is ignored by Git.
