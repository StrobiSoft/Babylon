#!/bin/bash
set -euo pipefail

LAB=/srv/noemi-babylon-lab
RUNS="$LAB/results/b1-a-b-20260906"
LOG="$LAB/logs/b1-a-b-20260906.log"
PIDFILE="$LAB/tmp/b1-a-b-20260906.pid"
JOB="$LAB/tmp/b1-a-b-20260906.sh"
B1=146faf38307bd40cdeb44eb676a773db8d3d0f71
A=5e40b192263e55a07d6d210bccede3eb7b47c6b7
B=296d4c104a437475e01c7598501ae073e439461e
URL=https://github.com/StrobiSoft/Babylon.git

mkdir -p "$RUNS" "$LAB/logs" "$LAB/tmp" "$LAB/worktrees"

if [ -s "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    echo BBB1_SERIES_ALREADY_RUNNING=PASS
    echo pid="$oldpid"
    exit 0
  fi
fi

cat > "$JOB" <<'JOB_EOF'
#!/bin/bash
set -u
LAB=/srv/noemi-babylon-lab
RUNS="$LAB/results/b1-a-b-20260906"
LOG="$LAB/logs/b1-a-b-20260906.log"
PIDFILE="$LAB/tmp/b1-a-b-20260906.pid"
B1=146faf38307bd40cdeb44eb676a773db8d3d0f71
A=5e40b192263e55a07d6d210bccede3eb7b47c6b7
B=296d4c104a437475e01c7598501ae073e439461e
URL=https://github.com/StrobiSoft/Babylon.git

exec >>"$LOG" 2>&1

echo "=== BBB1 B1.0 -> A -> B SERIES ==="
echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "b1=$B1"
echo "a=$A"
echo "b=$B"

finish() {
  rc=$?
  echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "series_exit_code=$rc"
  rm -f "$PIDFILE"
  exit "$rc"
}
trap finish EXIT

source "$LAB/.secrets/postgres.env"
export TEST_DATABASE_URL="postgresql://noemi_bench:${POSTGRES_PASSWORD}@127.0.0.1:55433/babylon_bench"
unset POSTGRES_PASSWORD

CHROMIUM=""
for p in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
  if [ -x "$p" ]; then CHROMIUM="$p"; break; fi
done
if [ -z "$CHROMIUM" ]; then
  for p in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do
    if [ -x "$p" ]; then CHROMIUM="$p"; break; fi
  done
fi
if [ -z "$CHROMIUM" ]; then
  echo "BBB1_SERIES=BLOCKED"
  echo "reason=chromium_executable_not_found"
  exit 71
fi
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM"
echo "chromium=$CHROMIUM"

prepare_remote_worktree() {
  name="$1"; commit="$2"; w="$LAB/worktrees/$name"
  if [ ! -d "$w/.git" ]; then
    rm -rf "$w"
    git clone --filter=blob:none "$URL" "$w"
  fi
  git -C "$w" fetch --prune origin
  git -C "$w" checkout --detach "$commit"
  git -C "$w" reset --hard "$commit"
  actual="$(git -C "$w" rev-parse HEAD)"
  [ "$actual" = "$commit" ] || { echo "commit_mismatch=$name:$actual"; exit 72; }
}

prepare_remote_worktree b1 "$B1"
prepare_remote_worktree a "$A"

BW="$LAB/worktrees/b-exact"
[ -d "$BW/.git" ] || { echo "BBB1_SERIES=BLOCKED"; echo "reason=b_worktree_missing"; exit 73; }
[ "$(git -C "$BW" rev-parse HEAD)" = "$B" ] || { echo "BBB1_SERIES=BLOCKED"; echo "reason=b_commit_mismatch"; exit 74; }

prepare_node() {
  w="$1"
  if [ ! -d "$w/node_modules" ]; then
    echo "npm_ci=$w"
    (cd "$w/babylon-project" && npm ci --no-audit --no-fund)
  fi
}
prepare_node "$LAB/worktrees/b1"
prepare_node "$LAB/worktrees/a"
prepare_node "$BW"

run_one() {
  label="$1"; w="$2"; schedule="$3"
  out="$RUNS/$label"
  mkdir -p "$out"
  echo "=== RUN $label ==="
  echo "commit=$(git -C "$w" rev-parse HEAD)"

  sudo -n /usr/local/sbin/noemi-babylon-gate pg-reset

  export RUN_SOFT_CHAT_LOAD=1
  export SOFT_CHAT_LOAD_STAGES=500
  export SOFT_CHAT_LOAD_MODES=independent-streaming
  export SOFT_CHAT_LOAD_POOL_MAX=20
  export SOFT_CHAT_LOAD_POLL_INTERVAL_MS=500
  export SOFT_CHAT_LOAD_CLIENT_RAMP_MS=5000
  export SOFT_CHAT_LOAD_WARMUP_MS=2000
  export SOFT_CHAT_LOAD_SEPARATE_SERVER=1
  export SOFT_CHAT_LOAD_COMPARISON=1
  export SOFT_CHAT_LOAD_MAX_ERROR_RATE=0.01
  export SOFT_CHAT_LOAD_MAX_P99_MS=10000
  export SOFT_CHAT_LOAD_OUTPUT_DIR="$out"
  if [ -n "$schedule" ]; then export SOFT_CHAT_LOAD_PENDING_SCHEDULE="$schedule"; else unset SOFT_CHAT_LOAD_PENDING_SCHEDULE || true; fi

  (cd "$w/babylon-project" && npm run check && npm run check:test && npm run load:soft-chat)
  echo "RUN_${label}=PASS"
}

run_one b1 "$LAB/worktrees/b1" ""
run_one a "$LAB/worktrees/a" fixed-grid
run_one b "$BW" fixed-grid

sudo -n /usr/local/sbin/noemi-babylon-gate pg-status || true
find "$RUNS" -maxdepth 3 -type f -printf '%TY-%Tm-%Td %TH:%TM:%TS %s %p\n' | sort

echo BBB1_B1_A_B_SERIES=PASS
JOB_EOF
chmod 0700 "$JOB"

nohup setsid "$JOB" >/dev/null 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$PIDFILE"
echo BBB1_B1_A_B_SERIES_LAUNCHED=PASS
echo pid="$pid"
echo log="$LOG"
echo results="$RUNS"
