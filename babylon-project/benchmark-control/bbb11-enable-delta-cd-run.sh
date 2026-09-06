#!/bin/bash
set -euo pipefail

MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
ACTION=babylon-bench-delta-cd-run
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cp -a "$MAINT" "$MAINT.pre-delta-cd-$STAMP"
cp -a "$DISPATCH" "$DISPATCH.pre-delta-cd-$STAMP"

python3 - <<'PY'
from pathlib import Path
p=Path('/opt/noemi-maint/maint.py')
s=p.read_text()
a='    "babylon-bench-delta-cd-run",\n'
if a not in s:
    marker='    "babylon-bench-series-summary",\n'
    if marker not in s:
        raise SystemExit('maint allowlist marker not found')
    s=s.replace(marker, marker+a, 1)
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('/usr/local/sbin/noemi-babylon-bench-dispatch')
s=p.read_text()
if '  babylon-bench-delta-cd-run)' in s:
    raise SystemExit(0)
marker='  babylon-bench-series-summary)\n'
if marker not in s:
    raise SystemExit('dispatcher insertion marker not found')
case=r'''  babylon-bench-delta-cd-run)
    remote '
      set -eu
      LAB=/srv/noemi-babylon-lab
      W=$LAB/worktrees/b-exact
      DELTA=296d4c104a437475e01c7598501ae073e439461e
      PARENT=5e40b192263e55a07d6d210bccede3eb7b47c6b7
      RUNS=$LAB/results/delta-c-d-20260906
      MAN=$LAB/manifests/delta-1.1
      mkdir -p "$RUNS/c" "$RUNS/d" "$MAN" "$LAB/results/delta-1.1"

      test "$(git -C "$W" rev-parse HEAD)" = "$DELTA"
      test -z "$(git -C "$W" status --porcelain)"

      # Durable Delta 1.1 state/result snapshot.
      cp -a $LAB/results/b1-a-b-20260906/b/. "$LAB/results/delta-1.1/"
      printf "name=Delta 1.1\ncommit=%s\nparent=%s\nsaved_at=%s\n" "$DELTA" "$PARENT" "$(date -u +%FT%TZ)" > "$MAN/manifest.txt"
      git -C "$W" bundle create "$MAN/delta-1.1.bundle" bbb1-b-exact "^$PARENT"
      sha256sum "$MAN/delta-1.1.bundle" >> "$MAN/manifest.txt"

      set -a
      . "$LAB/.secrets/postgres.env"
      set +a
      export DATABASE_HOST=127.0.0.1
      export DATABASE_PORT=55433
      export RUN_SOFT_CHAT_LOAD=1
      export SOFT_CHAT_LOAD_STAGES=500
      export SOFT_CHAT_LOAD_MODES=independent-streaming
      export SOFT_CHAT_LOAD_CLIENT_RAMP_MS=5000
      export SOFT_CHAT_LOAD_WARMUP_MS=2000
      export SOFT_CHAT_LOAD_SEPARATE_SERVER=1
      export SOFT_CHAT_LOAD_COMPARISON=1
      export SOFT_CHAT_LOAD_MAX_ERROR_RATE=0.01
      export SOFT_CHAT_LOAD_MAX_P99_MS=10000
      export SOFT_CHAT_LOAD_PENDING_SCHEDULE=fixed-grid

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
print("DELTA_CD_SUMMARY_BEGIN")
for label in ("c","d"):
    files=sorted(glob.glob(os.path.join(root,label,"*.csv")))
    if not files:
        print(label.upper()+"=MISSING")
        continue
    with open(files[-1], newline="", encoding="utf-8") as f:
        rows=list(csv.DictReader(f))
    r=rows[-1]
    print("LABEL="+label.upper())
    for key in ("send_to_ack_p99_ms","throughput_messages_per_second","authentication_p99_ms","accept_p99_ms","pending_fetch_p99_ms","acknowledge_p99_ms","pool_max_waiting","pending_fetch_requests","pending_schedule_skipped_ticks","duplicates","exactly_once_violations","result","reason"):
        print(f"{key}={r.get(key,'')}")
print("DELTA_CD_SUMMARY_END")
PY2
      echo DELTA_1_1_SNAPSHOT=PASS
      echo DELTA_C_D_RUN=PASS
    '
    ;;

'''
s=s.replace(marker, case+marker, 1)
p.write_text(s)
PY

python3 -m py_compile "$MAINT"
bash -n "$DISPATCH"
grep -q '"babylon-bench-delta-cd-run"' "$MAINT"
grep -q '^  babylon-bench-delta-cd-run)' "$DISPATCH"

echo BBB11_DELTA_CD_ACTION_INSTALL=PASS
echo "backup_maint=$MAINT.pre-delta-cd-$STAMP"
echo "backup_dispatch=$DISPATCH.pre-delta-cd-$STAMP"
