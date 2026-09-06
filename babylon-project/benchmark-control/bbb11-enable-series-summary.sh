#!/bin/bash
set -euo pipefail

MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cp -a "$MAINT" "$MAINT.pre-bbb11-series-summary-$STAMP"
cp -a "$DISPATCH" "$DISPATCH.pre-bbb11-series-summary-$STAMP"

python3 - <<'PY'
from pathlib import Path
p=Path('/opt/noemi-maint/maint.py')
s=p.read_text()
a='    "babylon-bench-series-summary",\n'
if a not in s:
    marker='    "babylon-bench-control-sync",\n'
    if marker not in s:
        raise SystemExit('maint allowlist marker not found')
    s=s.replace(marker, a+marker, 1)
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('/usr/local/sbin/noemi-babylon-bench-dispatch')
s=p.read_text()
if '  babylon-bench-series-summary)' in s:
    raise SystemExit(0)
marker='  babylon-bench-control-sync)\n'
if marker not in s:
    raise SystemExit('dispatcher insertion marker not found')
case=r'''  babylon-bench-series-summary)
    remote '
      set -eu
      ROOT=/srv/noemi-babylon-lab/results/b1-a-b-20260906
      for label in b1 a b; do
        dir="$ROOT/$label"
        f="$(find "$dir" -maxdepth 1 -type f -name "*.csv" | sort | head -1)"
        test -n "$f"
        echo "=== ${label^^} ==="
        cat "$f"
      done
      echo BBB11_SERIES_SUMMARY=PASS
    '
    ;;

'''
s=s.replace(marker, case+marker, 1)
p.write_text(s)
PY

python3 -m py_compile "$MAINT"
bash -n "$DISPATCH"
grep -q '"babylon-bench-series-summary"' "$MAINT"
grep -q '^  babylon-bench-series-summary)' "$DISPATCH"

echo BBB11_SERIES_SUMMARY_ACTION_INSTALL=PASS
echo "backup_maint=$MAINT.pre-bbb11-series-summary-$STAMP"
echo "backup_dispatch=$DISPATCH.pre-bbb11-series-summary-$STAMP"
