#!/bin/bash
set -euo pipefail

DISPATCH=/usr/local/sbin/noemi-babylon-bench-dispatch
OLD_KEY=/home/noemi-codex/.ssh/noemi-to-babylon-ed25519
KNOWN=/home/noemi-codex/.ssh/known_hosts
VM=192.168.1.90

SSH_OLD=(
  runuser -u noemi-codex --
  ssh
  -i "$OLD_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN"
  codex@"$VM"
)

echo "=== BBB1 PORT REHOME ==="

LEGACY_BEFORE="$("${SSH_OLD[@]}" 'docker inspect -f "{{.Id}}|{{.State.Running}}|{{json .HostConfig.PortBindings}}" babylon-soft-chat-load-postgres')"
echo "legacy_before=$LEGACY_BEFORE"

"$DISPATCH" babylon-bench-pg-down

NEW_PORT="$("${SSH_OLD[@]}" '
  for p in $(seq 55433 55449); do
    if ! ss -ltn | awk "NR>1 {print \$4}" | grep -Eq "(^|:)${p}$"; then
      echo "$p"
      exit 0
    fi
  done
  exit 71
')"

echo "selected_port=$NEW_PORT"

"${SSH_OLD[@]}" "NEW_PORT=$NEW_PORT docker run --rm --network none -e NEW_PORT=$NEW_PORT -v /:/host:rw postgres:17.10-alpine sh -eu -c '
  f=/host/usr/local/sbin/noemi-babylon-gate
  ts=\$(date -u +%Y%m%dT%H%M%SZ)
  cp -a \"\$f\" \"\$f.pre-port-change-\$ts\"
  sed -i \"s/^PG_PORT=.*/PG_PORT=\$NEW_PORT/\" \"\$f\"
  grep -q \"^PG_PORT=\$NEW_PORT\$\" \"\$f\"
  echo backup=\"\$f.pre-port-change-\$ts\"
  echo new_setting=PG_PORT=\$NEW_PORT
'"

"$DISPATCH" babylon-bench-pg-up
"$DISPATCH" babylon-bench-pg-status
"$DISPATCH" babylon-bench-pg-metrics

"${SSH_OLD[@]}" "ss -ltn | grep ':$NEW_PORT '"
"${SSH_OLD[@]}" "docker ps --format '{{.Names}}  {{.Ports}}' | grep '^bbb1-postgres '"

"$DISPATCH" babylon-bench-pg-down

LEGACY_AFTER="$("${SSH_OLD[@]}" 'docker inspect -f "{{.Id}}|{{.State.Running}}|{{json .HostConfig.PortBindings}}" babylon-soft-chat-load-postgres')"
echo "legacy_after=$LEGACY_AFTER"

if [ "$LEGACY_BEFORE" != "$LEGACY_AFTER" ]; then
  echo "BBB1_LEGACY_PRESERVATION=FAIL"
  exit 72
fi

echo "BBB1_LEGACY_PRESERVATION=PASS"
echo "BBB1_POSTGRES_GATE=PASS"
echo "BBB1_SELECTED_PORT=$NEW_PORT"
