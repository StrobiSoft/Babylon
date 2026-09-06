#!/bin/bash
set -euo pipefail
REPO=/srv/noemi-babylon-lab/control-repo
BR=ops/noemi-benchmark-control
[ -d "$REPO/.git" ] || { echo BBB11_CONTROL_CLEAN=BLOCKED; echo reason=control_repo_missing; exit 81; }
git -C "$REPO" fetch origin "$BR"
git -C "$REPO" checkout -B "$BR" "origin/$BR"
git -C "$REPO" reset --hard "origin/$BR"
git -C "$REPO" clean -f -- babylon-project/benchmark-control/run.sh >/dev/null 2>&1 || true
echo BBB11_CONTROL_CLEAN=PASS
git -C "$REPO" rev-parse HEAD
