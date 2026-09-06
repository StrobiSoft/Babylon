#!/bin/bash
set -euo pipefail
LAB=/srv/noemi-babylon-lab
RUNS="$LAB/results/b1-a-b-20260906"
python3 - "$RUNS" <<'PY'
import csv, glob, os, sys
root=sys.argv[1]
fields=[
  'send_to_ack_p99_ms','throughput_messages_per_second','messages_succeeded','ack_succeeded',
  'authentication_p99_ms','accept_p99_ms','pending_fetch_p99_ms','acknowledge_p99_ms',
  'pending_connection_wait_p99_ms','pool_max_waiting','postgres_max_connections',
  'duplicates','exactly_once_violations','pending_schedule','pending_schedule_skipped_ticks',
  'pending_overlap_violations','result','reason'
]
print('BBB1_SERIES_SUMMARY_BEGIN')
for label in ('b1','a','b'):
    files=sorted(glob.glob(os.path.join(root,label,'*.csv')))
    if not files:
        print(f'{label}:MISSING')
        continue
    with open(files[-1], newline='', encoding='utf-8') as f:
        rows=list(csv.DictReader(f))
    if not rows:
        print(f'{label}:EMPTY')
        continue
    r=rows[-1]
    print('LABEL='+label)
    print('FILE='+os.path.basename(files[-1]))
    for k in fields:
        if k in r:
            print(f'{k}={r[k]}')
print('BBB1_SERIES_SUMMARY_END')
PY
