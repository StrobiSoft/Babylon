# NODE IJET Node Core benchmark report

- **TARGET_SHA:** `76ad3817faad24b6425668f9bb4fe9e4d3dac1d5`
- **HARNESS_COMMIT_AT_MEASUREMENT:** `9dc658ac0b03e3f9ad46c0cc3922a81d89efbfa2`
- **MEASURED_AT:** `2026-09-07T02:44:32.919Z`
- **PRODUCT_CODE_CHANGED:** NO

## Environment

- Linux `7.0.14-6-pve`, x86-64
- Node.js `v24.20.0`, V8 `13.6.233.17-node.53`, npm `11.19.0`
- Intel Core i7-8700 @ 3.20 GHz; 6 physical cores / 12 logical CPUs
- benchmark process and all workers pinned to logical CPU 2
- 8 GiB memory visible to the Node process
- load average at report: 1.10 / 0.80 / 0.48

## Test precheck and integrity

- `npm run test:node-core`: PASS — 5 files, 25 tests
- `npm run check`: PASS
- `npm run build`: PASS
- `git diff --exit-code 76ad3817faad24b6425668f9bb4fe9e4d3dac1d5 -- babylon-project/node-core`: PASS — no product-tree difference
- every scenario has 5 measured runs and 5 distinct worker PIDs
- every measured run used 1,500 ms warmup, 2,500 ms uninstrumented throughput measurement, and 20,000 separately timed latency samples

## Results

Latency values are microseconds. Each latency column is the median of the five independent
run-level percentiles. Spread is the full throughput range divided by the five-run mean.

| Scenario                                | ops/s mean |     p50 |     p95 |     p99 |     ops/s min–max | spread |
| --------------------------------------- | ---------: | ------: | ------: | ------: | ----------------: | -----: |
| Ed25519 sign envelope                   |   22,245.2 |  43.667 |  56.085 |  84.613 | 22,037.6–22,424.5 |  1.74% |
| Ed25519 verify + canonicalization       |    9,026.6 | 108.089 | 128.409 | 175.770 |   8,901.0–9,129.8 |  2.53% |
| WAKE `NodeCore.process()` fresh         |    4,333.6 | 216.293 | 264.107 | 404.115 |   4,262.7–4,386.1 |  2.85% |
| READ `NodeCore.process()` authorized    |    4,280.0 | 220.840 | 271.319 | 411.552 |   4,238.1–4,334.4 |  2.25% |
| COMMAND `NodeCore.process()` authorized |    4,211.8 | 223.271 | 274.290 | 409.972 |   4,156.1–4,260.7 |  2.48% |
| Duplicate/replay rejection hot path     |    5,531.4 | 171.359 | 207.604 | 327.653 |   5,484.1–5,592.3 |  1.96% |

## Harness overhead controls

| Control                     |   ops/s mean |   p50 |   p95 |   p99 | spread |
| --------------------------- | -----------: | ----: | ----: | ----: | -----: |
| synchronous loop/call/timer | 24,577,099.3 | 0.041 | 0.069 | 0.072 |  8.52% |
| async loop/call/await/timer | 10,026,879.5 | 0.114 | 0.163 | 0.174 |  3.68% |

Scenario results are raw; the controls were not subtracted. The latency-control p50 is below 0.3%
of even the fastest measured scenario p50.

## Bottleneck observations

- Verify plus canonicalization has 40.6% of sign throughput and a 2.48x p50 latency. Among the
  separately measured crypto paths, it is the larger cost.
- Fresh WAKE, READ, and COMMAND cluster within 2.9% of one another by mean throughput. The small
  differences indicate that the minimal local authorization/read/command handlers are not the
  dominant cost in this harness.
- The full accepted paths include inbound verification/canonicalization, replay digest
  canonicalization, validation, and reply signing. Their p50 is roughly 2x the isolated verify path,
  consistent with crypto/canonicalization dominating this transport-free configuration; the
  benchmark does not separately attribute every internal stage.
- Replay rejection is 31.3% higher-throughput than accepted COMMAND because it exits before local
  authorization, handler execution, reply construction, and reply signing. It still includes
  envelope validation, peer/key checks, signature verification, time validation, digesting, and
  the benchmark replay claim.

## Measurement limitations

- This is a sequential, single-thread, warm-cache microbenchmark on one host, not a concurrency or
  saturation test.
- It uses no transport, listener, socket, deployment, Bridge/NOEMI/CT105 live flow, or VM103
  benchmark control. It cannot support conclusions about production end-to-end latency.
- `BenchmarkReplayStore` is a **benchmark-only, non-production, non-persistent stub**. Its
  `durable = true` flag only unlocks the COMMAND code path. No real durable replay I/O, transaction,
  contention, cleanup, or failure behavior is measured.
- Fixed already-signed requests and synchronous local callbacks isolate Node Core; request ingress,
  serialization/parsing outside the core, external policy lookup, and application handler work are
  excluded.
- CPU frequency/turbo and unrelated host activity were not controlled beyond pinning the process to
  logical CPU 2. Percentiles include harness timing overhead and possible runtime/OS jitter.
