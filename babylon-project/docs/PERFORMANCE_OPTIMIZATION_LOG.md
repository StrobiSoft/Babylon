# Babylon Performance Optimization Log

This file is the canonical record for production-side performance changes measured with the Soft Chat capacity harness.

## Measurement discipline

- Change one logical variable per measurement round whenever practical.
- Order changes from the smallest expected effect to the largest expected effect so small gains remain measurable before large bottlenecks are removed.
- Keep the benchmark environment and all unrelated parameters unchanged between before/after runs.
- Record the exact before value, after value, hypothesis, expected effect, measured result, decision, and rollback point.
- Do not increase the PostgreSQL pool merely to hide avoidable application-side work.
- Preserve a known-good rollback commit/configuration after every accepted step.
- Run three repetitions for each accepted measurement round unless a failure makes the comparison invalid.

## Baseline B0 — PR #29 reconnect/steady-state measurement

Reference head: `b7ef6dd6fdbd9408922e1675cda0c014013bd5a9`

Configuration:

- mode: `independent-streaming`
- clients: 500
- PostgreSQL pool max: 20
- polling interval: 50 ms
- client ramp: 5 s
- warm-up: 2 s
- SLA: send-to-ACK p99 < 2000 ms

Measured results:

| Run | Throughput | send-to-visible p99 | visible-to-ACK p99 | send-to-ACK p99 | steady max waiting |
|---|---:|---:|---:|---:|---:|
| 1 | 87.50 msg/s | 4827.3 ms | 1238.9 ms | 5544.8 ms | 640 |
| 2 | 87.95 msg/s | 4821.2 ms | 1191.8 ms | 5521.5 ms | 636 |
| 3 | 87.67 msg/s | 4853.5 ms | 1241.1 ms | 5544.1 ms | 648 |

All three runs delivered and acknowledged 500/500 messages with zero duplicates and zero exactly-once violations. The only failure was the unchanged latency SLA.

Observed steady-state queue baseline was roughly 440 pool waiters before message delivery began. PostgreSQL was not lock-saturated, and the pool max remained 20.

## Priority order

The order below intentionally starts with the smallest expected effect.

### P1 — Rate-limit expiry maintenance in `listPending()`

Before:

- every pending-message poll called `expireDue(limit)` before the pending SELECT
- the following SELECT already excluded expired rows with `expires_at > now`

After:

- pending polling still runs at 50 ms
- `expireDue(limit)` is now allowed to run at most once per 500 ms per `MessageDeliveryService` instance
- concurrent polls share the in-flight expiry sweep instead of starting another one
- direct `status()` expiry handling remains immediate
- bulk `cleanup()` behavior remains unchanged

Implementation commits:

- production change: `71906df80c86110689dbc9e8c3314f07f3be2722`
- regression test: `d0a8a5e5233f2fbf776ef5de327d1c3b37b2286c`

Expected effect:

- small-to-moderate reduction in database writes/scans and pool acquisitions
- no change to the user-facing 50 ms polling interval
- no expected change to delivery correctness

Acceptance criteria:

- 500/500 delivery and ACK
- zero duplicates
- zero exactly-once violations
- no regression in send-to-ACK p99
- measurable reduction in pending-fetch pool pressure or query count

Rollback point:

- PR #29 head `146faf38307bd40cdeb44eb676a773db8d3d0f71` for the diagnostic branch
- B0 measurement reference `b7ef6dd6fdbd9408922e1675cda0c014013bd5a9`

Status: implemented; validation and Pepper measurement pending

### P2 — Reduce `last_used_at` write frequency

Current behavior:

- every successful authenticated request updates both `sessions.last_used_at` and `devices.last_used_at`

Planned behavior:

- preserve activity tracking
- initial target: persist activity no more than once per 30 seconds per active session/device

Expected effect:

- large reduction in repeated database writes
- reduced pool acquisition pressure
- no user-visible latency change by design

Status: planned

### P3 — Avoid repeated deterministic expiry reads

Current behavior:

- each authenticated request reloads token/session expiry and related session state from PostgreSQL

Planned behavior:

- cache deterministic expiry timestamps after validated authentication
- evaluate fixed expiry timestamps locally against the current clock
- database remains authoritative at cache creation/refresh boundaries

Expected effect:

- reduction in repeated authentication JOIN traffic

Status: planned

### P4 — Event-driven invalidation for mutable security state

Mutable state includes user status, security version, session revocation, device revocation, and refresh-family revocation.

Planned behavior:

- retain all security checks
- invalidate cached authentication state when security state changes instead of re-reading all mutable state on every poll
- define bounded fallback/TTL behavior before implementation

Expected effect:

- further reduction in authentication database traffic without weakening revocation semantics

Status: planned

### P5 — Increase user-facing poll interval from 50 ms to 500 ms

Current behavior: 50 ms.

Planned behavior: 500 ms.

This is deliberately last because it is expected to produce the largest single reduction and would make smaller improvements harder to measure afterward.

Expected mechanical effect:

- 20 polls/s/client -> 2 polls/s/client
- 90% reduction in idle poll frequency
- 500 clients: 10,000 polls/s -> 1,000 polls/s before considering the reductions from P1-P4

UX constraint:

- do not increase beyond 500 ms unless later measurements prove it necessary

Status: planned

## Round B0 -> B1 — P1 expiry sweep rate limit

- Date: 2026-08-27
- Before configuration: expiry sweep on every pending poll
- After configuration: maximum one expiry sweep per 500 ms per service instance
- User-facing poll interval: unchanged at 50 ms
- PostgreSQL pool max: unchanged at 20
- Clients: unchanged at 500
- Client ramp: unchanged at 5 s
- Warm-up: unchanged at 2 s
- Problem observed: maintenance UPDATE executed on every pending poll although the pending SELECT already filters expired rows
- Hypothesis: removing redundant expiry maintenance from nine out of ten 50 ms poll intervals will reduce pool pressure slightly without altering delivery semantics
- Expected effect: measurable but intentionally smaller than later optimization steps
- Run 1: pending
- Run 2: pending
- Run 3: pending
- Before/after delta: pending
- Side effects: pending
- Decision: pending measurement
- Rollback: revert P1 commits or reset to PR #29 diagnostic head
- Next step: do not start P2 until B1 is measured and evaluated

## Round template

For every completed round append a section using this structure:

### Bx -> By — <change name>

- Date:
- Before commit/configuration:
- After commit/configuration:
- Exact change: `<before>` -> `<after>`
- Problem observed:
- Hypothesis:
- Expected effect:
- Constants held unchanged:
- Run 1:
- Run 2:
- Run 3:
- Before/after delta:
- Side effects:
- Decision: keep / revise / rollback
- Rollback commit/configuration:
- Next step:
