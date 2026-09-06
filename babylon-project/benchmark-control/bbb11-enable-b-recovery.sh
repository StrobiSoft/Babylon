#!/bin/bash
set -euo pipefail

MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
ACTION=babylon-bench-recover-b
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cp -a "$MAINT" "$MAINT.pre-bbb11-b-recovery-$STAMP"
cp -a "$DISPATCH" "$DISPATCH.pre-bbb11-b-recovery-$STAMP"

python3 - <<'PY'
from pathlib import Path
p=Path('/opt/noemi-maint/maint.py')
s=p.read_text()
a='    "babylon-bench-recover-b",\n'
if a not in s:
    marker='    "babylon-bench-ct105-b-state",\n'
    if marker not in s:
        raise SystemExit('maint allowlist marker not found')
    s=s.replace(marker, marker+a, 1)
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('/usr/local/sbin/noemi-babylon-bench-dispatch')
s=p.read_text()
if '  babylon-bench-recover-b)' in s:
    raise SystemExit(0)
marker='  babylon-bench-control-sync)\n'
if marker not in s:
    raise SystemExit('dispatcher insertion marker not found')
case=r'''  babylon-bench-recover-b)
    R=/home/noemi-codex/workspace/babylon-project
    COMMIT=296d4c104a437475e01c7598501ae073e439461e
    PARENT=5e40b192263e55a07d6d210bccede3eb7b47c6b7
    FIX=backend/test/soft-chat-pending-auth-isolation.test.ts
    TMP="$(mktemp -d /tmp/bbb1-b-recover.XXXXXX)"
    trap 'rm -rf "$TMP"' EXIT

    test -d "$R/.git"
    /usr/bin/git -C "$R" cat-file -e "$COMMIT^{commit}"
    /usr/bin/git -C "$R" cat-file -e "$PARENT^{commit}"
    /usr/bin/git -C "$R" merge-base --is-ancestor "$PARENT" "$COMMIT"

    /usr/bin/git -C "$R" bundle create "$TMP/b-exact.bundle" "$COMMIT" "^$PARENT"
    /usr/bin/git -C "$R" diff -- "$FIX" > "$TMP/b-local-fix.patch"
    /usr/bin/git -C "$R" show -s --format='%H%n%P%n%s%n%cI' "$COMMIT" > "$TMP/b-manifest.txt"
    /usr/bin/sha256sum "$TMP/b-exact.bundle" "$TMP/b-local-fix.patch" >> "$TMP/b-manifest.txt"

    SCP=(
      /usr/bin/scp -q
      -i "$KEY"
      -o IdentitiesOnly=yes
      -o BatchMode=yes
      -o StrictHostKeyChecking=yes
      -o UserKnownHostsFile="$KNOWN"
    )
    "${SCP[@]}" "$TMP/b-exact.bundle" "$TMP/b-local-fix.patch" "$TMP/b-manifest.txt" "$USER@$VM:/srv/noemi-babylon-lab/tmp/"

    remote '
      set -eu
      LAB=/srv/noemi-babylon-lab
      W=$LAB/worktrees/b-exact
      COMMIT=296d4c104a437475e01c7598501ae073e439461e
      PARENT=5e40b192263e55a07d6d210bccede3eb7b47c6b7
      URL=https://github.com/StrobiSoft/Babylon.git

      if [ ! -d "$W/.git" ]; then
        rm -rf "$W"
        git clone --filter=blob:none "$URL" "$W"
      fi

      git -C "$W" fetch --prune origin
      git -C "$W" cat-file -e "$PARENT^{commit}"
      git -C "$W" fetch "$LAB/tmp/b-exact.bundle" "$COMMIT:refs/heads/bbb1-b-exact"
      git -C "$W" checkout -B bbb1-b-exact "$COMMIT"
      git -C "$W" reset --hard "$COMMIT"

      if [ -s "$LAB/tmp/b-local-fix.patch" ]; then
        git -C "$W" apply --check "$LAB/tmp/b-local-fix.patch"
        git -C "$W" apply "$LAB/tmp/b-local-fix.patch"
      fi

      ACTUAL="$(git -C "$W" rev-parse HEAD)"
      test "$ACTUAL" = "$COMMIT"
      echo BBB11_B_COMMIT_RECOVERY=PASS
      echo b_commit="$ACTUAL"
      echo "--- B worktree status ---"
      git -C "$W" status --short --branch
      echo "--- B manifest ---"
      cat "$LAB/tmp/b-manifest.txt"
      echo BBB11_B_RECOVERY=PASS
    '
    ;;

'''
s=s.replace(marker, case+marker, 1)
p.write_text(s)
PY

python3 -m py_compile "$MAINT"
bash -n "$DISPATCH"

grep -q '"babylon-bench-recover-b"' "$MAINT"
grep -q '^  babylon-bench-recover-b)' "$DISPATCH"

echo BBB11_B_RECOVERY_ACTION_INSTALL=PASS
echo "backup_maint=$MAINT.pre-bbb11-b-recovery-$STAMP"
echo "backup_dispatch=$DISPATCH.pre-bbb11-b-recovery-$STAMP"
