# Owner-reply in-flight reconciliation barrier — 2026-09-03

## Problem closed

A transport timeout can occur while the N Agent is still consuming the submitted owner reply. If the client immediately asks for route-state reconciliation and that read overtakes the in-flight submit, it can receive a stale `pending` snapshot and incorrectly conclude that the reply was not consumed.

## Implemented guard

`backend/src/owner-notifications/event-serializing-private-adapter.ts` adds the runtime-facing `EventSerializingPrivateOwnerReplyAdapter`.

For each `event_id`, it serializes:

1. reply submission;
2. route-bound reconciliation.

A reconciliation call for the same event therefore waits until the earlier submission has either completed or failed. Calls for unrelated events remain independent.

This guard is transport-neutral and creates no network surface. The future authenticated private N Agent transport must call this adapter rather than bypassing it.

## Evidence

`backend/test/owner-reply-adapter-serialization.test.ts` holds workflow consumption open deliberately, starts reconciliation, proves reconciliation has not settled, releases consumption, and then verifies that the returned snapshot contains the accepted WAIT sequence and macro ID.

## Security boundary

The change adds no listener, port, route, proxy, tunnel, credential, root action, or public endpoint. Existing event, route-capability, and sender-binding checks remain authoritative in the underlying router.
