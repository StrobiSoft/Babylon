# Cross-host B0 polling factorial evidence

- Logical task: `nb-20260902-b01-crosshost-factorial-001`
- Attempt: `1`
- Continuation of: `none`
- Authoritative benchmark code root: `146faf38307bd40cdeb44eb676a773db8d3d0f71`
- Experiment branch: `perf/nb-20260902-b01-crosshost-factorial-001`
- Production/main merge: prohibited for this experiment.

## Checkpoint 1 — preflight

- Recorded at: `2026-09-01T22:12Z` (UTC, minute precision).
- CT105 execution host: `noemi`.
- Existing SSH identity: `/home/noemi-codex/.ssh/noemi-to-babylon-ed25519`; no key or authentication configuration was created or modified.
- The system OpenSSH config is locally unusable because `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` is mode `0777`; the established path works without reading that include by using `ssh -F /dev/null` plus the existing identity.
- Read-only proof succeeded for `codex@192.168.1.90`: hostname `babylon`, `/srv/babylon/babylon-project` present, remote HEAD `0cf232d0d24ce9180e59c85616134222dc78971d`.
- The canonical VM worktree is preserved unchanged. It was on `perf/noemi-ab-poll-auth-isolation-20260901`, ahead of upstream by one commit, with pre-existing `?? ../recovery/`.
- Exact-root measurements will use isolated working directories so later experiment commits are inactive and neither canonical worktree is checked out or cleaned.
- Historical comparators were located in GitHub issue/PR evidence. The fresh CT105 B0.1 comparator is also preserved locally under `load-results/soft-chat/nb-20260901-babylon-noemi-ab-resume-002-attempt1/`.
- OpenAI/Codex usage or quota signal: none observed.

Further checkpoints, runtime manifests, all 12 raw runs, aggregates, and checksums will be added as the matrix proceeds.

## Checkpoint 2 — runtime identity and isolation plan

- CT105: hostname `noemi`; Linux `7.0.14-6-pve`; Intel Core i7-8700; 12 visible logical CPUs; cgroup v2 `cpu.max=max 100000`, `memory.max=max`; Node `v24.20.0`, npm `11.19.0`; Playwright package `1.62.1`.
- VM103: hostname `babylon`; Linux `6.12.101+deb13-amd64`; QEMU Virtual CPU 2.5+, 12 visible vCPUs; host cgroup v1 (the benchmark process has no configured CPU or memory quota); Node `v20.19.2`, npm `9.2.0`; Playwright package `1.62.1`.
- Both canonical repositories have package-lock SHA256 `3044806a283cd5798c375e5b918cec95043b91ed8dfaf8955f96628b2a07b842`; both existing dependency trees report Playwright `1.62.1`.
- VM103 browser: Chrome for Testing `151.0.7922.34`, executable SHA256 `0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71`.
- VM103 DB: dedicated `babylon-soft-chat-load-postgres`, PostgreSQL `17.10` Alpine, image ID `sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`, no container CPU/memory/cpuset limit. Config SHA256 `4634abd0a6b52710a8765d47b1b225a55f8d985f54cc503f82ec783979766983`; relevant settings: max_connections 100, shared_buffers 128MB, work_mem 4MB, effective_cache_size 4GB, synchronous_commit/fsync/full_page_writes on, random_page_cost 4, effective_io_concurrency 1.
- CT105's prior disposable PostgreSQL 17.11 and Chromium headless-shell 151 runtime was correctly stopped/removed after the prior attempt. Its preserved log and manifest prove that identity; the exact lock-defined browser and PostgreSQL 17.11 runtime must be recreated without changing benchmark code or configuration before local cells start.
- Material pre-existing confounders, intentionally documented rather than hidden: physical CT CPU versus KVM/QEMU VM CPU, Node 24 versus Node 20, npm 11 versus npm 9, PostgreSQL 17.11 Debian versus 17.10 Alpine, kernels, storage/container envelope, and cgroup implementation.
- The harness child is `backend/test/soft-chat-load-server-process.ts`; benchmark source and child hashes will be recorded from exact root. Measurement semantics: ramp and warm-up precede the steady message window; business-latency histograms and diagnostic baselines reset after warm-up; `durationMs` spans steady sends through ACK completion; polling remains completion-relative in all cells.
- A/B and C/D will differ only by `SOFT_CHAT_LOAD_POLL_INTERVAL_MS=50` versus `500`. All cells use 500 clients, independent-streaming, pool 20, ramp 5000 ms, warm-up 2000 ms, separate server, auth isolation none, and exact root `146faf38307bd40cdeb44eb676a773db8d3d0f71`.

## Checkpoint 3 — VM103 A/B complete

- VM run root: `/tmp/nb-20260902-b01-crosshost-factorial-001-vm-root/babylon-project`, detached exact HEAD `146faf38307bd40cdeb44eb676a773db8d3d0f71`; only an ignored `node_modules` symlink points to the canonical lock-installed tree.
- Benchmark harness SHA256: `f7e78f21b97ead851159da4490a684c5a88b51c4fd3236d979f93fa3b654b943`; separate child SHA256: `19059e4558f7482549812bc6f0734c7feaca1b2d951d2814c12a1171b9334d75`.
- A (VM103, 50 ms) valid runs: throughput `125.72 / 126.39 / 113.82 msg/s`; p99 `3811.44 / 3818.41 / 4225.92 ms`; each delivered and ACKed `500/500`, with zero structured errors, duplicates, exactly-once violations, lock wait, residual child, or residual schema.
- B (VM103, 500 ms) valid runs: throughput `140.02 / 137.74 / 134.01 msg/s`; p99 `3499.18 / 3471.85 / 3571.51 ms`; each delivered and ACKed `500/500`, with zero structured errors, duplicates, exactly-once violations, lock wait, residual child, or residual schema.
- All six Vitest exits are `1` solely because the unchanged 2000 ms p99 threshold was exceeded. They are valid performance observations, not correctness failures.
- Raw JSON/CSV/TXT, full run logs, exit status, and per-run checksums are preserved under `load-results/soft-chat/nb-20260902-b01-crosshost-factorial-001-attempt1/{A_VM103_50,B_VM103_500}/`.
