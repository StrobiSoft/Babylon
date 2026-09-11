#!/bin/bash
set -euo pipefail

# Installs one no-argument, fixed-target NOEMI-MAINT action for the NODE IJET
# P4 benchmark-layout migration repair inside the CT105-local agent-platform
# repository. The action is intentionally narrow and fail-closed.

MAINT=/opt/noemi-maint/maint.py
DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
ACTION=node-ijet-p4-layout-fix
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

if [[ $EUID -ne 0 || $# -ne 0 ]]; then
  echo NODE_IJET_P4_ACTION_INSTALL=BLOCKED
  echo reason=root_and_zero_arguments_required
  exit 80
fi

for target in "$MAINT" "$DISPATCH"; do
  if [[ ! -f "$target" || -L "$target" ]]; then
    echo NODE_IJET_P4_ACTION_INSTALL=BLOCKED
    echo "reason=invalid_install_target:$target"
    exit 81
  fi
done

STAGE=$(mktemp -d /tmp/node-ijet-p4-action.XXXXXX)
BACKUP_MAINT="$MAINT.pre-node-ijet-p4-$STAMP"
BACKUP_DISPATCH="$DISPATCH.pre-node-ijet-p4-$STAMP"
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

cp -a -- "$MAINT" "$STAGE/maint.py"
cp -a -- "$DISPATCH" "$STAGE/dispatch"

python3 - "$STAGE/maint.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
action = '    "node-ijet-p4-layout-fix",\n'
if action not in text:
    anchor = None
    for candidate in (
        '    "babylon-bench-control-sync",\n',
        '    "sandbox-smoke",\n',
    ):
        if text.count(candidate) == 1:
            anchor = candidate
            break
    if anchor is None:
        raise SystemExit("maint allowlist anchor missing or ambiguous")
    text = text.replace(anchor, action + anchor, 1)
if text.count(action) != 1:
    raise SystemExit("maint allowlist action missing or duplicated")
path.write_text(text, encoding="utf-8")
PY

python3 - "$STAGE/dispatch" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
case = r'''  node-ijet-p4-layout-fix)
    if [ "$#" -ne 1 ]; then
      echo NODE_IJET_P4_LAYOUT_FIX=BLOCKED
      echo reason=arguments_not_allowed
      exit 80
    fi

    runuser -u noemi-codex -- /bin/bash <<'NODEIJETP4'
set -euo pipefail

R=/home/noemi-codex/workspace/ct105-agent-platform
M=$R/node-ijet
P=$M/benchmarks/benchmark.mjs
D=$M/benchmarks/README.md

block() {
  echo NODE_IJET_P4_LAYOUT_FIX=BLOCKED
  echo "reason=$1"
  exit 81
}

test -d "$R/.git" && test ! -L "$R" || block invalid_target_repository
test -f "$P" && test ! -L "$P" || block invalid_benchmark_path
test -f "$D" && test ! -L "$D" || block invalid_benchmark_readme_path
test "$(git -C "$R" symbolic-ref --quiet --short HEAD)" = main || block unexpected_branch
test "$(git -C "$R" rev-parse --short=7 HEAD)" = c593935 || block unexpected_head
test -z "$(git -C "$R" status --porcelain=v1 --untracked-files=all)" || block target_repository_not_clean

python3 - "$P" "$D" <<'PYFIX'
from pathlib import Path
import sys

bench = Path(sys.argv[1])
readme = Path(sys.argv[2])

b = bench.read_text(encoding="utf-8")
replacements = [
    (
        'const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");',
        'const MODULE_ROOT = resolve(dirname(SCRIPT_PATH), "..");\nconst REPO_ROOT = resolve(MODULE_ROOT, "..");',
    ),
    (
        '  const output = resolve(\n    REPO_ROOT,\n    values.get("output") ?? "benchmarks/node-core/results/raw.json",\n  );',
        '  const output = values.has("output")\n    ? resolve(REPO_ROOT, values.get("output"))\n    : resolve(MODULE_ROOT, "benchmarks/results/raw.json");',
    ),
    (
        '  git("diff", "--exit-code", target, "--", "babylon-project/node-core");\n  const targetTree = git("rev-parse", `${target}^{tree}`);',
        '  git("cat-file", "-e", `${target}^{commit}`);\n  git("diff", "--exit-code", target, "--", "node-ijet");\n  const targetTree = git("rev-parse", `${target}:node-ijet`);',
    ),
]
for old, new in replacements:
    count = b.count(old)
    if count != 1:
        raise SystemExit(f"benchmark preimage mismatch: {old[:80]!r}; count={count}")
    b = b.replace(old, new, 1)

for forbidden in (
    "../../babylon-project/node-core/dist/index.js",
    '"benchmarks/node-core/results/raw.json"',
    '"babylon-project/node-core"',
):
    if forbidden in b:
        raise SystemExit(f"Babylon layout dependency remains in benchmark harness: {forbidden}")

for required in (
    '} from "../dist/index.js";',
    'const MODULE_ROOT = resolve(dirname(SCRIPT_PATH), "..");',
    'const REPO_ROOT = resolve(MODULE_ROOT, "..");',
    'resolve(MODULE_ROOT, "benchmarks/results/raw.json")',
    'git("diff", "--exit-code", target, "--", "node-ijet")',
    'git("rev-parse", `${target}:node-ijet`)',
):
    if required not in b:
        raise SystemExit(f"benchmark postcondition missing: {required}")
bench.write_text(b, encoding="utf-8")

r = readme.read_text(encoding="utf-8")
old_intro = (
    "The harness imports the compiled product code from `babylon-project/node-core/dist`. It must be run\n"
    "from a clean checkout whose target product tree is the requested commit. The runner refuses to\n"
    "start if `babylon-project/node-core` differs from `TARGET_SHA`."
)
new_intro = (
    "The migrated harness imports the compiled product code from `node-ijet/dist`. It must be run\n"
    "from the CT105 agent-platform repository with a local CT105 commit SHA supplied as `--target`.\n"
    "The runner refuses to start if the local `node-ijet` tree differs from that target commit.\n"
    "Historical Babylon source provenance remains recorded separately in `MIGRATION_PROVENANCE.md`."
)
if r.count(old_intro) != 1:
    raise SystemExit("benchmark README preimage mismatch in layout description")
r = r.replace(old_intro, new_intro, 1)

old_run = '''```sh
cd babylon-project
npm ci --ignore-scripts
npm run test:node-core
npm run check
npm run build
cd ..
taskset -c 2 node benchmarks/node-core/benchmark.mjs \\
  --target 76ad3817faad24b6425668f9bb4fe9e4d3dac1d5 \\
  --runs 5 --warmup-ms 1500 --throughput-ms 2500 --samples 20000 \\
  --output benchmarks/node-core/results/raw.json
```'''
new_run = '''```sh
cd node-ijet
npm install --ignore-scripts --no-audit --no-fund --package-lock=false
npm run test
npm run check
npm run check:test
npm run build
cd ..
taskset -c 2 node node-ijet/benchmarks/benchmark.mjs \\
  --target "$(git rev-parse HEAD)" \\
  --runs 5 --warmup-ms 1500 --throughput-ms 2500 --samples 20000
```'''
if r.count(old_run) != 1:
    raise SystemExit("benchmark README preimage mismatch in run block")
r = r.replace(old_run, new_run, 1)

for forbidden in ("babylon-project/node-core", "benchmarks/node-core/benchmark.mjs"):
    if forbidden in r:
        raise SystemExit(f"Babylon layout dependency remains in benchmark README: {forbidden}")
readme.write_text(r, encoding="utf-8")
PYFIX

node --check "$P" || block benchmark_syntax_check_failed

changed=$(git -C "$R" status --porcelain=v1 --untracked-files=all)
expected1=" M node-ijet/benchmarks/README.md"
expected2=" M node-ijet/benchmarks/benchmark.mjs"
printf "%s\n" "$changed" | grep -Fx "$expected1" >/dev/null || block unexpected_change_set
printf "%s\n" "$changed" | grep -Fx "$expected2" >/dev/null || block unexpected_change_set
test "$(printf "%s\n" "$changed" | wc -l)" -eq 2 || block unexpected_change_count

git -C "$R" diff --check || block diff_check_failed
git -C "$R" add -- node-ijet/benchmarks/README.md node-ijet/benchmarks/benchmark.mjs
git -C "$R" commit \
  -m "fix(node-ijet): adapt benchmark harness to CT105 layout" \
  -m "Migration-only P4 correction; benchmark scenarios and measurement semantics unchanged."

test -z "$(git -C "$R" status --porcelain=v1 --untracked-files=all)" || block postcondition_worktree_dirty

echo NODE_IJET_P4_LAYOUT_FIX=PASS
echo "head=$(git -C "$R" rev-parse HEAD)"
echo "subject=$(git -C "$R" log -1 --format=%s)"
echo "files=node-ijet/benchmarks/README.md,node-ijet/benchmarks/benchmark.mjs"
NODEIJETP4
    ;;

'''

marker = "  node-ijet-p4-layout-fix)"
if marker not in text:
    anchor = None
    for candidate in (
        "  babylon-bench-control-sync)\n",
        "  bridge-status)\n",
    ):
        if text.count(candidate) == 1:
            anchor = candidate
            break
    if anchor is None:
        raise SystemExit("dispatcher insertion anchor missing or ambiguous")
    text = text.replace(anchor, case + anchor, 1)
elif text.count(marker) != 1:
    raise SystemExit("dispatcher action duplicated")

path.write_text(text, encoding="utf-8")
PY

python3 -m py_compile "$STAGE/maint.py"
bash -n "$STAGE/dispatch"
grep -Fq '"node-ijet-p4-layout-fix"' "$STAGE/maint.py"
grep -Fq '  node-ijet-p4-layout-fix)' "$STAGE/dispatch"

if cmp -s "$STAGE/maint.py" "$MAINT" && cmp -s "$STAGE/dispatch" "$DISPATCH"; then
  COMMITTED=1
  echo NODE_IJET_P4_ACTION_INSTALL=PASS
  echo state=already_installed
  exit 0
fi

if [[ -e "$BACKUP_MAINT" || -e "$BACKUP_DISPATCH" ]]; then
  echo NODE_IJET_P4_ACTION_INSTALL=BLOCKED
  echo reason=backup_path_collision
  exit 82
fi

cp -a -- "$MAINT" "$BACKUP_MAINT"
cp -a -- "$DISPATCH" "$BACKUP_DISPATCH"

install -o root -g root -m 0755 "$STAGE/maint.py" "$MAINT.next-node-ijet-p4"
install -o root -g root -m 0755 "$STAGE/dispatch" "$DISPATCH.next-node-ijet-p4"
mv -f -- "$MAINT.next-node-ijet-p4" "$MAINT"
mv -f -- "$DISPATCH.next-node-ijet-p4" "$DISPATCH"

python3 -m py_compile "$MAINT"
bash -n "$DISPATCH"
COMMITTED=1

echo NODE_IJET_P4_ACTION_INSTALL=PASS
echo state=installed
echo "backup_maint=$BACKUP_MAINT"
echo "backup_dispatch=$BACKUP_DISPATCH"
