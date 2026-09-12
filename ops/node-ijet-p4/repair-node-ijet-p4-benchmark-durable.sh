#!/bin/bash
set -euo pipefail

ROOT=/home/noemi-codex/workspace/ct105-agent-platform
MODULE=$ROOT/node-ijet
BENCH=$MODULE/benchmarks/benchmark.mjs
EXPECTED_PARENT='fix(node-ijet): migrate conformance vector dependency'
SUBJECT='fix(node-ijet): adapt benchmark harness to durable command journal'

block() {
  echo NODE_IJET_P4_BENCHMARK_FIX=BLOCKED
  echo "reason=$1"
  exit 81
}

[[ $(id -u) -ne 0 ]] || block must_not_run_as_root
[[ $# -eq 0 ]] || block arguments_not_allowed
[[ -d "$ROOT/.git" && ! -L "$ROOT" ]] || block invalid_target_repository
[[ -f "$BENCH" && ! -L "$BENCH" ]] || block invalid_benchmark_path
[[ $(git -C "$ROOT" symbolic-ref --quiet --short HEAD) = main ]] || block unexpected_branch
[[ -z $(git -C "$ROOT" status --porcelain=v1 --untracked-files=all) ]] || block target_repository_not_clean
[[ $(git -C "$ROOT" log -1 --format=%s) = "$EXPECTED_PARENT" ]] || block unexpected_parent

grep -Fq 'class BenchmarkReplayStore' "$BENCH" || block benchmark_preimage_missing
grep -Fq 'replayStore = new BenchmarkReplayStore({' "$BENCH" || block benchmark_preimage_missing
if grep -Fq 'class BenchmarkCommandJournal' "$BENCH"; then
  block benchmark_fix_already_present_without_commit
fi

python3 - "$BENCH" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text(encoding="utf-8")

anchor = '''class BenchmarkReplayStore {
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
'''

journal = '''class BenchmarkReplayStore {
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

// BENCHMARK-ONLY, NON-PRODUCTION, NON-PERSISTENT.
// #64 moved COMMAND replay/execution state to a durable CommandJournal. This
// stub deliberately advertises durability only so the historical microbenchmark
// can exercise the current COMMAND path without selecting production storage.
// Fresh-mode lookup always returns null so each timed operation measures a full
// command execution, matching the old BenchmarkReplayStore(fresh) behavior.
class BenchmarkCommandJournal {
  durable = true;
  #conflict;
  #entry = null;

  constructor({ conflict }) {
    this.#conflict = conflict;
  }

  lookup(senderNodeId, messageId) {
    if (!this.#conflict) return Promise.resolve(null);
    return Promise.resolve({
      senderNodeId,
      messageId,
      envelopeDigest: "benchmark-conflicting-envelope-digest",
      retainUntilMs: Number.MAX_SAFE_INTEGER,
      state: "terminal",
      command: {
        tableId: "benchmark",
        tableVersion: "1",
        commandId: "noop",
        requiredCapability: "command.execute:benchmark/noop",
        executionSemantics: "idempotent",
      },
      receivedAtMs: NOW,
      terminalAtMs: NOW,
      terminal: { state: "completed", result: { ok: true } },
    });
  }

  receive(input) {
    this.#entry = { ...input, state: "received" };
    return Promise.resolve({ kind: "fresh", entry: this.#entry });
  }

  start(input) {
    if (this.#entry === null) throw new Error("benchmark journal missing received entry");
    this.#entry = {
      ...this.#entry,
      state: "started",
      attemptId: input.attemptId,
      startedAtMs: NOW,
    };
    return Promise.resolve({ kind: "applied", entry: this.#entry });
  }

  markIndeterminate(senderNodeId, messageId, envelopeDigest, attemptId, indeterminateAtMs) {
    if (this.#entry === null) throw new Error("benchmark journal missing started entry");
    this.#entry = {
      ...this.#entry,
      state: "indeterminate",
      attemptId,
      indeterminateAtMs,
    };
    return Promise.resolve({ kind: "applied", entry: this.#entry });
  }

  complete(senderNodeId, messageId, envelopeDigest, attemptId, outcome, terminalAtMs, retainUntilMs) {
    if (this.#entry === null) throw new Error("benchmark journal missing started entry");
    this.#entry = {
      ...this.#entry,
      state: "terminal",
      attemptId,
      terminalAtMs,
      retainUntilMs,
      terminal: outcome,
    };
    return Promise.resolve({ kind: "applied", entry: this.#entry });
  }
}
'''

if s.count(anchor) != 1:
    raise SystemExit("BenchmarkReplayStore preimage mismatch")
s = s.replace(anchor, journal, 1)

old = '''  const core = new NodeCore({
    nodeId: localId,
    privateKey: localKeys.privateKey,
    keyFingerprint: localFingerprint,
    replayStore,
    commandRegistry: registry,
'''
new = '''  const commandJournal =
    kind === "command"
      ? new BenchmarkCommandJournal({
          conflict: scenario === "duplicate_replay_rejection",
        })
      : undefined;
  const commandExecutionPolicy =
    kind === "command"
      ? { maxResultBytes: 4096, resultRetentionMs: 60_000 }
      : undefined;
  const core = new NodeCore({
    nodeId: localId,
    privateKey: localKeys.privateKey,
    keyFingerprint: localFingerprint,
    replayStore,
    commandJournal,
    commandExecutionPolicy,
    commandRegistry: registry,
'''
if s.count(old) != 1:
    raise SystemExit("NodeCore benchmark options preimage mismatch")
s = s.replace(old, new, 1)

old_comment = '// BENCHMARK-ONLY, NON-PRODUCTION. This does not persist anything despite the durable flag.\n// The flag exists solely to reach the COMMAND processing path under measurement.'
new_comment = '// BENCHMARK-ONLY, NON-PRODUCTION. This replay stub does not persist anything.\n// COMMAND durability is modeled separately by BenchmarkCommandJournal below.'
if s.count(old_comment) != 1:
    raise SystemExit("benchmark replay comment preimage mismatch")
s = s.replace(old_comment, new_comment, 1)

for required in (
    'class BenchmarkCommandJournal',
    'commandJournal,',
    'commandExecutionPolicy,',
    'conflict: scenario === "duplicate_replay_rejection"',
):
    if required not in s:
        raise SystemExit(f"benchmark durable-journal postcondition missing: {required}")

p.write_text(s, encoding="utf-8")
PY

node --check "$BENCH" || block benchmark_syntax_check_failed

dirty=$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)
[[ "$dirty" = ' M node-ijet/benchmarks/benchmark.mjs' ]] || block unexpected_change_set
git -C "$ROOT" diff --check || block diff_check_failed
git -C "$ROOT" add -- node-ijet/benchmarks/benchmark.mjs
git -C "$ROOT" commit \
  -m "$SUBJECT" \
  -m 'Migration-only P4 compatibility correction for the #64 durable COMMAND journal; historical benchmark evidence remains untouched.'
[[ -z $(git -C "$ROOT" status --porcelain=v1 --untracked-files=all) ]] || block postcondition_worktree_dirty

echo NODE_IJET_P4_BENCHMARK_FIX=PASS
echo "head=$(git -C "$ROOT" rev-parse HEAD)"
echo "subject=$(git -C "$ROOT" log -1 --format=%s)"
echo files=node-ijet/benchmarks/benchmark.mjs
