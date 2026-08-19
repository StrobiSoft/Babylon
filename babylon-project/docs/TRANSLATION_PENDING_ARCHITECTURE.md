# Translation Pending Architecture

## Purpose

`translation_pending` is the boundary between synchronous translation attempts and guaranteed eventual delivery. The status already exists in the public language contract and is already emitted by `LanguageAgent`; Stage II makes it durable, retryable and observable without turning Babylon into a central conversation archive.

## Current baseline

The Stage I language engine can return:

- `delivered`
- `delivered_after_repair`
- `delivered_via_fallback`
- `delivered_unchanged`
- `translation_pending`
- `invalid_input`

A pending result currently contains only `requestId`, `reason` and the public presentation marker. No durable pending-job lifecycle exists yet.

## Stage II design rules

1. A message accepted for processing must never disappear silently.
2. `translation_pending` is an explicit durable processing state, not an error page and not a conversation-history record.
3. The client keeps its own message copy until delivery acknowledgement is received.
4. Server-side message content may exist only as a short-lived encrypted processing job required to complete delivery.
5. Completed, expired or abandoned processing content must be deleted according to explicit lifecycle rules.
6. Retry behaviour is bounded by attempt count, operation deadline, backoff and absolute expiry.
7. The same request ID is idempotent: retrying the same accepted request must not create parallel independent jobs.
8. Public status must not expose model IDs, stack traces, internal exception text or sensitive infrastructure details.
9. Delivery acknowledgement is distinct from successful translation. A translated payload is not considered finally delivered until the recipient-delivery path acknowledges it.
10. PostgreSQL remains the durable source of truth for processing state; no in-memory queue may be the sole copy of an accepted job.

## Proposed durable job state machine

Internal states:

`pending -> processing -> ready_for_delivery -> delivered_acknowledged`

Terminal non-delivered states:

`expired`

Transient transitions:

- `pending -> processing`: a worker claims the job.
- `processing -> pending`: a retryable processing failure occurs and retry budget remains.
- `processing -> ready_for_delivery`: translation succeeds and passes independent target-language validation.
- `ready_for_delivery -> delivered_acknowledged`: recipient delivery acknowledgement arrives.
- `pending|processing|ready_for_delivery -> expired`: absolute expiry is reached before acknowledgement.

A worker crash must not strand a job permanently in `processing`; lease/claim timeout semantics must return abandoned work to retry eligibility while the absolute expiry has not passed.

## Proposed `translation_jobs` record

The first implementation should provide a dedicated table with at least:

- `request_id uuid primary key`
- authenticated sender/user ownership reference when the message API is available
- recipient/delivery target reference when the message API is available
- `state`
- public pending `reason`
- encrypted processing payload containing only the data required to retry translation/delivery
- encryption metadata/version required to decrypt that payload
- `attempt_count`
- `next_attempt_at`
- `lease_until` / claim deadline
- `expires_at`
- `created_at`
- `updated_at`
- delivery acknowledgement timestamp when completed

Indexes are required for retry scheduling (`state`, `next_attempt_at`), lease recovery and expiry cleanup.

The encrypted payload is transient processing material. It must not be queryable as conversation history and must be erased after acknowledgement or expiry.

## Encryption boundary

Plain message text must not be stored in normal columns. Retry-required content is serialized into a bounded payload and encrypted before insertion. Encryption keys must come from protected configuration/secret handling, never from the database row itself or repository source.

The first implementation may define the repository/service interfaces before final production key rotation details are added, but it must not introduce plaintext durable message storage as an interim shortcut.

## Retry policy foundation

Initial policy must be explicit and configurable:

- maximum processing attempts;
- per-attempt timeout;
- exponential or bounded backoff;
- absolute job lifetime;
- worker lease duration.

Retryable reasons include model unavailability, processing timeout and selected technical failures. Invalid input is not retryable and must never become a pending job.

Mixed/internal failure causes may still map to the public `technical_failure` reason while retaining only non-sensitive internal classification needed for scheduling/metrics.

## API boundary to implement

Stage II Item 1 should establish three logical operations even if route names evolve with the messaging API:

1. **Accept/process message** — synchronous translation is attempted. Immediate success returns a delivered-family result; otherwise a durable job is created/updated and `translation_pending` is returned.
2. **Read processing state** — an authenticated client can query the status of its own request ID without receiving another user's job or internal processing metadata.
3. **Acknowledge delivery** — once recipient delivery succeeds, acknowledgement atomically marks the job complete and removes transient encrypted content.

Later push/real-time notification can sit above this contract; polling must remain possible as a correctness fallback.

## Idempotency and concurrency

- `request_id` is the idempotency key.
- Creation uses database uniqueness rather than process-local locking.
- Worker claiming must be transactional, using row locking / skip-locked or an equivalent PostgreSQL-safe mechanism.
- Two workers must not simultaneously own the same active processing lease.
- Repeated client requests for an existing request ID return its current public state rather than duplicating work.

## Cleanup

A periodic cleanup operation must:

1. recover expired worker leases;
2. mark jobs past `expires_at` as expired;
3. erase encrypted payloads for terminal jobs;
4. delete terminal processing rows after the minimum operational retention window, unless a content-free audit/security record is explicitly required.

Cleanup logs may contain request IDs, state transitions and timings, but never message text or decrypted payloads.

## Implementation order

1. Add schemas/types for internal pending-job state and repository contracts.
2. Add PostgreSQL migration for the transient encrypted job store and indexes.
3. Implement repository operations with idempotent create/read/claim/reschedule/complete/expire semantics.
4. Add encryption adapter for the transient retry payload.
5. Add pending orchestration service around the existing `LanguageAgent`.
6. Expose authenticated API operations for accept/status/acknowledgement when the message boundary is wired.
7. Add bounded retry worker and lease recovery.
8. Add expiry/secure deletion cleanup.
9. Add unit/component tests for duplicate request IDs, worker races, crash recovery, retries, expiry and acknowledgement deletion.
10. Update OpenAPI and master-plan progress only after the complete end-to-end pending path is green.

## Stage II Item 1 completion criterion

`translation_pending` is considered implemented end-to-end when a translation that cannot complete synchronously is durably represented, survives process restart, can be queried by the owning client, cannot be duplicated by retries, and can progress into the later retry/delivery pipeline without losing the accepted message or creating permanent server-side conversation storage.
