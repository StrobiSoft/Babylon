#!/bin/bash
set -euo pipefail

# One-shot CT105 root runner. It repairs the two migration-only P4 layout
# defects when still needed, performs the P4 local execution gates, and
# restores any temporary maintenance-surface change before exit.

ROOT=/home/noemi-codex/workspace/ct105-agent-platform
MODULE=$ROOT/node-ijet
SOURCE_REPO=/home/noemi-codex/workspace/babylon-project
SOURCE_COMMIT=803408b33905d96d3022310b21c1cee9edc0cdea
SOURCE_VECTOR_PATH=babylon-project/docs/bnp/vectors/crypto-replay-v1.json
SOURCE_VECTOR_BLOB=c594645331da89e323581c24117c348b8af72ab3
INSTALLER_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALLER=$INSTALLER_DIR/enable-node-ijet-p4-layout-fix.sh
MAINT=/usr/local/sbin/noemi-maint
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
LAYOUT_FIX_SUBJECT='fix(node-ijet): adapt benchmark harness to CT105 layout'
VECTOR_FIX_SUBJECT='fix(node-ijet): migrate conformance vector dependency'
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

for repo in "$ROOT" "$SOURCE_REPO"; do
  if [[ ! -d "$repo/.git" || -L "$repo" ]]; then
    echo NODE_IJET_P4_ONESHOT=BLOCKED
    echo "reason=invalid_repository:$repo"
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

# Pre-gates before touching either the target repository or maintenance surface.
test "$(runuser -u noemi-codex -- git -C "$ROOT" symbolic-ref --quiet --short HEAD)" = main || block unexpected_branch
test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block target_repository_not_clean
runuser -u noemi-codex -- git -C "$SOURCE_REPO" cat-file -e "$SOURCE_COMMIT^{commit}" || block missing_historical_source_commit
runuser -u noemi-codex -- git -C "$SOURCE_REPO" cat-file -e "$SOURCE_COMMIT:$SOURCE_VECTOR_PATH" || block missing_historical_conformance_vector

action_changed_set() {
  runuser -u noemi-codex -- git -C "$ROOT" diff-tree --no-commit-id --name-only -r HEAD | LC_ALL=C sort
}

verify_layout_fix() {
  local changed expected
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)" = "$LAYOUT_FIX_SUBJECT" || block missing_layout_fix_commit
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -2 --format=%s | tail -1)" = "$P3_HEAD_SUBJECT" || block unexpected_layout_fix_parent
  changed=$(action_changed_set)
  expected=$(printf '%s\n' 'node-ijet/benchmarks/README.md' 'node-ijet/benchmarks/benchmark.mjs' | LC_ALL=C sort)
  test "$changed" = "$expected" || block unexpected_layout_fix_change_set
  grep -Fq 'const MODULE_ROOT = resolve(dirname(SCRIPT_PATH), "..");' "$MODULE/benchmarks/benchmark.mjs" || block layout_fix_postcondition_missing
  grep -Fq 'git("diff", "--exit-code", target, "--", "node-ijet")' "$MODULE/benchmarks/benchmark.mjs" || block layout_fix_postcondition_missing
  grep -Fq 'resolve(MODULE_ROOT, "benchmarks/results/raw.json")' "$MODULE/benchmarks/benchmark.mjs" || block layout_fix_postcondition_missing
  if grep -Fq 'babylon-project/node-core' "$MODULE/benchmarks/benchmark.mjs"; then
    block layout_fix_forbidden_dependency_present
  fi
  test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block dirty_after_layout_fix
}

apply_vector_fix() {
  local test_file=$MODULE/tests/conformance-vectors.test.ts
  local vector_file=$MODULE/docs/bnp/vectors/crypto-replay-v1.json

  echo "=== NODE IJET P4: migrate missing conformance vector dependency ==="
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)" = "$LAYOUT_FIX_SUBJECT" || block vector_fix_unexpected_parent
  test ! -e "$vector_file" || block vector_destination_already_exists
  grep -Fq "../../docs/bnp/vectors/crypto-replay-v1.json" "$test_file" || block conformance_test_preimage_missing

  runuser -u noemi-codex -- mkdir -p "$MODULE/docs/bnp/vectors"
  runuser -u noemi-codex -- bash -lc "git -C '$SOURCE_REPO' show '$SOURCE_COMMIT:$SOURCE_VECTOR_PATH' > '$vector_file'"
  test "$(runuser -u noemi-codex -- git -C "$ROOT" hash-object "$vector_file")" = "$SOURCE_VECTOR_BLOB" || block conformance_vector_blob_mismatch

  runuser -u noemi-codex -- python3 - "$test_file" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = "../../docs/bnp/vectors/crypto-replay-v1.json"
new = "../docs/bnp/vectors/crypto-replay-v1.json"
if s.count(old) != 1 or new in s:
    raise SystemExit("unexpected conformance-vector path preimage")
p.write_text(s.replace(old, new))
PY

  runuser -u noemi-codex -- git -C "$ROOT" add \
    node-ijet/tests/conformance-vectors.test.ts \
    node-ijet/docs/bnp/vectors/crypto-replay-v1.json
  runuser -u noemi-codex -- git -C "$ROOT" diff --cached --check
  runuser -u noemi-codex -- git -C "$ROOT" commit \
    -m "$VECTOR_FIX_SUBJECT" \
    -m 'Migration-only P4 correction; preserves the original BNP/1 conformance vector bytes and test semantics.'
}

verify_vector_fix() {
  local changed expected vector_file
  vector_file=$MODULE/docs/bnp/vectors/crypto-replay-v1.json
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)" = "$VECTOR_FIX_SUBJECT" || block missing_vector_fix_commit
  test "$(runuser -u noemi-codex -- git -C "$ROOT" log -2 --format=%s | tail -1)" = "$LAYOUT_FIX_SUBJECT" || block unexpected_vector_fix_parent
  changed=$(action_changed_set)
  expected=$(printf '%s\n' 'node-ijet/docs/bnp/vectors/crypto-replay-v1.json' 'node-ijet/tests/conformance-vectors.test.ts' | LC_ALL=C sort)
  test "$changed" = "$expected" || block unexpected_vector_fix_change_set
  test "$(runuser -u noemi-codex -- git -C "$ROOT" hash-object "$vector_file")" = "$SOURCE_VECTOR_BLOB" || block conformance_vector_blob_mismatch
  grep -Fq "../docs/bnp/vectors/crypto-replay-v1.json" "$MODULE/tests/conformance-vectors.test.ts" || block conformance_vector_path_postcondition_missing
  if grep -Fq "../../docs/bnp/vectors/crypto-replay-v1.json" "$MODULE/tests/conformance-vectors.test.ts"; then
    block stale_conformance_vector_path_present
  fi
  test -z "$(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || block dirty_after_vector_fix
}

CURRENT_SUBJECT=$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)
case "$CURRENT_SUBJECT" in
  "$VECTOR_FIX_SUBJECT")
    echo "=== NODE IJET P4: conformance vector correction already present; verify and resume ==="
    verify_vector_fix
    ;;
  "$LAYOUT_FIX_SUBJECT")
    echo "=== NODE IJET P4: layout correction already present; verify and resume ==="
    verify_layout_fix
    apply_vector_fix
    verify_vector_fix
    ;;
  "$P3_HEAD_SUBJECT")
    echo "=== NODE IJET P4: install temporary bounded action ==="
    bash "$INSTALLER"
    echo "=== NODE IJET P4: apply benchmark layout correction ==="
    "$MAINT" node-ijet-p4-layout-fix
    verify_layout_fix
    apply_vector_fix
    verify_vector_fix
    ;;
  *)
    block unexpected_head_before_p4_validation
    ;;
esac

VALIDATED_HEAD=$(runuser -u noemi-codex -- git -C "$ROOT" rev-parse HEAD)

echo "=== NODE IJET P4: historical benchmark evidence integrity ==="
actual_sums=$(cd "$MODULE/benchmarks/results" && sha256sum raw.json SUMMARY.md REPORT.md)
test "$actual_sums" = "$HISTORICAL_SUMS" || block historical_benchmark_evidence_changed

echo "=== NODE IJET P4: no active Babylon layout dependency ==="
if grep -R -n -F 'babylon-project/' \
  "$MODULE/src" "$MODULE/tests" "$MODULE/benchmarks/benchmark.mjs" \
  "$MODULE/package.json" "$MODULE/tsconfig.json" "$MODULE/tests/tsconfig.json"; then
  block active_babylon_layout_dependency
fi

[[ ! -e "$MODULE/node_modules" ]] || block preexisting_node_modules
[[ ! -e "$MODULE/dist" ]] || block preexisting_dist

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
  --target "$VALIDATED_HEAD" \
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
echo "validated_head=$VALIDATED_HEAD"
echo historical_evidence=PASS
echo typescript_source=PASS
echo typescript_tests=PASS
echo build=PASS
echo unit_tests=PASS
echo benchmark_smoke=PASS
echo maintenance_surface_restored=PASS
