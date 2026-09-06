#!/bin/bash
set -euo pipefail
LAB=/srv/noemi-babylon-lab
RUNS="$LAB/results/b1-a-b-20260906"
python3 - "$RUNS" <<'PY'
import csv, glob, os, sys
root=sys.argv[1]
fields=[
  'started_at','finished_at','requested_clients','authenticated_clients',
  'messages_attempted','messages_succeeded','messages_failed','ack_succeeded','ack_failed',
  'throughput_messages_per_second','authentication_p99_ms','accept_p99_ms',
  'pending_fetch_p99_ms','acknowledge_p99_ms','send_to_visible_p99_ms','visible_to_ack_p99_ms',
  'send_to_ack_p99_ms','send_to_ack_max_ms','auth_connection_wait_p99_ms',
  'accept_connection_wait_p99_ms','pending_connection_wait_p99_ms','ack_connection_wait_p99_ms',
  'pool_max_total','pool_max_waiting','postgres_max_connections','postgres_max_lock_waiting',
  'server_cpu_percent','server_event_loop_utilization_percent','server_event_loop_delay_p99_ms',
  'driver_cpu_percent','driver_event_loop_utilization_percent','driver_event_loop_delay_p99_ms',
  'duplicates','exactly_once_violations','pending_schedule','pending_schedule_skipped_ticks',
  'pending_overlap_violations','pending_auth_isolation','pending_auth_context_creations',
  'pending_auth_handle_requests','duration_ms','result','reason'
]
print('BBB1_FRESH_READBACK_BEGIN')
for label in ('b1','a','b'):
    files=sorted(glob.glob(os.path.join(root,label,'*.csv')))
    if not files:
        print(f'LABEL={label}')
        print('STATE=MISSING')
        continue
    path=files[-1]
    with open(path, newline='', encoding='utf-8') as f:
        rows=list(csv.DictReader(f))
    if not rows:
        print(f'LABEL={label}')
        print('STATE=EMPTY')
        continue
    r=rows[-1]
    print(f'LABEL={label}')
    print('FILE='+os.path.basename(path))
    for k in fields:
        if k in r:
            print(f'{k}={r[k]}')
print('BBB1_FRESH_READBACK_END')
PY
