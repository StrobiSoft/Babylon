#!/bin/bash
set -euo pipefail

# One-shot CT105 root runner. It temporarily installs the bounded maintenance
# action, applies the migration-only benchmark layout correction, performs the
# P4 local execution gates, and restores the pre-existing maintenance surface.

ROOT=/home/noemi-codex/workspace/ct105-agent-platform
MODULE=$ROOT/node-ijet
INSTALLER_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALLER=$INSTALLER_DIR/enable-node-ijet-p4-layout-fix.sh
MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
HISTORICAL_SUMS=$'d0241ac3015f65e3710ec48d98f4845130dd999dc1f77d9315436b1a62437bfb  raw.json\n9d60a2b36941c88df2811f1476e1ccda75c8de3f49e5bb822134548998b8d9d6  SUMMARY.md\n04bb71304c48d7620eabca79f3097233f3a72e2c98190a68643745a4432447df  REPORT.md'

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
cp -a -- "$MAINT" "$STAGE/maint.py.pre"
cp -a -- "$DISPATCH" "$STAGE/dispatch.pre"
RESTORED=0

restore_control_surface() {
  status=$?
  if [[ $RESTORED -eq 0 ]]; then
    cp -a -- "$STAGE/maint.py.pre" "$MAINT"
    cp -a -- "$STAGE/dispatch.pre" "$DISPATCH"
    python3 -m py_compile "$MAINT" >/dev/null 2>&1 || true
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

echo "=== NODE IJET P4: install temporary bounded action ==="
bash "$INSTALLER"

echo "=== NODE IJET P4: apply benchmark layout correction ==="
"$DISPATCH" node-ijet-p4-layout-fix

FIX_HEAD=$(runuser -u noemi-codex -- git -C "$ROOT" rev-parse HEAD)
test "$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)" = "fix(node-ijet): adapt benchmark harness to CT105 layout" || block missing_layout_fix_commit
test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block dirty_after_layout_fix

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
cp -a -- "$STAGE/maint.py.pre" "$MAINT"
cp -a -- "$STAGE/dispatch.pre" "$DISPATCH"
python3 -m py_compile "$MAINT"
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
