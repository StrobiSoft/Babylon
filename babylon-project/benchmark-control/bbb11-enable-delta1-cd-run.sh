#!/bin/bash
set -euo pipefail

MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cp -a "$MAINT" "$MAINT.pre-delta1-cd-$STAMP"
cp -a "$DISPATCH" "$DISPATCH.pre-delta1-cd-$STAMP"

python3 - <<'PY'
from pathlib import Path
p=Path('/opt/noemi-maint/maint.py')
s=p.read_text()
a='    "babylon-bench-delta1-cd-run",\n'
if a not in s:
    marker='    "babylon-bench-delta-cd-run",\n'
    if marker not in s:
        raise SystemExit('maint allowlist marker not found')
    s=s.replace(marker, marker+a, 1)
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('/usr/local/sbin/noemi-babylon-bench-dispatch')
s=p.read_text()
if '  babylon-bench-delta1-cd-run)' in s:
    raise SystemExit(0)
marker='  babylon-bench-delta-cd-run)\n'
if marker not in s:
    raise SystemExit('dispatcher insertion marker not found')
case=r'''  babylon-bench-delta1-cd-run)
    remote '
      set -eu
      LAB=/srv/noemi-babylon-lab
      W=$LAB/worktrees/b1
      DELTA1=146faf38307bd40cdeb44eb676a773db8d3d0f71
      RUNS=$LAB/results/delta1-c-d-20260906
      mkdir -p "$RUNS/c" "$RUNS/d"

      test -d "$W/.git"
      test "$(git -C "$W" rev-parse HEAD)" = "$DELTA1"
      test -z "$(git -C "$W" status --porcelain)"

      source "$LAB/.secrets/postgres.env"
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
      test -n "$CHROMIUM"
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM"

      export RUN_SOFT_CHAT_LOAD=1
      export SOFT_CHAT_LOAD_STAGES=500
      export SOFT_CHAT_LOAD_MODES=independent-streaming
      export SOFT_CHAT_LOAD_CLIENT_RAMP_MS=5000
      export SOFT_CHAT_LOAD_WARMUP_MS=2000
      export SOFT_CHAT_LOAD_SEPARATE_SERVER=1
      export SOFT_CHAT_LOAD_COMPARISON=1
      export SOFT_CHAT_LOAD_MAX_ERROR_RATE=0.01
      export SOFT_CHAT_LOAD_MAX_P99_MS=10000
      unset SOFT_CHAT_LOAD_PENDING_SCHEDULE || true

      run_one() {
        label=$1
        pool=$2
        poll=$3
        out=$RUNS/$label
        sudo -n /usr/local/sbin/noemi-babylon-gate pg-reset
        export SOFT_CHAT_LOAD_POOL_MAX=$pool
        export SOFT_CHAT_LOAD_POLL_INTERVAL_MS=$poll
        export SOFT_CHAT_LOAD_OUTPUT_DIR=$out
        (cd "$W/babylon-project" && npm run check && npm run check:test && npm run load:soft-chat)
      }

      run_one c 40 500
      run_one d 20 750

      python3 - "$RUNS" <<"PY2"
import csv, glob, os, sys
root=sys.argv[1]
print("DELTA1_CD_SUMMARY_BEGIN")
for label in ("c","d"):
    files=sorted(glob.glob(os.path.join(root,label,"*.csv")))
    if not files:
        print(label.upper()+"=MISSING")
        continue
    with open(files[-1], newline="", encoding="utf-8") as f:
        rows=list(csv.DictReader(f))
    r=rows[-1]
    print("LABEL="+label.upper())
    for key in ("send_to_ack_p99_ms","throughput_messages_per_second","authentication_p99_ms","accept_p99_ms","pending_fetch_p99_ms","acknowledge_p99_ms","pool_max_waiting","pending_fetch_requests","duplicates","exactly_once_violations","result","reason"):
        print(f"{key}={r.get(key,'')}")
print("DELTA1_CD_SUMMARY_END")
PY2
      echo DELTA1_C_D_RUN=PASS
    '
    ;;

'''
s=s.replace(marker, case+marker, 1)
p.write_text(s)
PY

python3 -m py_compile "$MAINT"
bash -n "$DISPATCH"
grep -q '"babylon-bench-delta1-cd-run"' "$MAINT"
grep -q '^  babylon-bench-delta1-cd-run)' "$DISPATCH"

echo BBB11_DELTA1_CD_ACTION_INSTALL=PASS
echo "backup_maint=$MAINT.pre-delta1-cd-$STAMP"
echo "backup_dispatch=$DISPATCH.pre-delta1-cd-$STAMP"
