# Delta benchmark series — 2026-09-06

## Naming

- **Delta 1** = former `B1` baseline, commit `146faf38307bd40cdeb44eb676a773db8d3d0f71`.
- Historical experiment labels `A` and `B` remain historical only.
- **Delta 1.1** = saved best state represented by historical experiment `B`, commit `296d4c104a437475e01c7598501ae073e439461e` (parent `5e40b192263e55a07d6d210bccede3eb7b47c6b7`).

## Delta 1 measured result

Formal VM103 run, 500 clients, independent-streaming, pool 20, 500 ms polling:

- send-to-ACK p99: 3554.936431 ms
- throughput: 135.32 msg/s
- 500/500 messages and ACKs
- duplicates: 0
- exactly-once violations: 0
- result: PASS

## Delta 1.1 saved result/state

Formal VM103 historical-`B` run, 500 clients, independent-streaming, pool 20, fixed-grid 500 ms polling:

- source commit: `296d4c104a437475e01c7598501ae073e439461e`
- send-to-ACK p99: 3359.911796 ms
- throughput: 144.51 msg/s
- authentication p99: 599.552638 ms
- accept p99: 316.920003 ms
- pending-fetch p99: 419.678398 ms
- acknowledge p99: 235.389807 ms
- pool max waiting: 520
- PostgreSQL max connections: 21
- 500/500 messages and ACKs
- duplicates: 0
- exactly-once violations: 0
- result: PASS

This record names the historical `B` measurement/state **Delta 1.1**. The recovered exact B worktree and benchmark artifacts remain the executable/source evidence on VM103.

## Authorized next isolated experiments

Both experiments start from the Delta 1.1 source state and change only one benchmark parameter.

### C — pool headroom

- pool max: **40** (from 20)
- poll interval: 500 ms
- all other formal parameters unchanged

Hypothesis: the measured pool queue (max waiting 520) is a material contributor to tail latency. Historical pool-40 evidence was directionally positive, so this is the strongest low-risk parameter test.

### D — pending-poll pressure reduction

- pool max: 20
- poll interval: **750 ms** (from 500 ms)
- all other formal parameters unchanged

Hypothesis: Delta 1.1 issued 4922 pending fetches and skipped 3710 fixed-grid ticks in only 3.46 s, indicating the 500 ms cadence is oversubscribed under 500-client load. A 750 ms cadence reduces request pressure by about one third while keeping polling sub-second.

C and D are intentionally isolated. A combined C+D run is not authorized by this record and requires a separate owner decision after results are reviewed.
