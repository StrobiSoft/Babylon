# Node Core benchmark result

- Target: `76ad3817faad24b6425668f9bb4fe9e4d3dac1d5`
- Harness commit: `9dc658ac0b03e3f9ad46c0cc3922a81d89efbfa2`
- Timestamp: 2026-09-07T02:44:32.919Z
- Runtime: v24.20.0 / V8 13.6.233.17-node.53
- CPU: Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz; affinity 2

| Scenario                    | ops/s mean |  p50 us |  p95 us |  p99 us |   ops/s min–max | spread |
| --------------------------- | ---------: | ------: | ------: | ------: | --------------: | -----: |
| ed25519_sign_envelope       |    22245.2 |  43.667 |  56.085 |  84.613 | 22037.6–22424.5 |  1.74% |
| ed25519_verify_canonicalize |     9026.6 | 108.089 | 128.409 |  175.77 |     8901–9129.8 |  2.53% |
| wake_process_fresh          |     4333.6 | 216.293 | 264.107 | 404.115 |   4262.7–4386.1 |  2.85% |
| read_process_authorized     |       4280 |  220.84 | 271.319 | 411.552 |   4238.1–4334.4 |  2.25% |
| command_process_authorized  |     4211.8 | 223.271 |  274.29 | 409.972 |   4156.1–4260.7 |  2.48% |
| duplicate_replay_rejection  |     5531.4 | 171.359 | 207.604 | 327.653 |   5484.1–5592.3 |  1.96% |

## Harness overhead controls

- harness_sync_overhead: 24577099.3 ops/s; p50 0.041 us; p95 0.069 us; p99 0.072 us.
- harness_async_overhead: 10026879.5 ops/s; p50 0.114 us; p95 0.163 us; p99 0.174 us.

The COMMAND replay store is a benchmark-only, non-production, non-persistent stub.
These transport-neutral microbenchmarks do not imply production end-to-end latency.
