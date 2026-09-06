#!/bin/bash
set -euo pipefail

DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp -a "$DISPATCH" "$DISPATCH.pre-bbb11-bundlefix-$STAMP"

python3 - <<'PY'
from pathlib import Path
p=Path('/usr/local/sbin/noemi-babylon-bench-dispatch')
s=p.read_text()
old='''    /usr/bin/git -C "$R" bundle create "$TMP/b-exact.bundle" "$COMMIT" "^$PARENT"\n'''
new='''    TMPREF=refs/bbb1/recover-b-exact\n    /usr/bin/git -C "$R" update-ref "$TMPREF" "$COMMIT"\n    cleanup_ref() { /usr/bin/git -C "$R" update-ref -d "$TMPREF" >/dev/null 2>&1 || true; }\n    trap 'cleanup_ref; rm -rf "$TMP"' EXIT\n    /usr/bin/git -C "$R" bundle create "$TMP/b-exact.bundle" "$TMPREF" "^$PARENT"\n    cleanup_ref\n'''
if old not in s:
    raise SystemExit('bundle line marker not found')
s=s.replace(old,new,1)
p.write_text(s)
PY

bash -n "$DISPATCH"
grep -q 'refs/bbb1/recover-b-exact' "$DISPATCH"
echo BBB11_B_RECOVERY_BUNDLE_FIX=PASS
echo "backup_dispatch=$DISPATCH.pre-bbb11-bundlefix-$STAMP"
