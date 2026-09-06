#!/bin/bash
set -euo pipefail

TARGET=/opt/noemi-maint/maint.py
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="${TARGET}.pre-bbb11-${STAMP}"

cp -a "$TARGET" "$BACKUP"

python3 - <<'PY'
from pathlib import Path
p = Path('/opt/noemi-maint/maint.py')
s = p.read_text()
needle = '    "qwentin-process-list",\n}'
replacement = '''    "qwentin-process-list",\n    "babylon-bench-e2e",\n    "babylon-bench-preflight",\n    "babylon-bench-pg-up",\n    "babylon-bench-pg-down",\n    "babylon-bench-pg-reset",\n    "babylon-bench-pg-status",\n    "babylon-bench-pg-logs",\n    "babylon-bench-pg-metrics",\n    "babylon-bench-runtime-status",\n    "babylon-bench-artifacts",\n    "babylon-bench-worktree-status",\n    "babylon-bench-ct105-b-state",\n    "babylon-bench-control-sync",\n    "babylon-bench-control-run",\n}'''
if needle not in s:
    raise SystemExit('BBB11_PATCH=BLOCKED\nreason=allowlist_anchor_not_found')
if '"babylon-bench-e2e"' not in s:
    s = s.replace(needle, replacement, 1)
p.write_text(s)
PY

python3 -m py_compile "$TARGET"

echo "BBB11_ALLOWLIST_PATCH=PASS"
echo "backup=$BACKUP"
echo "--- enabled babylon actions ---"
grep -n '"babylon-bench-' "$TARGET"

echo "--- local semantic smoke ---"
sudo -n /usr/local/sbin/noemi-maint babylon-bench-e2e

echo "BBB11_LOCAL_SEMANTIC_E2E=PASS"
