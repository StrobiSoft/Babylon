#!/bin/bash
set -euo pipefail

ROOT=/home/noemi-codex/workspace/ct105-agent-platform
MODULE=$ROOT/node-ijet
SOURCE_REPO=/home/noemi-codex/workspace/babylon-project
CONTROL_REF=origin/ops/node-ijet-p4-layout-fix-20260912
HELPER_PATH=ops/node-ijet-p4/repair-node-ijet-p4-benchmark-durable.sh
VECTOR_FIX_SUBJECT='fix(node-ijet): migrate conformance vector dependency'
BENCHMARK_FIX_SUBJECT='fix(node-ijet): adapt benchmark harness to durable command journal'
MAINT=/usr/local/sbin/noemi-maint
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
HISTORICAL_SUMS=$'d0241ac348c484dd0266620721d0dfdb844280f820d761f11acb442ac8da3d6a  raw.json\n9d60a2b9da0da4453a210c2ab4da2dc7fabe023625bdbbb6111952500255e77c  SUMMARY.md\n04bb71353d14b83932ee82ceb96f769ba64edbb90deaabead72d8635b5ad5655  REPORT.md'

block() {
  echo NODE_IJET_P4=FAIL
  echo "reason=$1"
  exit 82
}

[[ $EUID -eq 0 && $# -eq 0 ]] || block root_and_zero_arguments_required
[[ -d "$ROOT/.git" && ! -L "$ROOT" ]] || block invalid_target_repository
[[ -d "$SOURCE_REPO/.git" && ! -L "$SOURCE_REPO" ]] || block invalid_source_repository
[[ -f "$MAINT" && ! -L "$MAINT" ]] || block invalid_maintenance_front_door
[[ -f "$DISPATCH" && ! -L "$DISPATCH" ]] || block invalid_dispatcher
[[ $(runuser -u noemi-codex -- git -C "$ROOT" symbolic-ref --quiet --short HEAD) = main ]] || block unexpected_branch
[[ -z $(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all) ]] || block target_repository_not_clean

USER_STAGE=$(mktemp -d /tmp/node-ijet-p4-resume-user.XXXXXX)
chown noemi-codex:noemi-codex "$USER_STAGE"
chmod 0700 "$USER_STAGE"
INSTALLED=0
cleanup() {
  status=$?
  if [[ $INSTALLED -eq 1 ]]; then
    rm -rf -- "$MODULE/node_modules" "$MODULE/dist"
  fi
  rm -rf -- "$USER_STAGE"
  exit "$status"
}
trap cleanup EXIT

verify_benchmark_fix() {
  local changed expected
  [[ $(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s) = "$BENCHMARK_FIX_SUBJECT" ]] || block missing_benchmark_fix_commit
  [[ $(runuser -u noemi-codex -- git -C "$ROOT" log -2 --format=%s | tail -1) = "$VECTOR_FIX_SUBJECT" ]] || block unexpected_benchmark_fix_parent
  changed=$(runuser -u noemi-codex -- git -C "$ROOT" diff-tree --no-commit-id --name-only -r HEAD | LC_ALL=C sort)
  expected='node-ijet/benchmarks/benchmark.mjs'
  [[ "$changed" = "$expected" ]] || block unexpected_benchmark_fix_change_set
  grep -Fq 'class BenchmarkCommandJournal' "$MODULE/benchmarks/benchmark.mjs" || block benchmark_fix_postcondition_missing
  grep -Fq 'commandJournal,' "$MODULE/benchmarks/benchmark.mjs" || block benchmark_fix_postcondition_missing
  grep -Fq 'commandExecutionPolicy,' "$MODULE/benchmarks/benchmark.mjs" || block benchmark_fix_postcondition_missing
  node --check "$MODULE/benchmarks/benchmark.mjs" || block benchmark_syntax_check_failed
  [[ -z $(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all) ]] || block dirty_after_benchmark_fix
}

CURRENT_SUBJECT=$(runuser -u noemi-codex -- git -C "$ROOT" log -1 --format=%s)
case "$CURRENT_SUBJECT" in
  "$BENCHMARK_FIX_SUBJECT")
    echo '=== NODE IJET P4: durable-journal benchmark correction already present; verify and resume ==='
    verify_benchmark_fix
    ;;
  "$VECTOR_FIX_SUBJECT")
    echo '=== NODE IJET P4: repair benchmark for #64 durable COMMAND journal ==='
    HELPER=$USER_STAGE/repair-benchmark.sh
    runuser -u noemi-codex -- git -C "$SOURCE_REPO" show "$CONTROL_REF:$HELPER_PATH" > "$HELPER" || block benchmark_helper_unavailable
    chown noemi-codex:noemi-codex "$HELPER"
    chmod 0700 "$HELPER"
    runuser -u noemi-codex -- bash "$HELPER"
    verify_benchmark_fix
    ;;
  *)
    block unexpected_head_for_post_vector_resume
    ;;
esac

VALIDATED_HEAD=$(runuser -u noemi-codex -- git -C "$ROOT" rev-parse HEAD)

echo '=== NODE IJET P4: historical benchmark evidence integrity ==='
actual_sums=$(cd "$MODULE/benchmarks/results" && sha256sum raw.json SUMMARY.md REPORT.md)
[[ "$actual_sums" = "$HISTORICAL_SUMS" ]] || block historical_benchmark_evidence_changed

echo '=== NODE IJET P4: no active Babylon layout dependency ==='
if grep -R -n -F 'babylon-project/' \
  "$MODULE/src" "$MODULE/tests" "$MODULE/benchmarks/benchmark.mjs" \
  "$MODULE/package.json" "$MODULE/tsconfig.json" "$MODULE/tests/tsconfig.json"; then
  block active_babylon_layout_dependency
fi

[[ ! -e "$MODULE/node_modules" ]] || block preexisting_node_modules
[[ ! -e "$MODULE/dist" ]] || block preexisting_dist

echo '=== NODE IJET P4: dependency install ==='
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm install --ignore-scripts --no-audit --no-fund --package-lock=false"
INSTALLED=1

echo '=== NODE IJET P4: TypeScript source check ==='
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm run check"

echo '=== NODE IJET P4: TypeScript test check ==='
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm run check:test"

echo '=== NODE IJET P4: build ==='
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm run build"

echo '=== NODE IJET P4: complete migrated test suite ==='
runuser -u noemi-codex -- bash -lc "cd '$MODULE' && npm test"

echo '=== NODE IJET P4: migrated benchmark smoke ==='
SMOKE=$USER_STAGE/benchmark-smoke
mkdir -p "$SMOKE"
chown noemi-codex:noemi-codex "$SMOKE"
runuser -u noemi-codex -- node "$MODULE/benchmarks/benchmark.mjs" \
  --target "$VALIDATED_HEAD" \
  --runs 5 \
  --warmup-ms 1 \
  --throughput-ms 1 \
  --samples 10 \
  --output "$SMOKE/raw.json"
[[ -s "$SMOKE/raw.json" ]] || block benchmark_smoke_output_missing

actual_sums_post=$(cd "$MODULE/benchmarks/results" && sha256sum raw.json SUMMARY.md REPORT.md)
[[ "$actual_sums_post" = "$HISTORICAL_SUMS" ]] || block historical_benchmark_evidence_changed_after_smoke

rm -rf -- "$MODULE/node_modules" "$MODULE/dist"
INSTALLED=0
[[ -z $(runuser -u noemi-codex -- git -C "$ROOT" status --porcelain=v1 --untracked-files=all) ]] || block target_repository_dirty_after_validation
bash -n "$MAINT" || block maintenance_front_door_invalid
bash -n "$DISPATCH" || block dispatcher_invalid

echo NODE_IJET_P4=PASS
echo "validated_head=$VALIDATED_HEAD"
echo historical_evidence=PASS
echo typescript_source=PASS
echo typescript_tests=PASS
echo build=PASS
echo unit_tests=PASS
echo benchmark_smoke=PASS
echo maintenance_surface_syntax=PASS
