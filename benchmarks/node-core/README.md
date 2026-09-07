# NODE IJET Node Core microbenchmark

This is an isolated, transport-neutral microbenchmark harness for Node Core. It opens no listener
or socket and does not connect to Bridge, NOEMI, CT105, VM103, or any deployment surface.

The harness imports the compiled product code from `babylon-project/node-core/dist`. It must be run
from a clean checkout whose target product tree is the requested commit. The runner refuses to
start if `babylon-project/node-core` differs from `TARGET_SHA`.

## Important replay-store limitation

`BenchmarkReplayStore` in `benchmark.mjs` is a **benchmark-only, non-production stub**. Its
`durable = true` setting exists only to exercise the Node Core COMMAND path. It performs no I/O,
does not persist claims, and must never be used as a production durable replay implementation.
The fresh and duplicate outcomes are selected in advance to isolate the requested code paths.

## Run

Requires Node.js 24 and dependencies installed from the repository lockfile.

```sh
cd babylon-project
npm ci --ignore-scripts
npm run test:node-core
npm run check
npm run build
cd ..
taskset -c 2 node benchmarks/node-core/benchmark.mjs \
  --target 76ad3817faad24b6425668f9bb4fe9e4d3dac1d5 \
  --runs 5 --warmup-ms 1500 --throughput-ms 2500 --samples 20000 \
  --output benchmarks/node-core/results/raw.json
```

Each measured run is a fresh Node.js child process and has its own warmup. Throughput is measured
in an uninstrumented timed loop. Latency is then sampled separately with `process.hrtime.bigint()`;
percentiles use nearest-rank selection. Reported scenario percentiles are the median of the five
run-level percentiles. Run-to-run spread is the min/max throughput and full relative range
`(max - min) / mean`.

The two `harness_*_overhead` controls estimate loop/call/timer overhead for synchronous and async
operations. Scenario results are raw and are not adjusted by subtracting these controls.

This is a single-thread, sequential, warm-cache microbenchmark. It does not measure a durable
database, transport, contention, queueing, deployment behavior, or production end-to-end latency.
