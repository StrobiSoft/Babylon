#!/bin/bash
set -euo pipefail

LAB=/srv/noemi-babylon-lab
BASE="$LAB/worktrees/b-exact"
WORKTREE="$LAB/worktrees/issue57-canonical-c"
DELTA=296d4c104a437475e01c7598501ae073e439461e
CONTROL_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PATCH="$CONTROL_DIR/issue57-canonical-c.patch"
PATCH_SHA256=3c2c52a1111409600ef54e2b94db3110319dcd788f174dd16c6fc152b5f93095
ROOT="$LAB/results/issue57-canonical-c-20260907"
OUT="$ROOT/canonical-c"
LOG="$LAB/logs/issue57-canonical-c-20260907.log"

blocked() {
  echo ISSUE57_CANONICAL_C=BLOCKED
  echo "reason=$1"
  exit "${2:-80}"
}

test -e "$BASE/.git" || blocked exact_delta11_checkout_missing 81
test "$(git -C "$BASE" rev-parse HEAD)" = "$DELTA" || blocked exact_delta11_commit_mismatch 82
test -z "$(git -C "$BASE" status --porcelain)" || blocked exact_delta11_checkout_not_clean 83
test -f "$PATCH" || blocked instrumentation_patch_missing 84
test "$(sha256sum "$PATCH" | awk '{print $1}')" = "$PATCH_SHA256" || \
  blocked instrumentation_patch_hash_mismatch 85

mkdir -p "$ROOT" "$LAB/logs" "$LAB/worktrees"
if [ -f "$OUT/.done" ]; then
  echo ISSUE57_CANONICAL_C=COMPLETE
  echo "delta=$DELTA"
  echo "instrumentation_patch_sha256=$PATCH_SHA256"
  echo "artifacts=$OUT"
  exit 0
fi
if [ -d "$OUT" ] && find "$OUT" -mindepth 1 -print -quit | grep -q .; then
  blocked incomplete_artifacts_require_manual_review 86
fi
mkdir -p "$OUT"

if [ ! -e "$WORKTREE/.git" ]; then
  if [ -e "$WORKTREE" ]; then
    blocked canonical_c_worktree_path_occupied 87
  fi
  git -C "$BASE" worktree add --detach "$WORKTREE" "$DELTA"
fi
test "$(git -C "$WORKTREE" rev-parse HEAD)" = "$DELTA" || \
  blocked canonical_c_worktree_commit_mismatch 88

actual_patch_sha=$(git -C "$WORKTREE" diff HEAD --no-ext-diff | sha256sum | awk '{print $1}')
if [ "$actual_patch_sha" = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]; then
  test -z "$(git -C "$WORKTREE" status --porcelain --untracked-files=all)" || \
    blocked canonical_c_worktree_has_unknown_content_drift 89
  git -C "$WORKTREE" apply --check "$PATCH"
  git -C "$WORKTREE" apply "$PATCH"
  git -C "$WORKTREE" add -- \
    babylon-project/backend/test/soft-chat-canonical-c-config.test.ts \
    babylon-project/backend/test/soft-chat-canonical-c-config.ts \
    babylon-project/backend/test/soft-chat-load-server-process.ts \
    babylon-project/backend/test/soft-chat-load.e2e.test.ts
elif [ "$actual_patch_sha" != "$PATCH_SHA256" ]; then
  blocked canonical_c_worktree_has_unknown_content_drift 90
fi
test "$(git -C "$WORKTREE" diff HEAD --no-ext-diff | sha256sum | awk '{print $1}')" = \
  "$PATCH_SHA256" || blocked instrumentation_patch_apply_mismatch 91
test "$(git -C "$WORKTREE" status --porcelain --untracked-files=all | cut -c4- | sort | tr '\n' ' ')" = \
  "babylon-project/backend/test/soft-chat-canonical-c-config.test.ts babylon-project/backend/test/soft-chat-canonical-c-config.ts babylon-project/backend/test/soft-chat-load-server-process.ts babylon-project/backend/test/soft-chat-load.e2e.test.ts " || \
  blocked instrumentation_scope_mismatch 92

if [ ! -d "$WORKTREE/babylon-project/node_modules" ]; then
  test -d "$BASE/babylon-project/node_modules" || blocked exact_delta11_node_modules_missing 93
  ln -s "$BASE/babylon-project/node_modules" "$WORKTREE/babylon-project/node_modules"
fi

exec > >(tee -a "$LOG") 2>&1
echo ISSUE57_CANONICAL_C=STARTING
echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "delta=$DELTA"
echo "instrumentation_patch_sha256=$PATCH_SHA256"
echo "worktree=$WORKTREE"
echo "artifacts=$OUT"

(
  cd "$WORKTREE/babylon-project"
  npm run check
  npm run check:test
)

set -a
. "$LAB/.secrets/postgres.env"
set +a
export TEST_DATABASE_URL="postgresql://noemi_bench:${POSTGRES_PASSWORD}@127.0.0.1:55433/babylon_bench"
unset POSTGRES_PASSWORD

CHROMIUM=""
for executable in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
  if [ -x "$executable" ]; then
    CHROMIUM="$executable"
    break
  fi
done
if [ -z "$CHROMIUM" ]; then
  for executable in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do
    if [ -x "$executable" ]; then
      CHROMIUM="$executable"
      break
    fi
  done
fi
test -n "$CHROMIUM" || blocked chromium_executable_not_found 94
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM"

sudo -n /usr/local/sbin/noemi-babylon-gate pg-reset

export RUN_SOFT_CHAT_LOAD=1
export SOFT_CHAT_LOAD_CANONICAL_C=1
export SOFT_CHAT_LOAD_STAGES=500
export SOFT_CHAT_LOAD_MODES=independent-streaming
export SOFT_CHAT_LOAD_POOL_MAX=20
export SOFT_CHAT_LOAD_POLL_INTERVAL_MS=500
export SOFT_CHAT_LOAD_PENDING_SCHEDULE=fixed-grid
export SOFT_CHAT_LOAD_CLIENT_RAMP_MS=5000
export SOFT_CHAT_LOAD_WARMUP_MS=2000
export SOFT_CHAT_LOAD_SEPARATE_SERVER=1
export SOFT_CHAT_LOAD_COMPARISON=1
export SOFT_CHAT_LOAD_MAX_ERROR_RATE=0.01
export SOFT_CHAT_LOAD_MAX_P99_MS=10000
export SOFT_CHAT_LOAD_OUTPUT_DIR="$OUT"
unset SOFT_CHAT_LOAD_PENDING_AUTH_ISOLATION

(
  cd "$WORKTREE/babylon-project"
  npm run load:soft-chat
)

python3 - "$OUT" <<'PY'
import csv
import glob
import json
import math
import os
import sys

root = sys.argv[1]
csv_files = sorted(glob.glob(os.path.join(root, 'soft-chat-load-*.csv')))
message_files = sorted(glob.glob(os.path.join(root, '*.canonical-c-messages.jsonl')))
timeline_files = sorted(glob.glob(os.path.join(root, '*.canonical-c-timeline.jsonl')))
schema_files = sorted(glob.glob(os.path.join(root, '*.canonical-c-schema.json')))
if len(csv_files) != 1 or len(message_files) != 1 or len(timeline_files) != 1 or len(schema_files) != 1:
    raise SystemExit('CANONICAL_C_ARTIFACT_SET_INVALID')
with open(csv_files[0], newline='', encoding='utf-8') as handle:
    rows = list(csv.DictReader(handle))
if len(rows) != 1:
    raise SystemExit('CANONICAL_C_RESULT_ROW_COUNT_INVALID')
row = rows[0]
required = {
    'requested_clients': '500',
    'authenticated_clients': '500',
    'messages_attempted': '500',
    'messages_succeeded': '500',
    'messages_failed': '0',
    'ack_succeeded': '500',
    'ack_failed': '0',
    'duplicates': '0',
    'exactly_once_violations': '0',
    'result': 'PASS',
}
for key, expected in required.items():
    if row.get(key) != expected:
        raise SystemExit(f'CANONICAL_C_HARD_GATE_FAIL {key}={row.get(key)!r} expected={expected!r}')
with open(message_files[0], encoding='utf-8') as handle:
    messages = [json.loads(line) for line in handle if line.strip()]
if len(messages) != 500 or sorted(message['sendRank'] for message in messages) != list(range(1, 501)):
    raise SystemExit('CANONICAL_C_MESSAGE_TRACE_COVERAGE_INVALID')
required_message_fields = {
    'sendTsMonotonicMs', 'acceptTsMonotonicMs', 'visibleTsMonotonicMs',
    'ackTsMonotonicMs', 'sendToAcceptMs', 'acceptToVisibleMs', 'sendToVisibleMs',
    'visibleToAckMs', 'sendToAckMs',
}
if any(required_message_fields - message.keys() for message in messages):
    raise SystemExit('CANONICAL_C_MESSAGE_TRACE_SCHEMA_INVALID')
if any(message[field] is None for message in messages for field in required_message_fields):
    raise SystemExit('CANONICAL_C_MESSAGE_TRACE_INCOMPLETE')
if any(not isinstance(message[field], (int, float)) or not math.isfinite(message[field])
       for message in messages for field in required_message_fields):
    raise SystemExit('CANONICAL_C_MESSAGE_TRACE_NONFINITE')
nonnegative_intervals = {
    'sendToAcceptMs', 'sendToVisibleMs', 'visibleToAckMs', 'sendToAckMs',
}
if any(message[field] < 0 for message in messages for field in nonnegative_intervals):
    raise SystemExit('CANONICAL_C_MESSAGE_TRACE_NEGATIVE_INTERVAL')
with open(timeline_files[0], encoding='utf-8') as handle:
    timeline = [json.loads(line) for line in handle if line.strip()]
kinds = {sample.get('kind') for sample in timeline}
expected_kinds = {'driver-concurrency', 'db-pool', 'server-runtime', 'connection-acquisition'}
if not expected_kinds.issubset(kinds):
    raise SystemExit(f'CANONICAL_C_TIMELINE_INCOMPLETE kinds={sorted(kinds)}')
timeline_fields = {
    'driver-concurrency': {
        'atMonotonicMs', 'inFlightSends', 'sendsStarted', 'sendsCompleted',
        'pendingFetchInFlight', 'pendingFetchRequests',
    },
    'db-pool': {'atMonotonicMs', 'totalCount', 'idleCount', 'waitingCount'},
    'server-runtime': {
        'atMonotonicMs', 'cpuPercent', 'eventLoopUtilizationPercent', 'eventLoopDelayP99Ms',
    },
    'connection-acquisition': {
        'atMonotonicMs', 'stage', 'window', 'startedAtMonotonicMs', 'finishedAtMonotonicMs',
        'waitMs',
    },
}
for sample in timeline:
    kind = sample.get('kind')
    if kind not in timeline_fields or timeline_fields[kind] - sample.keys():
        raise SystemExit(f'CANONICAL_C_TIMELINE_SCHEMA_INVALID kind={kind!r}')
    for key, value in sample.items():
        if key == 'kind' or key == 'stage' or key == 'window' or key == 'at':
            continue
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise SystemExit(f'CANONICAL_C_TIMELINE_NONFINITE kind={kind!r} field={key!r}')
if any(timeline[index]['atMonotonicMs'] > timeline[index + 1]['atMonotonicMs']
       for index in range(len(timeline) - 1)):
    raise SystemExit('CANONICAL_C_TIMELINE_NOT_SORTED')
driver_samples = [sample for sample in timeline if sample['kind'] == 'driver-concurrency']
if max(sample['sendsStarted'] for sample in driver_samples) != 500:
    raise SystemExit('CANONICAL_C_SEND_START_COUNT_INVALID')
if max(sample['sendsCompleted'] for sample in driver_samples) != 500:
    raise SystemExit('CANONICAL_C_SEND_COMPLETION_COUNT_INVALID')
if any(sample['inFlightSends'] < 0 or sample['pendingFetchInFlight'] < 0
       or sample['pendingFetchRequests'] < 0 for sample in driver_samples):
    raise SystemExit('CANONICAL_C_CONCURRENCY_COUNT_INVALID')
pool_samples = [sample for sample in timeline if sample['kind'] == 'db-pool']
if any(sample['totalCount'] < 0 or sample['idleCount'] < 0 or sample['waitingCount'] < 0
       for sample in pool_samples):
    raise SystemExit('CANONICAL_C_POOL_SAMPLE_INVALID')
runtime_samples = [sample for sample in timeline if sample['kind'] == 'server-runtime']
if any(sample['cpuPercent'] < 0 or sample['eventLoopUtilizationPercent'] < 0
       or sample['eventLoopDelayP99Ms'] < 0 for sample in runtime_samples):
    raise SystemExit('CANONICAL_C_RUNTIME_SAMPLE_INVALID')
acquisition_samples = [sample for sample in timeline if sample['kind'] == 'connection-acquisition']
acquisition_stages = {'authentication', 'accept', 'pendingFetch', 'acknowledge'}
if any(sample['stage'] not in acquisition_stages or sample['waitMs'] < 0
       or sample['window'] not in {'reconnect', 'steady'}
       or sample['finishedAtMonotonicMs'] < sample['startedAtMonotonicMs']
       for sample in acquisition_samples):
    raise SystemExit('CANONICAL_C_ACQUISITION_SAMPLE_INVALID')
if {sample['stage'] for sample in acquisition_samples} != acquisition_stages:
    raise SystemExit('CANONICAL_C_ACQUISITION_STAGE_COVERAGE_INVALID')
with open(schema_files[0], encoding='utf-8') as handle:
    schema = json.load(handle)
if schema.get('schemaVersion') != 1:
    raise SystemExit('CANONICAL_C_SCHEMA_VERSION_INVALID')
if schema.get('clock') != 'driver performance.timeOrigin+performance.now':
    raise SystemExit('CANONICAL_C_CLOCK_SCHEMA_INVALID')
alignment = schema.get('serverClockAlignment', {})
if alignment.get('samples') != 7 or not math.isfinite(alignment.get('offsetMs', math.nan)) \
        or not math.isfinite(alignment.get('roundTripMs', math.nan)) \
        or alignment.get('roundTripMs', -1) < 0:
    raise SystemExit('CANONICAL_C_CLOCK_ALIGNMENT_INVALID')
if set(schema.get('timelineKinds', [])) != expected_kinds:
    raise SystemExit('CANONICAL_C_TIMELINE_KINDS_INVALID')
print('ISSUE57_CANONICAL_C_HARD_GATE=PASS')
print(f'message_trace_rows={len(messages)}')
print(f'timeline_rows={len(timeline)}')
for key in ('send_to_ack_p99_ms', 'send_to_visible_p99_ms', 'throughput_messages_per_second',
            'pool_max_waiting', 'server_cpu_percent', 'server_event_loop_utilization_percent',
            'server_event_loop_delay_p99_ms'):
    print(f'{key}={row.get(key, "")}')
PY

(
  cd "$OUT"
  sha256sum soft-chat-load-* > SHA256SUMS
)
touch "$OUT/.done"
echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ISSUE57_CANONICAL_C=PASS
