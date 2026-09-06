#!/bin/bash
set -euo pipefail

DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp -a "$DISPATCH" "$DISPATCH.pre-delta11-cd-fix-$STAMP"

python3 - <<'PY'
from pathlib import Path
p=Path('/usr/local/sbin/noemi-babylon-bench-dispatch')
s=p.read_text()
old='''      set -a\n      . "$LAB/.secrets/postgres.env"\n      set +a\n      export DATABASE_HOST=127.0.0.1\n      export DATABASE_PORT=55433\n      export RUN_SOFT_CHAT_LOAD=1\n'''
new='''      source "$LAB/.secrets/postgres.env"\n      export TEST_DATABASE_URL="postgresql://noemi_bench:${POSTGRES_PASSWORD}@127.0.0.1:55433/babylon_bench"\n      unset POSTGRES_PASSWORD\n      export RUN_SOFT_CHAT_LOAD=1\n'''
if old not in s:
    if 'TEST_DATABASE_URL="postgresql://noemi_bench:' in s and 'babylon-bench-delta-cd-run)' in s:
        raise SystemExit(0)
    raise SystemExit('delta-cd env block not found')
s=s.replace(old,new,1)
p.write_text(s)
PY

bash -n "$DISPATCH"
grep -q 'TEST_DATABASE_URL="postgresql://noemi_bench:' "$DISPATCH"
echo BBB11_DELTA11_CD_FIX=PASS
echo "backup_dispatch=$DISPATCH.pre-delta11-cd-fix-$STAMP"
