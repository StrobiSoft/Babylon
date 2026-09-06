# Babylon Benchmark Box 1.0

## Purpose

`Babylon Benchmark Box 1.0` is the reusable least-privilege execution profile for recurring Babylon performance and benchmark work on VM103.

It is designed so a benchmark operator can independently prepare, run, repeat, log, analyse, and archive controlled Babylon benchmark experiments without receiving general VM103 administrator access and without being able to modify production Babylon by accident.

This document is a **template and policy definition**, not an authorization by itself. Deploying or expanding the profile remains a separate controlled infrastructure change.

## Core design rules

1. Benchmark work is isolated from the production Babylon tree, production database, production containers, credentials, and runtime controls.
2. The benchmark identity receives only the capabilities required for benchmark preparation, execution, telemetry, and artifact retrieval.
3. No unrestricted `sudo`, root shell, Docker group membership, general `systemctl`, package-management authority, or arbitrary production control is granted.
4. All elevated actions are exposed as fixed semantic operations through a root-owned gate/helper.
5. Production promotion is never an automatic consequence of a successful benchmark. A winning experiment returns to the normal branch/PR/review/owner-approval workflow.
6. Every benchmark must preserve reproducibility: exact commit/ref, configuration, environment tuple, raw artifacts, aggregate results, and checksums.
7. New privileges are added only when a concrete benchmark requirement proves they are necessary. “Might be useful later” is not sufficient justification.

---

## 1. Benchmark identity

Default dedicated identity:

```text
user: noemi-bench
purpose: Babylon benchmark execution only
interactive_admin: false
production_admin: false
```

The benchmark identity must be separate from:

- `root`;
- production Babylon service accounts;
- `codex` or other agent identities;
- generic maintenance users.

The account must not be placed in the `docker`, `sudo`, or equivalent privileged groups.

---

## 2. Filesystem layout

Recommended dedicated benchmark root:

```text
/srv/noemi-babylon-lab/
```

Recommended subdirectories:

```text
/srv/noemi-babylon-lab/worktrees/    benchmark Git worktrees / source variants
/srv/noemi-babylon-lab/results/      raw and aggregate benchmark artifacts
/srv/noemi-babylon-lab/logs/         benchmark-owned execution logs
/srv/noemi-babylon-lab/tmp/          disposable benchmark temporary data
/srv/noemi-babylon-lab/manifests/    run manifests, hashes, provenance metadata
```

The benchmark identity receives read/write/delete permission only inside its benchmark root and other explicitly named benchmark-owned paths.

### Production tree boundary

The production Babylon tree, for example:

```text
/srv/babylon
```

must not be directly writable by `noemi-bench`.

If production source is needed as a benchmark starting point, create or refresh an isolated benchmark worktree/clone from an exact commit or approved ref. The benchmark must never mutate the live production checkout in place.

---

## 3. Artifact and log permissions

`noemi-bench` may create, modify, rotate, archive, hash, compress, and delete benchmark-owned files under the benchmark artifact paths.

Expected artifact types include:

- JSON reports;
- CSV summaries;
- stdout/stderr logs from benchmark-owned processes;
- benchmark manifests;
- exact configuration snapshots without secrets;
- checksums;
- aggregate statistics;
- diagnostic telemetry captured through approved readers.

Default storage guardrail:

```text
soft quota target: 20-30 GiB
```

The concrete quota may be adjusted later, but benchmark output must not be able to fill the VM103 root filesystem silently.

---

## 4. Normal unprivileged execution rights

The benchmark identity may run the tools already installed for Babylon benchmark development, including as applicable:

- `git`;
- Node.js;
- npm/pnpm or the repository-selected package manager;
- TypeScript tooling;
- Vitest and existing Babylon test runners;
- existing Babylon benchmark/load-harness commands;
- hashing/compression tools needed for benchmark artifacts.

It may start, inspect, and stop **its own processes**.

It may not signal, trace, attach to, or terminate production or other users' processes except through an explicitly allowlisted benchmark semantic action.

Package installation or OS dependency changes are not part of this profile.

---

## 5. Benchmark database isolation

Recommended dedicated PostgreSQL resources:

```text
database: babylon_bench
role:     noemi_bench
```

Within `babylon_bench`, the benchmark role may receive full benchmark-local DDL/DML capability required by the test harness, including:

- migrations;
- create/alter/drop benchmark tables;
- insert/update/delete;
- truncate/reset benchmark state;
- benchmark fixture creation and cleanup.

### Production PostgreSQL boundary

The benchmark identity must not receive production database ownership, superuser, replication, role-management, or production write permission.

Production secrets must not be copied into benchmark artifacts or manifests.

If read-only production-derived structural information is ever required, expose only the smallest explicitly approved semantic query or sanitized export; do not grant broad production DB access by default.

---

## 6. Docker/container control

Do **not** add `noemi-bench` to the Docker group.

Container operations must pass through a root-owned fixed gate, for example:

```text
/usr/local/sbin/noemi-babylon-bench
```

Suggested semantic actions:

```text
bench-up
bench-down
bench-restart
bench-status
bench-logs
bench-stats
```

The gate must:

- accept only exact allowlisted actions;
- operate only on explicitly named Babylon benchmark compose projects/containers;
- reject arbitrary container names;
- reject arbitrary command arguments;
- reject `docker exec <arbitrary command>`;
- reject Docker socket passthrough;
- reject operations on production or unrelated containers.

If the benchmark harness does not require container lifecycle control for a given run, those actions should not be invoked.

---

## 7. Telemetry permissions

The benchmark identity must be able to obtain enough telemetry to explain benchmark results without acquiring general host-administration capability.

Approved telemetry should be exposed through fixed read-only operations such as:

```text
bench-status
bench-logs
bench-stats
bench-pg-metrics
bench-runtime-metrics
```

Typical allowed data:

- benchmark container state;
- benchmark container CPU/memory statistics;
- benchmark-specific logs;
- benchmark PostgreSQL connection/pool/wait metrics;
- PostgreSQL wait/lock counters relevant to the benchmark DB;
- Node.js/server and driver CPU/event-loop telemetry already emitted by the harness;
- normal non-sensitive `/proc` data readable by an unprivileged user.

Do not grant broad `systemd-journal` membership, unrestricted journal access, arbitrary production log access, or general host tracing by default.

Hardware performance counters, CPU affinity, elevated tracing, eBPF, `perf`, or similar capabilities require a separate narrowly scoped extension when a specific hypothesis requires them.

---

## 8. CT105 -> VM103 access

Recommended route:

```text
CT105 -> VM103 -> noemi-bench
```

Authentication:

- dedicated keypair for this purpose;
- key accepted only for the benchmark identity;
- source restricted to CT105 where technically practical;
- no password authentication for the benchmark path.

Recommended SSH restrictions:

```text
no agent forwarding
no X11 forwarding
no port forwarding unless explicitly required by a recorded benchmark design
no arbitrary root login
```

Preferred design: a root-owned forced-command or equivalent `noemi-babylon-gate` wrapper that exposes the benchmark semantic actions while preserving normal unprivileged benchmark workspace access as narrowly as practical.

The CT105 route must not become a generic VM103 administrator shell merely because benchmark automation needs to reach VM103.

---

## 9. Artifact readback

The benchmark operator must be able to retrieve the results it created.

Recommended semantic operations:

```text
artifact-list
artifact-read
artifact-pack
artifact-hash
```

These operations must be restricted to the benchmark artifact root.

They must not provide arbitrary VM103 filesystem read access.

---

## 10. Explicitly denied by default

`Babylon Benchmark Box 1.0` does **not** grant:

- unrestricted `sudo`;
- root shell;
- membership in `docker` or equivalent root-capable groups;
- arbitrary Docker socket access;
- `apt`, `dnf`, package installation, kernel/module changes;
- reboot, shutdown, suspend, or VM lifecycle control;
- firewall, routing, interface, DNS, or other network configuration changes;
- unrestricted `systemctl`;
- unrestricted journal access;
- `/etc` write access;
- SSH private-key, token, password, credential, certificate, or secret-store access;
- production `.env` access;
- production PostgreSQL administrative or write access;
- modification of the production Babylon checkout;
- production deployment or release authority;
- public listener or firewall-port creation;
- destructive Git operations against protected or production refs;
- automatic merge or promotion of a benchmark winner.

Any future exception requires explicit, separately recorded authorization and should be temporary where possible.

---

## 11. Benchmark lifecycle

Every benchmark series should follow this lifecycle.

### PRE-FLIGHT

Record and verify:

```text
BENCHMARK_ID
operator identity
VM/host target
exact Git commit/ref
benchmark worktree cleanliness
harness version
client count
pool size
polling mode/cadence
ramp and warm-up
server topology
benchmark DB identity
required container set
required telemetry
free disk space / quota headroom
expected output directory
rollback/cleanup path
```

Do not start the benchmark if the execution path, code provenance, database isolation, storage headroom, or required telemetry is unknown.

### PREPARE

- create/select isolated benchmark worktree;
- validate exact commit/ref;
- run proportionate format/lint/typecheck/unit/integration gates;
- initialize/reset only `babylon_bench`;
- start only required benchmark services;
- create a unique non-overwriting result directory;
- write manifest before the first measured run.

### RUN

- execute the preregistered workload;
- preserve each repetition independently;
- never overwrite prior raw artifacts;
- capture correctness and performance metrics together;
- stop the series on a hard correctness or environment-integrity failure.

### FINALIZE

- aggregate results;
- hash all artifacts;
- record exact commit/config/runtime tuple;
- record controlled skips and failed runs rather than hiding them;
- stop benchmark-owned services/processes;
- leave production untouched;
- preserve evidence before cleanup of disposable state.

---

## 12. Standard B1.0 A/B experiment profile

For the current Babylon performance investigation, the reusable starting sequence is:

```text
B1.0 control
A
B
A+B only when justified by the isolated results
```

The exact B1.0 name must be bound to a specific code/config/harness/runtime tuple before the series begins.

A and B must change only their preregistered experimental factors. All other measurement-envelope variables remain fixed unless the experiment explicitly studies that variable.

The initial expected comparison envelope includes the established factors such as:

```text
500 clients
pool size 20 unless the preregistration says otherwise
500 ms polling where B1.0 requires it
5 s ramp where B1.0 requires it
2 s warm-up where B1.0 requires it
separate-server topology where B1.0 requires it
500/500 correctness target
zero duplicates
zero exactly-once violations
```

Do not silently redefine B1.0 if the runtime envelope changes materially. Record a new reference tuple instead.

---

## 13. Minimum correctness gates

A performance result is not promotable if correctness is broken.

At minimum, record and require as applicable:

```text
messages attempted
messages delivered
ACK count
duplicate deliveries
exactly-once violations
unexpected errors
PostgreSQL lock/wait regressions
benchmark service health
```

For the established 500-client Soft Chat series, the expected hard correctness target remains:

```text
500/500 delivered and acknowledged
0 duplicate delivery
0 exactly-once violation
no unexplained error or lock regression
```

Performance improvements with correctness failure are classified as failed experiments, not wins.

---

## 14. Result provenance

Each run/series should preserve a manifest similar to:

```yaml
benchmark_box: Babylon Benchmark Box 1.0
benchmark_id: <unique-id>
timestamp_utc: <timestamp>
operator: noemi-bench
vm: 103
host: <hostname>
git_commit: <sha>
git_branch_or_ref: <ref>
worktree_clean_before_run: true
harness_commit: <sha>
clients: <count>
pool_max: <count>
poll_interval_ms: <ms>
pending_schedule: <mode>
ramp_ms: <ms>
warmup_ms: <ms>
server_topology: <mode>
database: babylon_bench
result_dir: <path>
repetitions: <count>
artifact_manifest: <path>
artifact_hash_algorithm: sha256
```

Do not place secrets, tokens, private keys, database passwords, `.env` contents, or credentials in the manifest.

---

## 15. Cleanup and persistence

Persistent by default:

- benchmark source refs/checkpoints that are needed for reproducibility;
- final manifests;
- aggregate results;
- raw artifacts required to reproduce the conclusion;
- hashes/provenance.

Disposable after evidence is safely preserved:

- temporary benchmark DB contents;
- temporary process state;
- scratch directories;
- transient unpacked bundles;
- test-only runtime data that is not evidence.

Cleanup must never target production paths or databases.

---

## 16. Permission extension procedure

When a benchmark cannot proceed with this profile:

1. identify the exact missing capability;
2. state why existing unprivileged or semantic actions are insufficient;
3. define the smallest new action/capability that resolves the blocker;
4. define its path/container/database/process scope;
5. define stop/rollback and audit behavior;
6. obtain explicit owner authorization;
7. prefer a temporary or revocable extension;
8. remove or retire it after the benchmark unless recurring need is proven.

Examples of capabilities that must use this procedure:

- hardware performance counters;
- CPU pinning/affinity requiring privilege;
- eBPF or kernel tracing;
- temporary network shaping;
- benchmark-specific system-service restart not already allowlisted.

---

## 17. Deployment checklist

Before declaring a VM103 installation of Babylon Benchmark Box 1.0 active, verify:

```text
[ ] dedicated noemi-bench identity exists
[ ] noemi-bench is not in sudo/docker/admin groups
[ ] benchmark root ownership and permissions are correct
[ ] artifact quota/guardrail is active
[ ] production Babylon tree is not writable
[ ] dedicated babylon_bench DB and role are isolated
[ ] production DB is not writable/admin-accessible
[ ] root-owned benchmark gate is exact-action allowlisted
[ ] arbitrary Docker exec/socket access is impossible
[ ] telemetry actions are read-only and benchmark-scoped
[ ] CT105 SSH identity/source restrictions are correct
[ ] forwarding features are disabled unless explicitly approved
[ ] artifact readback is restricted to benchmark paths
[ ] no secrets are exposed through logs/manifests
[ ] negative tests prove denied operations remain denied
[ ] positive E2E benchmark dry-run succeeds
[ ] production services remain unchanged after the dry-run
```

Activation is complete only after both positive and negative E2E verification.

---

## 18. Versioning

This profile is **Babylon Benchmark Box 1.0**.

A change that materially expands privilege, production visibility, execution authority, network access, or database scope must not be silently folded into 1.0. Record and review it explicitly, and bump the profile version when the security contract changes materially.

Small implementation corrections that preserve the same security contract may remain within the 1.0 profile with normal revision history.

---

## Summary contract

Babylon Benchmark Box 1.0 grants the benchmark operator enough authority to:

```text
prepare isolated Babylon benchmark worktrees
modify benchmark-only test code/configuration
run test and benchmark tooling
own/reset a dedicated benchmark database
control only benchmark containers through fixed semantic actions
read benchmark-scoped telemetry
create and manage benchmark logs/artifacts
retrieve and hash benchmark evidence
repeat B1.0/A/B/A+B experiments reproducibly
```

while deliberately withholding authority to:

```text
administer VM103 generally
control Docker generally
modify production Babylon
write/administer the production database
read secrets
change host/network/security configuration
promote or deploy a benchmark result automatically
```

That separation is the defining property of Babylon Benchmark Box 1.0.
