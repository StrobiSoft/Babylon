# Babylon Performance Optimization Log

This is the canonical record for production-side performance changes measured with the Soft Chat capacity harness.

## Measurement discipline

- Change one logical variable per measurement round whenever practical.
- Order changes from the smallest expected effect to the largest expected effect.
- Keep the benchmark environment and unrelated parameters unchanged between before/after runs.
- Record the exact before value, after value, hypothesis, expected effect, measured result, decision, and rollback point.
- Do not increase the PostgreSQL pool merely to hide avoidable application-side work.
- Preserve a known-good rollback commit and configuration after every accepted step.
- Run three repetitions for each accepted measurement round unless a failure makes the comparison invalid.

## Baseline B0 — PR #29

Reference measurement head: `b7ef6dd6fdbd9408922e1675cda0c014013bd5a9`

Configuration:

- Mode: `independent-streaming`
- Clients: 500
- PostgreSQL pool max: 20
- Polling interval: 50 ms
- Client ramp: 5 s
- Warm-up: 2 s
- SLA: send-to-ACK p99 below 2000 ms

Run 1:

- Throughput: 87.50 msg/s
- send-to-visible p99: 4827.3 ms
- visible-to-ACK p99: 1238.9 ms
- send-to-ACK p99: 5544.8 ms
- Steady max waiting: 640

Run 2:

- Throughput: 87.95 msg/s
- send-to-visible p99: 4821.2 ms
- visible-to-ACK p99: 1191.8 ms
- send-to-ACK p99: 5521.5 ms
- Steady max waiting: 636

Run 3:

- Throughput: 87.67 msg/s
- send-to-visible p99: 4853.5 ms
- visible-to-ACK p99: 1241.1 ms
- send-to-ACK p99: 5544.1 ms
- Steady max waiting: 648

All three runs delivered and acknowledged 500/500 messages with zero duplicates and zero exactly-once violations. The only failure was the unchanged latency SLA. The steady-state queue baseline was roughly 440 pool waiters before message delivery began. PostgreSQL was not lock-saturated and the pool max remained 20.

## Priority order

The order intentionally starts with the smallest expected effect.

### P1 — Rate-limit expiry maintenance in `listPending()`

Before:

- Every pending-message poll called `expireDue(limit)` before the pending SELECT.
- The following SELECT already excluded expired rows with `expires_at > now`.

After:

- User-facing pending polling remains 50 ms.
- `expireDue(limit)` can run at most once per 500 ms per `MessageDeliveryService` instance.
- Concurrent polls share an in-flight expiry sweep instead of starting another one.
- Direct `status()` expiry handling remains immediate.
- Bulk `cleanup()` behavior remains unchanged.

Implementation commits:

- Production change: `71906df80c86110689dbc9e8c3314f07f3be2722`
- Regression test: `d0a8a5e5233f2fbf776ef5de327d1c3b37b2286c`

Expected effect:

- Small-to-moderate reduction in database writes, scans, and pool acquisitions.
- No change to the user-facing 50 ms polling interval.
- No change to delivery correctness.

Acceptance criteria:

- 500/500 delivery and ACK.
- Zero duplicates.
- Zero exactly-once violations.
- No regression in send-to-ACK p99.
- Measurable reduction in pending-fetch pool pressure or query count.

Rollback points:

- Diagnostic branch head before the production change: `146faf38307bd40cdeb44eb676a773db8d3d0f71`.
- B0 measurement reference: `b7ef6dd6fdbd9408922e1675cda0c014013bd5a9`.

Status: implemented; validation and Pepper measurement pending.

### P2 — Reduce `last_used_at` write frequency

Before: every successful authenticated request updates both `sessions.last_used_at` and `devices.last_used_at`.

Planned change: preserve activity tracking while persisting activity no more than once per 30 seconds per active session/device.

Expected effect: large reduction in repeated database writes and reduced pool acquisition pressure without a user-visible latency change.

Status: planned.

### P3 — Avoid repeated deterministic expiry reads

Before: each authenticated request reloads token/session expiry and related session state from PostgreSQL.

Planned change: cache deterministic expiry timestamps after validated authentication and evaluate fixed expiry timestamps locally against the current clock. PostgreSQL remains authoritative at cache creation and refresh boundaries.

Expected effect: reduction in repeated authentication JOIN traffic.

Status: planned.

### P4 — Event-driven invalidation for mutable security state

Mutable state includes user status, security version, session revocation, device revocation, and refresh-family revocation.

Planned change: retain all security checks while invalidating cached authentication state when security state changes instead of re-reading all mutable state on every poll. A bounded fallback/TTL must be defined before implementation.

Expected effect: further reduction in authentication database traffic without weakening revocation semantics.

Status: planned.

### P5 — Increase user-facing poll interval from 50 ms to 500 ms

Before: 50 ms.

Planned change: 500 ms.

This is deliberately last because it is expected to produce the largest single reduction and would make smaller improvements harder to measure afterward.

Expected mechanical effect:

- 20 polls/s/client becomes 2 polls/s/client.
- Idle poll frequency falls by 90%.
- At 500 clients, 10,000 polls/s becomes 1,000 polls/s before considering P1-P4 improvements.

UX constraint: do not increase beyond 500 ms unless later measurements prove it necessary.

Status: planned.

## Round B0 -> B1 — P1 expiry sweep rate limit

- Date: 2026-08-27
- Before: expiry sweep on every pending poll
- After: maximum one expiry sweep per 500 ms per service instance
- User-facing poll interval: unchanged at 50 ms
- PostgreSQL pool max: unchanged at 20
- Clients: unchanged at 500
- Client ramp: unchanged at 5 s
- Warm-up: unchanged at 2 s
- Problem: maintenance UPDATE executed on every pending poll although the pending SELECT already filters expired rows
- Hypothesis: removing redundant expiry maintenance from nine out of ten 50 ms poll intervals will reduce pool pressure slightly without altering delivery semantics
- Expected effect: measurable but intentionally smaller than later optimization steps
- Run 1: pending
- Run 2: pending
- Run 3: pending
- Before/after delta: pending
- Side effects: pending
- Decision: pending measurement
- Rollback: revert P1 commits or reset to the PR #29 diagnostic head
- Next step: do not start P2 until B1 is measured and evaluated

## Round template

For every completed round record:

- Date
- Before commit/configuration
- After commit/configuration
- Exact before -> after change
- Problem observed
- Hypothesis
- Expected effect
- Constants held unchanged
- Run 1
- Run 2
- Run 3
- Before/after delta
- Side effects
- Decision: keep, revise, or rollback
- Rollback commit/configuration
- Next step
