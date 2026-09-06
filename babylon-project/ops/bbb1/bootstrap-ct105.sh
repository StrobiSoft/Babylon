#!/bin/bash
set -euo pipefail

# Babylon Benchmark Box 1.0 - CT105 one-time control/bootstrap installer
# Scope: CT105 + VM103 benchmark-only control path.
# This script does not modify the production Babylon checkout, production DB,
# production containers, firewall, routing, or host package set.

MARKER="BBB1_CT105_BOOTSTRAP_V1"
VM="192.168.1.90"
BENCH_USER="noemi-bench"
BENCH_KEY="/home/noemi-codex/.ssh/noemi-to-babylon-bench-ed25519"
OLD_KEY="/home/noemi-codex/.ssh/noemi-to-babylon-ed25519"
KNOWN="/home/noemi-codex/.ssh/known_hosts"
DISPATCH="/usr/local/sbin/noemi-babylon-bench-dispatch"
REMOTE_GATE="/usr/local/sbin/noemi-babylon-gate"
REMOTE_SUDOERS="/etc/sudoers.d/noemi-babylon-bench"

if [ "$(id -u)" -ne 0 ]; then
  echo "BBB1_BOOTSTRAP=BLOCKED"
  echo "reason=must_run_as_root_on_ct105"
  exit 20
fi

for f in "$BENCH_KEY" "$OLD_KEY" "$KNOWN"; do
  if [ ! -r "$f" ]; then
    echo "BBB1_BOOTSTRAP=BLOCKED"
    echo "reason=missing_required_file:$f"
    exit 21
  fi
done

SSH_BENCH=(
  /usr/bin/ssh
  -i "$BENCH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN"
  -o ConnectTimeout=5
  "$BENCH_USER@$VM"
)

SSH_OLD=(
  /usr/bin/ssh
  -i "$OLD_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN"
  -o ConnectTimeout=5
  "codex@$VM"
)

SCP_OLD=(
  /usr/bin/scp
  -q
  -i "$OLD_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN"
)

echo "=== Babylon Benchmark Box 1.0 control bootstrap ==="

echo "--- direct benchmark identity preflight ---"
"${SSH_BENCH[@]}" '
  set -eu
  test "$(id -un)" = noemi-bench
  test -w /srv/noemi-babylon-lab
  test ! -w /srv/babylon
  test ! -r /srv/babylon/.env
  if id -nG | tr " " "\n" | grep -Eq "^(sudo|docker|devagents)$"; then
    exit 41
  fi
  echo BBB1_DIRECT_IDENTITY=PASS
'

echo "--- bootstrap image preflight ---"
"${SSH_OLD[@]}" 'docker image inspect postgres:17.10-alpine >/dev/null 2>&1'
echo "BBB1_BOOT_IMAGE=PASS"

TMPDIR_LOCAL="$(mktemp -d /tmp/bbb1-bootstrap.XXXXXX)"
cleanup() {
  rm -rf "$TMPDIR_LOCAL"
}
trap cleanup EXIT

cat > "$TMPDIR_LOCAL/noemi-babylon-gate" <<'REMOTE_GATE_EOF'
#!/bin/bash
set -euo pipefail

DOCKER=/usr/bin/docker
LAB=/srv/noemi-babylon-lab
SECRETS="$LAB/.secrets"
ENVFILE="$SECRETS/postgres.env"
PG_CONTAINER=bbb1-postgres
PG_NETWORK=bbb1-net
PG_VOLUME=bbb1-postgres-data
PG_IMAGE=postgres:17.10-alpine
PG_PORT=55432
BENCH_USER=noemi-bench

require_root() {
  [ "$(id -u)" -eq 0 ] || { echo "BBB1_GATE_DENIED: wrong_user" >&2; exit 77; }
}

ensure_secret() {
  local gid pass
  gid="$(id -g "$BENCH_USER")"
  install -d -m 0750 -o root -g "$gid" "$SECRETS"
  if [ ! -s "$ENVFILE" ]; then
    pass="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
    umask 0077
    printf 'POSTGRES_PASSWORD=%s\n' "$pass" > "$ENVFILE"
    chown root:"$gid" "$ENVFILE"
    chmod 0640 "$ENVFILE"
  fi
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn | awk 'NR>1 {print $4}' | grep -Eq "(^|:)${PG_PORT}$"
  else
    return 1
  fi
}

pg_up() {
  ensure_secret

  if "$DOCKER" container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$PG_CONTAINER")" != "true" ]; then
      "$DOCKER" start "$PG_CONTAINER" >/dev/null
    fi
  else
    if port_in_use; then
      echo "BBB1_PG_UP=BLOCKED"
      echo "reason=port_${PG_PORT}_already_in_use"
      exit 31
    fi

    "$DOCKER" network inspect "$PG_NETWORK" >/dev/null 2>&1 || \
      "$DOCKER" network create "$PG_NETWORK" >/dev/null

    "$DOCKER" volume inspect "$PG_VOLUME" >/dev/null 2>&1 || \
      "$DOCKER" volume create "$PG_VOLUME" >/dev/null

    "$DOCKER" run -d \
      --name "$PG_CONTAINER" \
      --restart no \
      --network "$PG_NETWORK" \
      -p "127.0.0.1:${PG_PORT}:5432" \
      --env-file "$ENVFILE" \
      -e POSTGRES_DB=babylon_bench \
      -e POSTGRES_USER=noemi_bench \
      -v "$PG_VOLUME:/var/lib/postgresql/data" \
      "$PG_IMAGE" >/dev/null
  fi

  for _ in $(seq 1 30); do
    if "$DOCKER" exec "$PG_CONTAINER" pg_isready -U noemi_bench -d babylon_bench >/dev/null 2>&1; then
      echo "BBB1_PG_UP=PASS"
      return 0
    fi
    sleep 1
  done

  "$DOCKER" logs --tail 80 "$PG_CONTAINER" >&2 || true
  echo "BBB1_PG_UP=FAIL" >&2
  exit 32
}

pg_down() {
  if "$DOCKER" container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    "$DOCKER" rm -f "$PG_CONTAINER" >/dev/null
  fi
  echo "BBB1_PG_DOWN=PASS"
}

pg_reset() {
  if "$DOCKER" container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    "$DOCKER" rm -f "$PG_CONTAINER" >/dev/null
  fi
  if "$DOCKER" volume inspect "$PG_VOLUME" >/dev/null 2>&1; then
    "$DOCKER" volume rm "$PG_VOLUME" >/dev/null
  fi
  pg_up
  echo "BBB1_PG_RESET=PASS"
}

pg_status() {
  if ! "$DOCKER" container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    echo "BBB1_PG_CONTAINER=ABSENT"
    exit 0
  fi
  "$DOCKER" ps -a --filter "name=^/${PG_CONTAINER}$" --format 'name={{.Names}} status={{.Status}} image={{.Image}} ports={{.Ports}}'
  if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$PG_CONTAINER")" = "true" ]; then
    "$DOCKER" exec "$PG_CONTAINER" pg_isready -U noemi_bench -d babylon_bench || true
  fi
}

pg_logs() {
  "$DOCKER" logs --tail 200 "$PG_CONTAINER"
}

pg_metrics() {
  "$DOCKER" exec "$PG_CONTAINER" psql -U noemi_bench -d babylon_bench -Atc \
    "select 'database='||current_database(); select 'user='||current_user; select 'connections='||count(*) from pg_stat_activity where datname=current_database();"
}

runtime_status() {
  echo "=== BBB1 RUNTIME ==="
  df -h "$LAB" || true
  du -sh "$LAB" 2>/dev/null || true
  ps -u "$BENCH_USER" -o pid,ppid,etime,pcpu,pmem,cmd --sort=pid 2>/dev/null || true
  pg_status
}

require_root

case "${1:-}" in
  pg-up) pg_up ;;
  pg-down) pg_down ;;
  pg-reset) pg_reset ;;
  pg-status) pg_status ;;
  pg-logs) pg_logs ;;
  pg-metrics) pg_metrics ;;
  runtime-status) runtime_status ;;
  *)
    echo "BBB1_GATE_DENIED: unsupported_action" >&2
    exit 65
    ;;
esac
REMOTE_GATE_EOF

cat > "$TMPDIR_LOCAL/noemi-babylon-bench.sudoers" <<'REMOTE_SUDOERS_EOF'
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate pg-up
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate pg-down
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate pg-reset
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate pg-status
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate pg-logs
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate pg-metrics
noemi-bench ALL=(root) NOPASSWD: /usr/local/sbin/noemi-babylon-gate runtime-status
REMOTE_SUDOERS_EOF

chmod 0755 "$TMPDIR_LOCAL/noemi-babylon-gate"
chmod 0440 "$TMPDIR_LOCAL/noemi-babylon-bench.sudoers"

echo "--- install VM103 benchmark gate ---"
"${SCP_OLD[@]}" \
  "$TMPDIR_LOCAL/noemi-babylon-gate" \
  "$TMPDIR_LOCAL/noemi-babylon-bench.sudoers" \
  "codex@$VM:/tmp/"

"${SSH_OLD[@]}" '
  set -eu
  docker run --rm --network none -v /:/host:rw postgres:17.10-alpine sh -eu -c "
    cp /host/tmp/noemi-babylon-gate /host/usr/local/sbin/noemi-babylon-gate
    chown 0:0 /host/usr/local/sbin/noemi-babylon-gate
    chmod 0755 /host/usr/local/sbin/noemi-babylon-gate

    cp /host/tmp/noemi-babylon-bench.sudoers /host/etc/sudoers.d/noemi-babylon-bench
    chown 0:0 /host/etc/sudoers.d/noemi-babylon-bench
    chmod 0440 /host/etc/sudoers.d/noemi-babylon-bench
  "
  docker run --rm --network none -v /:/host:rw postgres:17.10-alpine \
    chroot /host /usr/sbin/visudo -cf /etc/sudoers.d/noemi-babylon-bench >/dev/null
  rm -f /tmp/noemi-babylon-gate /tmp/noemi-babylon-bench.sudoers
  echo BBB1_VM103_GATE_INSTALL=PASS
'

cat > "$TMPDIR_LOCAL/noemi-babylon-bench-dispatch" <<'DISPATCH_EOF'
#!/bin/bash
set -euo pipefail

VM=192.168.1.90
USER=noemi-bench
KEY=/home/noemi-codex/.ssh/noemi-to-babylon-bench-ed25519
KNOWN=/home/noemi-codex/.ssh/known_hosts
LAB=/srv/noemi-babylon-lab
CONTROL_REPO="$LAB/control-repo"
CONTROL_BRANCH=ops/noemi-benchmark-control
CONTROL_SCRIPT="$CONTROL_REPO/babylon-project/benchmark-control/run.sh"
MAX_LAB_BYTES=32212254720

SSH=(
  /usr/bin/ssh
  -i "$KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN"
  -o ConnectTimeout=5
  "$USER@$VM"
)

remote() {
  exec "${SSH[@]}" "$1"
}

case "${1:-}" in
  babylon-bench-e2e)
    remote '
      set -eu
      echo "=== IDENTITY ==="
      id
      test "$(id -un)" = noemi-bench
      test -w /srv/noemi-babylon-lab
      touch /srv/noemi-babylon-lab/tmp/.bbb1-e2e
      rm /srv/noemi-babylon-lab/tmp/.bbb1-e2e
      echo LAB_WRITE=PASS
      test ! -w /srv/babylon
      echo PRODUCTION_WRITE_DENIED=PASS
      test ! -r /srv/babylon/.env
      echo PRODUCTION_ENV_READ_DENIED=PASS
      if id -nG | tr " " "\n" | grep -Eq "^(sudo|docker|devagents)$"; then
        echo PRIVILEGED_GROUP_DENY=FAIL
        exit 41
      fi
      echo PRIVILEGED_GROUP_DENY=PASS
      if sudo -n true >/dev/null 2>&1; then
        echo GENERIC_SUDO_DENY=FAIL
        exit 42
      fi
      echo GENERIC_SUDO_DENY=PASS
      if docker ps >/dev/null 2>&1; then
        echo GENERIC_DOCKER_DENY=FAIL
        exit 43
      fi
      echo GENERIC_DOCKER_DENY=PASS
      sudo -n /usr/local/sbin/noemi-babylon-gate pg-status >/dev/null
      echo SEMANTIC_GATE=PASS
      echo BBB1_E2E=PASS
    '
    ;;

  babylon-bench-preflight)
    remote '
      set -eu
      echo "=== BBB1 PREFLIGHT ==="
      id
      hostname
      printf "git="; git --version 2>/dev/null || true
      printf "node="; node --version 2>/dev/null || true
      printf "npm="; npm --version 2>/dev/null || true
      df -h /srv/noemi-babylon-lab
      du -sh /srv/noemi-babylon-lab 2>/dev/null || true
      stat -c "%U:%G %a %n" /srv/noemi-babylon-lab /srv/babylon 2>/dev/null || true
      test ! -w /srv/babylon && echo PRODUCTION_WRITE_DENIED=PASS
      test ! -r /srv/babylon/.env && echo PRODUCTION_ENV_READ_DENIED=PASS
      sudo -n /usr/local/sbin/noemi-babylon-gate pg-status
    '
    ;;

  babylon-bench-pg-up)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate pg-up'
    ;;
  babylon-bench-pg-down)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate pg-down'
    ;;
  babylon-bench-pg-reset)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate pg-reset'
    ;;
  babylon-bench-pg-status)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate pg-status'
    ;;
  babylon-bench-pg-logs)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate pg-logs'
    ;;
  babylon-bench-pg-metrics)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate pg-metrics'
    ;;
  babylon-bench-runtime-status)
    remote 'sudo -n /usr/local/sbin/noemi-babylon-gate runtime-status'
    ;;

  babylon-bench-artifacts)
    remote '
      set -eu
      echo "=== MANIFESTS ==="
      find /srv/noemi-babylon-lab/manifests -maxdepth 2 -type f -printf "%TY-%Tm-%Td %TH:%TM:%TS %s %p\n" 2>/dev/null | sort || true
      echo "=== RESULTS ==="
      find /srv/noemi-babylon-lab/results -maxdepth 3 -type f -printf "%TY-%Tm-%Td %TH:%TM:%TS %s %p\n" 2>/dev/null | sort || true
    '
    ;;

  babylon-bench-worktree-status)
    remote '
      set -eu
      root=/srv/noemi-babylon-lab/worktrees
      find "$root" -maxdepth 3 -type d -name .git -print 2>/dev/null | while read -r g; do
        r="${g%/.git}"
        echo "=== $r ==="
        git -C "$r" rev-parse HEAD 2>/dev/null || true
        git -C "$r" status --short --branch 2>/dev/null || true
      done
    '
    ;;

  babylon-bench-ct105-b-state)
    R=/home/noemi-codex/workspace/babylon-project
    echo "=== CT105 HISTORICAL B STATE ==="
    if [ ! -d "$R/.git" ]; then
      echo CT105_B_REPO=ABSENT
      exit 0
    fi
    /usr/bin/git -C "$R" rev-parse HEAD 2>/dev/null || true
    /usr/bin/git -C "$R" status --short --branch 2>/dev/null || true
    /usr/bin/git -C "$R" show -s --format='commit=%H%nparent=%P%nsubject=%s%ndate=%cI' 296d4c104a437475e01c7598501ae073e439461e 2>/dev/null || echo B_COMMIT_OBJECT=ABSENT
    /usr/bin/git -C "$R" diff -- backend/test/soft-chat-pending-auth-isolation.test.ts 2>/dev/null || true
    ;;

  babylon-bench-control-sync)
    remote '
      set -eu
      R=/srv/noemi-babylon-lab/control-repo
      URL=https://github.com/StrobiSoft/Babylon.git
      BRANCH=ops/noemi-benchmark-control
      if [ ! -d "$R/.git" ]; then
        rm -rf "$R"
        git clone --filter=blob:none --no-checkout "$URL" "$R"
      fi
      git -C "$R" fetch --prune origin "$BRANCH"
      git -C "$R" checkout -B "$BRANCH" FETCH_HEAD
      git -C "$R" reset --hard FETCH_HEAD
      echo BBB1_CONTROL_SYNC=PASS
      git -C "$R" rev-parse HEAD
    '
    ;;

  babylon-bench-control-run)
    remote '
      set -eu
      R=/srv/noemi-babylon-lab
      S="$R/control-repo/babylon-project/benchmark-control/run.sh"
      MAX=32212254720
      test -f "$S"
      test -x "$S" || chmod u+x "$S"
      BYTES="$(du -sb "$R" | awk "{print \$1}")"
      if [ "$BYTES" -gt "$MAX" ]; then
        echo BBB1_CONTROL_RUN=BLOCKED
        echo reason=lab_storage_guardrail_exceeded
        exit 73
      fi
      cd "$R"
      /bin/bash "$S"
      BYTES="$(du -sb "$R" | awk "{print \$1}")"
      echo lab_bytes="$BYTES"
      if [ "$BYTES" -gt "$MAX" ]; then
        echo BBB1_STORAGE_GUARDRAIL=EXCEEDED
        exit 74
      fi
      echo BBB1_CONTROL_RUN=PASS
    '
    ;;

  *)
    echo "NOEMI-MAINT DENIED: unsupported_babylon_bench_action" >&2
    exit 65
    ;;
esac
DISPATCH_EOF

install -o root -g root -m 0755 \
  "$TMPDIR_LOCAL/noemi-babylon-bench-dispatch" \
  "$DISPATCH"

echo "BBB1_CT105_DISPATCH_INSTALL=PASS"

# Wrap the existing NOEMI-MAINT runner without replacing its historical chain.
if grep -q 'NOEMI_BBB1_DISPATCH_V1' /usr/local/sbin/noemi-maint 2>/dev/null; then
  echo "BBB1_NOEMI_MAINT_WRAPPER=ALREADY_PRESENT"
else
  BACKUP="/usr/local/sbin/noemi-maint.pre-bbb1-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a /usr/local/sbin/noemi-maint "$BACKUP"

  cat > /usr/local/sbin/noemi-maint <<WRAPPER_EOF
#!/bin/bash
set -euo pipefail
# NOEMI_BBB1_DISPATCH_V1
case "\${1:-}" in
  babylon-bench-*)
    exec /usr/local/sbin/noemi-babylon-bench-dispatch "\$@"
    ;;
  *)
    exec "$BACKUP" "\$@"
    ;;
esac
WRAPPER_EOF

  chown root:root /usr/local/sbin/noemi-maint
  chmod 0755 /usr/local/sbin/noemi-maint
  echo "BBB1_NOEMI_MAINT_WRAPPER=PASS"
  echo "bbb1_previous_runner=$BACKUP"
fi

echo "--- direct semantic E2E ---"
/usr/local/sbin/noemi-babylon-bench-dispatch babylon-bench-e2e

echo "--- dedicated PostgreSQL positive/cleanup E2E ---"
/usr/local/sbin/noemi-babylon-bench-dispatch babylon-bench-pg-up
/usr/local/sbin/noemi-babylon-bench-dispatch babylon-bench-pg-status
/usr/local/sbin/noemi-babylon-bench-dispatch babylon-bench-pg-metrics
/usr/local/sbin/noemi-babylon-bench-dispatch babylon-bench-pg-down

echo "--- final negative checks ---"
"${SSH_BENCH[@]}" '
  set -eu
  test ! -w /srv/babylon
  test ! -r /srv/babylon/.env
  ! sudo -n /bin/true >/dev/null 2>&1
  ! docker ps >/dev/null 2>&1
  echo BBB1_NEGATIVE_E2E=PASS
'

echo "=== BBB1 CONTROL PATH READY ==="
echo "BBB1_CT105_TO_VM103=PASS"
echo "BBB1_SEMANTIC_GATE=PASS"
echo "BBB1_POSTGRES_GATE=PASS"
echo "BBB1_PRODUCTION_BOUNDARY=PASS"
echo "BBB1_BOOTSTRAP=PASS"
