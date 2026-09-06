#!/bin/bash
set -euo pipefail

LAB=/srv/noemi-babylon-lab
W="$LAB/worktrees/b-exact"
DELTA=296d4c104a437475e01c7598501ae073e439461e
ROOT="$LAB/results/delta11-reference-triplicate-20260906"
LOGROOT="$LAB/logs/delta11-reference-triplicate-20260906"

mkdir -p "$ROOT" "$LOGROOT"

test -d "$W/.git"
test "$(git -C "$W" rev-parse HEAD)" = "$DELTA"
test -z "$(git -C "$W" status --porcelain)"

next=""
for label in ref-01 ref-02 ref-03; do
  if [ ! -f "$ROOT/$label/.done" ]; then
    next="$label"
    break
  fi
done

if [ -z "$next" ]; then
  echo DELTA11_REFERENCE_TRIPLICATE=COMPLETE
  python3 - "$ROOT" <<'PY'
import csv, glob, os, sys
root=sys.argv[1]
for label in ('ref-01','ref-02','ref-03'):
    files=sorted(glob.glob(os.path.join(root,label,'*.csv')))
    if not files:
        print(f'{label}=MISSING')
        continue
    with open(files[-1], newline='', encoding='utf-8') as f:
        rows=list(csv.DictReader(f))
    r=rows[-1]
    print('LABEL='+label)
    for k in ('send_to_ack_p99_ms','send_to_visible_p99_ms','throughput_messages_per_second','pool_max_waiting','duplicates','exactly_once_violations','result','reason'):
        print(f'{k}={r.get(k,"")}')
PY
  exit 0
fi

out="$ROOT/$next"
log="$LOGROOT/$next.log"
mkdir -p "$out"

exec > >(tee "$log") 2>&1

echo "DELTA11_REFERENCE_RUN=$next"
echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "commit=$DELTA"

set -a
. "$LAB/.secrets/postgres.env"
set +a
export TEST_DATABASE_URL="postgresql://noemi_bench:${POSTGRES_PASSWORD}@127.0.0.1:55433/babylon_bench"
unset POSTGRES_PASSWORD

CHROMIUM=""
for p in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
  if [ -x "$p" ]; then CHROMIUM="$p"; break; fi
done
if [ -z "$CHROMIUM" ]; then
  for p in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do
    if [ -x "$p" ]; then CHROMIUM="$p"; break; fi
  done
fi
if [ -z "$CHROMIUM" ]; then
  echo DELTA11_REFERENCE_RUN=BLOCKED
  echo reason=chromium_executable_not_found
  exit 71
fi
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM"

sudo -n /usr/local/sbin/noemi-babylon-gate pg-reset

export RUN_SOFT_CHAT_LOAD=1
export SOFT_CHAT_LOAD_STAGES=500
export SOFT_CHAT_LOAD_MODES=independent-streaming
export SOFT_CHAT_LOAD_POOL_MAX=20
export SOFT_CHAT_LOAD_POLL_INTERVAL_MS=500
export SOFT_CHAT_LOAD_CLIENT_RAMP_MS=5000
export SOFT_CHAT_LOAD_WARMUP_MS=2000
export SOFT_CHAT_LOAD_SEPARATE_SERVER=1
export SOFT_CHAT_LOAD_COMPARISON=1
export SOFT_CHAT_LOAD_MAX_ERROR_RATE=0.01
export SOFT_CHAT_LOAD_MAX_P99_MS=10000
export SOFT_CHAT_LOAD_PENDING_SCHEDULE=fixed-grid
export SOFT_CHAT_LOAD_OUTPUT_DIR="$out"

(
  cd "$W/babylon-project"
  npm run check
  npm run check:test
  npm run load:soft-chat
)

python3 - "$out" <<'PY'
import csv, glob, os, sys
root=sys.argv[1]
files=sorted(glob.glob(os.path.join(root,'*.csv')))
if not files:
    raise SystemExit('NO_RESULT_CSV')
with open(files[-1], newline='', encoding='utf-8') as f:
    rows=list(csv.DictReader(f))
if not rows:
    raise SystemExit('EMPTY_RESULT_CSV')
r=rows[-1]
required={
  'messages_succeeded':'500',
  'messages_failed':'0',
  'ack_succeeded':'500',
  'ack_failed':'0',
  'duplicates':'0',
  'exactly_once_violations':'0',
  'result':'PASS',
}
for k,v in required.items():
    if r.get(k) != v:
        raise SystemExit(f'HARD_GATE_FAIL {k}={r.get(k)!r} expected={v!r}')
print('DELTA11_REFERENCE_HARD_GATE=PASS')
for k in ('send_to_ack_p99_ms','send_to_visible_p99_ms','visible_to_ack_p99_ms','throughput_messages_per_second','authentication_p99_ms','accept_p99_ms','pending_fetch_p99_ms','acknowledge_p99_ms','pool_max_waiting','postgres_max_connections','duplicates','exactly_once_violations','result','reason'):
    print(f'{k}={r.get(k,"")}')
PY

touch "$out/.done"
echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "DELTA11_REFERENCE_RUN_${next}=PASS"
echo "NEXT_ACTION=invoke babylon-bench-control-run again after manual review"
