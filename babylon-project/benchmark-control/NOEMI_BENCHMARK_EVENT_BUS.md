# Noemi Benchmark Event Bus

This file exists only to anchor a long-lived pull request used as a lightweight event bus between the CT105 Noemi Bridge and ChatGPT Work.

Protocol v1:
- the pull request remains open;
- the Bridge posts a top-level PR comment only when an approved benchmark/reporting workflow reaches a new externally relevant state;
- event comment prefix: `NOEMI-BENCH-EVENT v1`;
- event kinds are informational only, for example `BENCHMARK_READY`, `BENCHMARK_FAILED`, or `SUMMARY_READY`;
- the event carries only minimal routing metadata (task/run id and where the durable result can be fetched);
- no benchmark semantics, parameter changes, code changes, test progression, promotion, or optimization decision may be performed by the Bridge;
- ChatGPT/Noemi retrieves the durable result after the event and discusses any next step with Zoltan before a new experimental direction is started.

This PR is infrastructure, not a product change, and is intentionally not meant to be merged while it serves as the event bus.
