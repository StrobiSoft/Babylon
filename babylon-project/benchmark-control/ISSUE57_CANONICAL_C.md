# Issue #57 canonical C diagnostic

Status: checkpoint only; no benchmark was launched while preparing this checkpoint.

## Scope and fixed workload

`run.sh` runs only the owner-approved issue #57 C arrival-shape/rank-latency diagnostic. It does not run E1 or E2 and does not change Babylon production code or behavior.

The runner refuses to proceed unless the protected Delta 1.1 checkout is clean at `296d4c104a437475e01c7598501ae073e439461e`. It creates a separate detached worktree and applies `issue57-canonical-c.patch`, whose changes are limited to these benchmark-test files:

- `babylon-project/backend/test/soft-chat-load.e2e.test.ts`
- `babylon-project/backend/test/soft-chat-load-server-process.ts`
- `babylon-project/backend/test/soft-chat-canonical-c-config.ts`
- `babylon-project/backend/test/soft-chat-canonical-c-config.test.ts`

The patch adds only observation and artifact emission. A runtime guard refuses a canonical-C run unless all fixed settings match:

- 500 independent-streaming clients
- PostgreSQL pool max 20
- 500 ms poll interval
- fixed-grid pending scheduler
- 5000 ms client ramp
- 2000 ms warmup
- separate server process
- comparison mode enabled
- the Delta 1.1 pending-auth behavior unchanged (`none`)
- isolated `babylon_bench` database on loopback port 55433

## Artifacts

The durable root is:

`/srv/noemi-babylon-lab/results/issue57-canonical-c-20260907/canonical-c/`

The existing `.json`, `.csv`, and `.txt` load artifacts remain. Canonical C also writes:

- `soft-chat-load-*.canonical-c-messages.jsonl`: one row per logical message with request ID, send rank, client/sender/recipient identity, send/accept/visible/ACK monotonic timestamps, and the derived send-to-accept, accept-to-visible, send-to-visible, visible-to-ACK, and send-to-ACK intervals.
- `soft-chat-load-*.canonical-c-timeline.jsonl`: time-ordered raw samples on the driver `performance.timeOrigin + performance.now()` axis. The runner calibrates the child/server clock over seven IPC round trips, uses the lowest-round-trip offset, records that calibration, and aligns child samples to the driver axis. Row kinds are `driver-concurrency`, `db-pool`, `server-runtime`, and `connection-acquisition`.
- `soft-chat-load-*.canonical-c-schema.json`: schema version, clock declaration, units, artifact names, message fields, and timeline kinds.
- `SHA256SUMS`: hashes for the complete `soft-chat-load-*` artifact set.
- `.done`: written only after the 500/500 correctness and raw-artifact gates pass.

The timeline preserves in-flight, cumulative-started, and cumulative-completed send counts; pending-fetch in-flight/request counts; pool waiting; reconnect/steady-window connection-acquisition events for authentication, accept, pending fetch, and ACK; and sampled server CPU, event-loop utilization, and event-loop-delay p99. These raw rows support later rank buckets, correlation, fitted drain slope, and residual analysis without launching any follow-on experiment.

The corresponding log is:

`/srv/noemi-babylon-lab/logs/issue57-canonical-c-20260907.log`

## Drift reconciliation and rollback

Historical VM103 evidence before reconciliation must remain in the handoff:

- control branch: `ops/noemi-benchmark-control`
- old control HEAD: `65d2de2f3ba2fa7f35a4004c8564ca45cc6ea618`
- `run.sh` tracked mode: `100644`
- `run.sh` working mode: `100755`
- content insertion/deletion delta: zero
- content SHA-256: `70d6baeda865d474d8bf8eead48147afd0a1e909653a25c7989d0c9c27d25757`
- adjudication: accepted mode-only, non-semantic drift; the temporary B1/A/B readback content is not carried forward

Before reconciliation, repeat the read-only HEAD, status, mode, diff-stat, and SHA-256 checks. Any content drift is a hard stop. If the evidence remains mode-only, use the allowlisted control-repository maintenance reconciliation, then sync the reviewed checkpoint branch. Do not force-reset VM103 directly.

Rollback is the current remote control checkpoint `4ca023f49fd82a7345436b32abb2aa733a2e3cc2`. Re-pointing the control checkout to that checkpoint restores the auxiliary reference-triplicate runner; it must not be invoked as canonical C.
