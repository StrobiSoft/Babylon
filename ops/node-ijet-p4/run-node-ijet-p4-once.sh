#!/bin/bash
set -euo pipefail

# One-shot CT105 root runner. It applies the migration-only benchmark layout
# correction when still needed, performs the P4 local execution gates, and
# restores any temporary maintenance-surface change before exit.

ROOT=/home/noemi-codex/workspace/ct105-agent-platform
MODULE=$ROOT/node-ijet
INSTALLER_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALLER=$INSTALLER_DIR/enable-node-ijet-p4-layout-fix.sh
MAINT=/usr/local/sbin/noemi-maint
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
FIX_SUBJECT='fix(node-ijet): adapt benchmark harness to CT105 layout'
P3_HEAD_SUBJECT='migrate(node-ijet): import Babylon PR #64 command journal'
HISTORICAL_SUMS=$'d0241ac348c484dd0266620721d0dfdb844280f820d761f11acb442ac8da3d6a  raw.json\n9d60a2b9da0da4453a210c2ab4da2dc7fabe023625bdbbb6111952500255e77c  SUMMARY.md\n04bb71353d14b83932ee82ceb96f769ba64edbb90deaabead72d8635b5ad5655  REPORT.md'

if [[ $EUID -ne 0 || $# -ne 0 ]]; then
  echo NODE_IJET_P4_ONESHOT=BLOCKED
  echo reason=root_and_zero_arguments_required
  exit 80
fi

for path in "$INSTALLER" "$MAINT" "$DISPATCH"; do
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo NODE_IJET_P4_ONESHOT=BLOCKED
    echo "reason=invalid_required_path:$path"
    exit 81
  fi
done

STAGE=$(mktemp -d /tmp/node-ijet-p4-once.XXXXXX)
cp -a -- "$MAINT" "$STAGE/maint.pre"
cp -a -- "$DISPATCH" "$STAGE/dispatch.pre"
RESTORED=0

restore_control_surface() {
  status=$?
  if [[ $RESTORED -eq 0 ]]; then
    cp -a -- "$STAGE/maint.pre" "$MAINT"
    cp -a -- "$STAGE/dispatch.pre" "$DISPATCH"
    bash -n "$MAINT" >/dev/null 2>&1 || true
    bash -n "$DISPATCH" >/dev/null 2>&1 || true
    RESTORED=1
  fi
  rm -rf -- "$STAGE"
  exit "$status"
}
trap restore_control_surface EXIT

block() {
  echo NODE_IJET_P4=FAIL
  echo "reason=$1"
  exit 82
}

# Pre-gates before touching the maintenance surface.
test -d "$ROOT/.git" && test ! -L "$ROOT" || block invalid_target_repository
test "$(runuser -u noemi-codex -- git -C "$ROOT" symbolic-ref --quiet --short HEAD)" = main || block unexpected_branch
test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block target_repository_not_clean

verify_layout_fix() {
  local changed
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)" = "$FIX_SUBJECT" || block missing_layout_fix_commit
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -2 --format=%s | tail -1)" = "$P3_HEAD_SUBJECT" || block unexpected_layout_fix_parent
  changed=$(runuser -u noemi-codex -- git -C "$ROOT" diff-tree --no-commit-id --name-only -r HEAD | sort)
  test "$changed" = $'node-ijet/benchmarks/README.md\nnode-ijet/benchmarks/benchmark.mjs' || block unexpected_layout_fix_change_set
  grep -Fq 'const MODULE_ROOT = resolve(dirname(SCRIPT_PATH), "..");' "$MODULE/benchmarks/benchmark.mjs" || block layout_fix_postcondition_missing
  grep -Fq 'git("diff", "--exit-code", target, "--", "node-ijet")' "$MODULE/benchmarks/benchmark.mjs" || block layout_fix_postcondition_missing
  grep -Fq 'resolve(MODULE_ROOT, "benchmarks/results/raw.json")' "$MODULE/benchmarks/benchmark.mjs" || block layout_fix_postcondition_missing
  if grep -Fq 'babylon-project/node-core' "$MODULE/benchmarks/benchmark.mjs"; then
    block layout_fix_forbidden_dependency_present
  fi
  test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block dirty_after_layout_fix
}

CURRENT_SUBJECT=$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)
case "$CURRENT_SUBJECT" in
  "$FIX_SUBJECT")
    echo "=== NODE IJET P4: layout correction already present; verify and resume ==="
    verify_layout_fix
    ;;
  "$P3_HEAD_SUBJECT")
    echo "=== NODE IJET P4: install temporary bounded action ==="
    bash "$INSTALLER"
    echo "=== NODE IJET P4: apply benchmark layout correction ==="
    "$MAINT" node-ijet-p4-layout-fix
    verify_layout_fix
    ;;
  *)
    block unexpected_head_before_layout_validation
    ;;
esac

FIX_HEAD=$(runuser -u noemi-codex -- git -C "$ROOT" rev-parse HEAD)

echo "=== NODE IJET P4: historical benchmark evidence integrity ==="
actual_sums=$(cd "$MODULE/benchmarks/results" && sha256sum raw.json SUMMARY.md REPORT.md)
test "$actual_sums" = "$HISTORICAL_SUMS" || block historical_benchmark_evidence_changed

echo "=== NODE IJET P4: no active Babylon layout dependency ==="
if grep -R -n -F 'babylon-project/' \
  "$MODULE/src" "$MODULE/tests" "$MODULE/benchmarks/benchmark.mjs" \
  "$MODULE/package.json" "$MODULE/tsconfig.json" "$MODULE/tests/tsconfig.json"; then
  block active_babylon_layout_dependency
fi

echo "=== NODE IJET P4: dependency install ==="
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm install --ignore-scripts --no-audit --no-fund --package-lock=false"

cleanup_build_artifacts() {
  rm -rf -- "$MODULE/node_modules" "$MODULE/dist"
}
trap 'cleanup_build_artifacts; restore_control_surface' EXIT

echo "=== NODE IJET P4: TypeScript source check ==="
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm run check"

echo "=== NODE IJET P4: TypeScript test check ==="
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm run check:test"

echo "=== NODE IJET P4: build ==="
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm run build"

echo "=== NODE IJET P4: complete migrated test suite ==="
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm test"

echo "=== NODE IJET P4: migrated benchmark smoke ==="
SMOKE=$STAGE/benchmark-smoke
mkdir -p "$SMOKE"
chown noemi-codex:noemi-codex "$SMOKE"
runuser -u noemi-codex -- node "$MODULE/benchmarks/benchmark.mjs" \
  --target "$FIX_HEAD" \
  --runs 5 \
  --warmup-ms 1 \
  --throughput-ms 1 \
  --samples 10 \
  --output "$SMOKE/raw.json"
test -s "$SMOKE/raw.json" || block benchmark_smoke_output_missing

# The historical #63 evidence must remain byte-identical even after the smoke.
actual_sums_post=$(cd "$MODULE/benchmarks/results" && sha256sum raw.json SUMMARY.md REPORT.md)
test "$actual_sums_post" = "$HISTORICAL_SUMS" || block historical_benchmark_evidence_changed_after_smoke

cleanup_build_artifacts
trap restore_control_surface EXIT

test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block target_repository_dirty_after_validation

# Restore the original maintenance surface before declaring PASS.
cp -a -- "$STAGE/maint.pre" "$MAINT"
cp -a -- "$STAGE/dispatch.pre" "$DISPATCH"
bash -n "$MAINT"
bash -n "$DISPATCH"
RESTORED=1

echo NODE_IJET_P4=PASS
echo "validated_head=$FIX_HEAD"
echo historical_evidence=PASS
echo typescript_source=PASS
echo typescript_tests=PASS
echo build=PASS
echo unit_tests=PASS
echo benchmark_smoke=PASS
echo maintenance_surface_restored=PASS
