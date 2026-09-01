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
