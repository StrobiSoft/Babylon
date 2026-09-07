# Issue #57 DrainMap-500 diagnostic

Status: checkpoint only; no benchmark was launched while preparing this checkpoint.

## Name and historical mapping

**DrainMap-500** is the canonical operator and documentation name for the owner-approved issue #57 arrival-shape/rank-latency diagnostic.

Historical mapping:

- `DrainMap-500` = the diagnostic previously referred to as issue #57 "canonical C";
- `Legacy-C(pool40)` = the older historical experiment in which `C` referred to a pool-size-40 change;
- `E1-2W` = the later two-server-worker experiment;
- `E2-4W` = the later four-server-worker experiment.

The rename is intentional human-factors cleanup. The overloaded `C` label had acquired multiple meanings and could cause avoidable operator ambiguity. The measurement methodology is unchanged.

The pinned instrumentation patch predates this rename. To avoid invalidating a fully reviewed patch solely for cosmetic identifier churn, several internal compatibility identifiers still contain `canonical-c` (including the patch filename, two test helper filenames, one environment flag and raw artifact suffixes). Those strings are implementation compatibility aliases only and must not be used as the current operator-facing experiment name.

## Scope and fixed workload

`run.sh` runs only DrainMap-500. It does not run E1-2W or E2-4W and does not change Babylon production code or behavior.

The runner refuses to proceed unless the protected Delta 1.1 checkout is clean at `296d4c104a437475e01c7598501ae073e439461e`. It creates a separate detached worktree and applies the hash-pinned `issue57-canonical-c.patch`, whose changes are limited to these benchmark/test files:

- `babylon-project/backend/test/soft-chat-load.e2e.test.ts`
- `babylon-project/backend/test/soft-chat-load-server-process.ts`
- `babylon-project/backend/test/soft-chat-canonical-c-config.ts`
- `babylon-project/backend/test/soft-chat-canonical-c-config.test.ts`

The patch adds only observation and artifact emission. A runtime guard refuses the DrainMap-500 run unless all fixed settings match:

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

## Artifacts and provenance

The durable root is date-neutral:

`/srv/noemi-babylon-lab/results/drainmap-500/primary/`

The corresponding log is:

`/srv/noemi-babylon-lab/logs/drainmap-500-primary.log`

This deliberately avoids embedding the checkpoint-preparation date in the evidence path. The actual run timestamps remain inside the generated result artifacts and log.

The existing `.json`, `.csv`, and `.txt` load artifacts remain. The pinned instrumentation currently also writes compatibility-suffixed raw artifacts:

- `soft-chat-load-*.canonical-c-messages.jsonl`: one row per logical message with request ID, send rank, client/sender/recipient identity, send/accept/visible/ACK monotonic timestamps, and derived latency intervals;
- `soft-chat-load-*.canonical-c-timeline.jsonl`: time-ordered raw samples on the driver `performance.timeOrigin + performance.now()` axis, including aligned child/server samples;
- `soft-chat-load-*.canonical-c-schema.json`: schema version, clock declaration, units, artifact names, message fields and timeline kinds;
- `SHA256SUMS`: hashes for the complete `soft-chat-load-*` artifact set;
- `.done`: written only after the 500/500 correctness and raw-artifact gates pass.

The enclosing evidence set, operator status markers and durable paths are all DrainMap-500. The legacy raw suffix is retained only to preserve the already-reviewed instrumentation patch hash.

The timeline preserves in-flight, cumulative-started and cumulative-completed send counts; pending-fetch in-flight/request counts; pool waiting; reconnect/steady-window connection-acquisition events for authentication, accept, pending fetch and ACK; and sampled server CPU, event-loop utilization and event-loop-delay p99. These raw rows support later rank buckets, correlation, fitted drain slope and residual analysis without launching a follow-on experiment.

## Fail-closed behavior

The runner stops rather than silently reusing or overwriting uncertain evidence when it sees:

- a Delta 1.1 commit mismatch or dirty base checkout;
- a missing or hash-mismatched instrumentation patch;
- an occupied or drifted DrainMap-500 worktree;
- incomplete existing artifacts requiring manual review;
- an instrumentation scope mismatch;
- a missing browser/runtime prerequisite;
- a failed 500/500 correctness gate or incomplete raw trace.

A completed `.done` evidence set is treated as complete rather than automatically rerun.

## Drift reconciliation and rollback

Historical VM103 evidence before reconciliation must remain in the handoff:

- control branch: `ops/noemi-benchmark-control`
- old control HEAD: `65d2de2f3ba2fa7f35a4004c8564ca45cc6ea618`
- `run.sh` tracked mode: `100644`
- `run.sh` working mode: `100755`
- content insertion/deletion delta: zero
- content SHA-256: `70d6baeda865d474d8bf8eead48147afd0a1e909653a25c7989d0c9c27d25757`
- adjudication: accepted mode-only, non-semantic drift; the temporary B1/A/B readback content is not carried forward

Before reconciliation, repeat the read-only HEAD, status, mode, diff-stat and SHA-256 checks. Any content drift is a hard stop. Install `bbb1-enable-drainmap-control-actions.sh` through the existing host-root maintenance deployment procedure, then use these no-argument allowlisted actions in order:

1. `babylon-bench-control-status` records the current branch, HEAD, index/working mode, blob, SHA-256, status, numstat and mode summary.
2. `babylon-bench-control-normalize-run-mode` accepts only the adjudicated `65d2de2f3ba2fa7f35a4004c8564ca45cc6ea618` mode-only drift with the recorded blob and SHA-256, and normalizes it to the tracked `0644` mode.
3. `babylon-bench-control-sync-drainmap-500` accepts only that now-clean checkpoint and syncs it to reviewed PR #66 head `ced87ef48486a47ecc3404689ceb139fc26b1be1`. The action verifies the new runner blob, content hash and `0755` mode.

All three actions reject arguments. The mutating actions are idempotent and reject an unexpected branch, HEAD, content identity, worktree status or remote source head. Do not force-reset VM103 directly.

Rollback is the current remote control checkpoint `4ca023f49fd82a7345436b32abb2aa733a2e3cc2`. Re-pointing the control checkout to that checkpoint restores the auxiliary reference-triplicate runner; it must not be invoked as DrainMap-500.
