#!/bin/bash
set -euo pipefail

# Installs three no-argument, fixed-target maintenance actions for the reviewed
# DrainMap-500 handoff: read-only control status, exact mode-drift normalization,
# and exact-checkpoint sync. Every mutating state transition fails closed.

MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
ACTION_STATUS=babylon-bench-control-status
ACTION_NORMALIZE=babylon-bench-control-normalize-run-mode
ACTION_SYNC=babylon-bench-control-sync-drainmap-500
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

if [[ $EUID -ne 0 || $# -ne 0 ]]; then
    echo DRAINMAP_CONTROL_ACTION_INSTALL=BLOCKED
    echo reason=root_and_zero_arguments_required
    exit 80
fi

for target in "$MAINT" "$DISPATCH"; do
    if [[ ! -f "$target" || -L "$target" ]]; then
        echo DRAINMAP_CONTROL_ACTION_INSTALL=BLOCKED
        echo "reason=invalid_install_target:$target"
        exit 81
    fi
done

if grep -Fq "\"$ACTION_STATUS\"" "$MAINT" &&
    grep -Fq "\"$ACTION_NORMALIZE\"" "$MAINT" &&
    grep -Fq "\"$ACTION_SYNC\"" "$MAINT" &&
    grep -Fq "  $ACTION_STATUS)" "$DISPATCH" &&
    grep -Fq "  $ACTION_NORMALIZE)" "$DISPATCH" &&
    grep -Fq "  $ACTION_SYNC)" "$DISPATCH"; then
    python3 -m py_compile "$MAINT"
    bash -n "$DISPATCH"
    echo DRAINMAP_CONTROL_ACTION_INSTALL=PASS
    echo state=already_installed
    exit 0
fi

STAGE=$(mktemp -d /tmp/drainmap-mode-action.XXXXXX)
BACKUP_MAINT="$MAINT.pre-drainmap-mode-$STAMP"
BACKUP_DISPATCH="$DISPATCH.pre-drainmap-mode-$STAMP"
COMMITTED=0

cleanup() {
    status=$?
    if [[ $COMMITTED -eq 0 && -e "$BACKUP_MAINT" && -e "$BACKUP_DISPATCH" ]]; then
        cp -a -- "$BACKUP_MAINT" "$MAINT"
        cp -a -- "$BACKUP_DISPATCH" "$DISPATCH"
    fi
    rm -rf -- "$STAGE"
    exit "$status"
}
trap cleanup EXIT

cp -a -- "$MAINT" "$BACKUP_MAINT"
cp -a -- "$DISPATCH" "$BACKUP_DISPATCH"
cp -a -- "$MAINT" "$STAGE/maint.py"
cp -a -- "$DISPATCH" "$STAGE/dispatch"

python3 - "$STAGE/maint.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
actions = (
    '    "babylon-bench-control-status",\n',
    '    "babylon-bench-control-normalize-run-mode",\n',
    '    "babylon-bench-control-sync-drainmap-500",\n',
)
missing = "".join(action for action in actions if action not in text)
if missing:
    marker = '    "babylon-bench-control-sync",\n'
    if text.count(marker) != 1:
        raise SystemExit("maint allowlist anchor missing or ambiguous")
    text = text.replace(marker, missing + marker, 1)
path.write_text(text, encoding="utf-8")
PY

python3 - "$STAGE/dispatch" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
case = r'''  babylon-bench-control-status)
    if [ "$#" -ne 1 ]; then
      echo DRAINMAP_CONTROL_STATUS=BLOCKED
      echo reason=arguments_not_allowed
      exit 80
    fi
    remote '
      set -eu
      R=/srv/noemi-babylon-lab/control-repo
      P=babylon-project/benchmark-control/run.sh

      test -d "$R/.git" && test ! -L "$R"
      test -f "$R/$P" && test ! -L "$R/$P"
      echo DRAINMAP_CONTROL_STATUS=PASS
      printf "branch="
      git -C "$R" symbolic-ref --quiet --short HEAD
      printf "head="
      git -C "$R" rev-parse HEAD
      printf "tracked="
      git -C "$R" ls-files -s -- "$P"
      echo "working_mode=$(stat -c %a "$R/$P")"
      echo "working_blob=$(git -C "$R" hash-object --no-filters -- "$P")"
      echo "sha256=$(sha256sum "$R/$P" | awk "{print \$1}")"
      echo "--- status ---"
      git -C "$R" status --short --branch
      echo "--- numstat ---"
      git -C "$R" diff --numstat -- "$P"
      echo "--- summary ---"
      git -C "$R" diff --summary -- "$P"
    '
    ;;

  babylon-bench-control-normalize-run-mode)
    if [ "$#" -ne 1 ]; then
      echo DRAINMAP_RUN_MODE_NORMALIZE=BLOCKED
      echo reason=arguments_not_allowed
      exit 80
    fi
    remote '
      set -eu
      R=/srv/noemi-babylon-lab/control-repo
      BRANCH=ops/noemi-benchmark-control
      HEAD=65d2de2f3ba2fa7f35a4004c8564ca45cc6ea618
      P=babylon-project/benchmark-control/run.sh
      BLOB=6c01d85d2363408a4ca97628a7ae0e56f716be83
      SHA256=70d6baeda865d474d8bf8eead48147afd0a1e909653a25c7989d0c9c27d25757

      block() {
        echo DRAINMAP_RUN_MODE_NORMALIZE=BLOCKED
        echo "reason=$1"
        exit 81
      }

      test -d "$R/.git" && test ! -L "$R" || block invalid_control_repository
      test -f "$R/$P" && test ! -L "$R/$P" || block invalid_runner_path
      test "$(git -C "$R" symbolic-ref --quiet --short HEAD)" = "$BRANCH" || block unexpected_branch
      test "$(git -C "$R" rev-parse HEAD)" = "$HEAD" || block unexpected_head
      test "$(git -C "$R" ls-files -s -- "$P")" = "100644 $BLOB 0	$P" || block unexpected_index_identity
      test "$(git -C "$R" hash-object --no-filters -- "$P")" = "$BLOB" || block unexpected_working_blob
      test "$(sha256sum "$R/$P" | awk "{print \$1}")" = "$SHA256" || block unexpected_content_sha256

      mode=$(stat -c %a "$R/$P")
      status=$(git -C "$R" status --porcelain=v1 --untracked-files=all)
      if test "$mode" = 644 && test -z "$status"; then
        echo DRAINMAP_RUN_MODE_NORMALIZE=PASS
        echo state=already_normalized
        echo branch="$BRANCH"
        echo head="$HEAD"
        echo tracked_mode=100644
        echo working_mode=644
        echo blob="$BLOB"
        echo sha256="$SHA256"
        exit 0
      fi

      test "$mode" = 755 || block unexpected_working_mode
      test "$status" = " M $P" || block unexpected_worktree_status
      test "$(git -C "$R" diff --numstat -- "$P")" = "0	0	$P" || block content_diff_detected
      test "$(git -C "$R" diff --summary -- "$P")" = " mode change 100644 => 100755 $P" || block unexpected_mode_diff

      chmod 0644 -- "$R/$P"

      test "$(stat -c %a "$R/$P")" = 644 || block postcondition_mode_mismatch
      test -z "$(git -C "$R" status --porcelain=v1 --untracked-files=all)" || block postcondition_worktree_dirty
      test "$(git -C "$R" hash-object --no-filters -- "$P")" = "$BLOB" || block postcondition_blob_mismatch
      test "$(sha256sum "$R/$P" | awk "{print \$1}")" = "$SHA256" || block postcondition_sha256_mismatch

      echo DRAINMAP_RUN_MODE_NORMALIZE=PASS
      echo state=normalized
      echo branch="$BRANCH"
      echo head="$HEAD"
      echo tracked_mode=100644
      echo working_mode=644
      echo blob="$BLOB"
      echo sha256="$SHA256"
    '
    ;;

  babylon-bench-control-sync-drainmap-500)
    if [ "$#" -ne 1 ]; then
      echo DRAINMAP_CONTROL_SYNC=BLOCKED
      echo reason=arguments_not_allowed
      exit 80
    fi
    remote '
      set -eu
      R=/srv/noemi-babylon-lab/control-repo
      URL=https://github.com/StrobiSoft/Babylon.git
      SOURCE=perf/issue-57-canonical-c-remediation
      BRANCH=ops/noemi-benchmark-control
      OLD_HEAD=65d2de2f3ba2fa7f35a4004c8564ca45cc6ea618
      HEAD=ced87ef48486a47ecc3404689ceb139fc26b1be1
      P=babylon-project/benchmark-control/run.sh
      BLOB=82653a8cd31d531c05899799ecd51d6133677a49
      SHA256=32777e44f89bee76475ddd7f54618f26eeb1614c0e8480f3e9dc8ecc78455f3c

      block() {
        echo DRAINMAP_CONTROL_SYNC=BLOCKED
        echo "reason=$1"
        exit 82
      }

      test -d "$R/.git" && test ! -L "$R" || block invalid_control_repository
      test "$(git -C "$R" symbolic-ref --quiet --short HEAD)" = "$BRANCH" || block unexpected_branch
      current=$(git -C "$R" rev-parse HEAD)
      test "$current" = "$OLD_HEAD" || test "$current" = "$HEAD" || block unexpected_head
      test -z "$(git -C "$R" status --porcelain=v1 --untracked-files=all)" || block control_repository_not_clean

      if test "$current" != "$HEAD"; then
        git -C "$R" fetch --no-tags "$URL" "$SOURCE"
        test "$(git -C "$R" rev-parse FETCH_HEAD)" = "$HEAD" || block reviewed_source_head_mismatch
        git -C "$R" checkout -B "$BRANCH" "$HEAD"
      fi

      test "$(git -C "$R" rev-parse HEAD)" = "$HEAD" || block postcondition_head_mismatch
      test "$(git -C "$R" symbolic-ref --quiet --short HEAD)" = "$BRANCH" || block postcondition_branch_mismatch
      test -z "$(git -C "$R" status --porcelain=v1 --untracked-files=all)" || block postcondition_worktree_dirty
      test "$(git -C "$R" ls-files -s -- "$P")" = "100755 $BLOB 0	$P" || block postcondition_index_identity_mismatch
      test "$(git -C "$R" hash-object --no-filters -- "$P")" = "$BLOB" || block postcondition_blob_mismatch
      test "$(sha256sum "$R/$P" | awk "{print \$1}")" = "$SHA256" || block postcondition_sha256_mismatch
      chmod 0755 -- "$R/$P"
      test "$(stat -c %a "$R/$P")" = 755 || block postcondition_mode_mismatch
      test -z "$(git -C "$R" status --porcelain=v1 --untracked-files=all)" || block postcondition_mode_created_drift

      echo DRAINMAP_CONTROL_SYNC=PASS
      echo branch="$BRANCH"
      echo head="$HEAD"
      echo rollback_head="$OLD_HEAD"
      echo tracked_mode=100755
      echo working_mode=755
      echo blob="$BLOB"
      echo sha256="$SHA256"
    '
    ;;

'''
actions = (
    "  babylon-bench-control-status)",
    "  babylon-bench-control-normalize-run-mode)",
    "  babylon-bench-control-sync-drainmap-500)",
)
if not all(action in text for action in actions):
    if any(action in text for action in actions):
        raise SystemExit("dispatcher has a partial DrainMap action installation")
    marker = "  babylon-bench-control-sync)\n"
    if text.count(marker) != 1:
        raise SystemExit("dispatcher insertion anchor missing or ambiguous")
    text = text.replace(marker, case + marker, 1)
path.write_text(text, encoding="utf-8")
PY

python3 -m py_compile "$STAGE/maint.py"
bash -n "$STAGE/dispatch"
for action in "$ACTION_STATUS" "$ACTION_NORMALIZE" "$ACTION_SYNC"; do
    grep -Fq "\"$action\"" "$STAGE/maint.py"
    grep -Fq "  $action)" "$STAGE/dispatch"
done

install -o root -g root -m 0755 "$STAGE/maint.py" "$MAINT.next-drainmap-mode"
install -o root -g root -m 0755 "$STAGE/dispatch" "$DISPATCH.next-drainmap-mode"
mv -f -- "$MAINT.next-drainmap-mode" "$MAINT"
mv -f -- "$DISPATCH.next-drainmap-mode" "$DISPATCH"

python3 -m py_compile "$MAINT"
bash -n "$DISPATCH"
COMMITTED=1

echo DRAINMAP_CONTROL_ACTION_INSTALL=PASS
echo state=installed
echo "backup_maint=$BACKUP_MAINT"
echo "backup_dispatch=$BACKUP_DISPATCH"
