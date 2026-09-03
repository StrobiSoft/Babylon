# Owner reply client recovery contract

## Scope

This document records the client-side continuation of the private N Agent owner-reply bridge in
PR #46. It adds no listener, route, port, tunnel, reverse proxy, credential, APNs secret, or
production deployment.

## Why reconciliation is required

A reply can reach the N Agent router and be committed while the acknowledgement is lost on the way
back to the client. In that case the client cannot safely assume either success or failure:

- allocating a higher sequence may overtake an accepted-but-unacknowledged reply;
- blindly resending the same sequence may receive `REPLAYED_SEQUENCE`, which proves that the peer
  has already consumed at least that sequence but does not by itself reconstruct the accepted
  workflow state.

The client therefore treats timeout, connection loss, and an acknowledgement naming the wrong
sequence as an **ambiguous** result and freezes the binding until it has reconciled with the
server-authoritative route state.

## Transport outcomes

`client/lib/src/owner_reply_transport.dart` defines three explicit outcomes:

- `accepted`: includes the exact accepted sequence. The controller advances only when it matches the
  sequence that was sent.
- `rejected`: includes a deterministic error code. The sequence is not consumed and may be reused
  after the cause is corrected.
- `ambiguous`: the peer result is unknown. The pending reply and sequence remain reserved and no
  later decision is permitted for that binding.

A mismatched accepted-sequence acknowledgement is converted to the same ambiguous state rather than
being treated as a harmless client error. This preserves the pending reply so reconciliation can
prove whether the server consumed it.

## Private adapter response contracts

The private adapter returns an explicit successful acknowledgement with exactly these fields:

- `accepted_sequence`: the exact sequence consumed by the workflow sink;
- `state`: `waiting`, `approved`, or `rejected`;
- `terminal`: whether the accepted reply resolved the decision.

The strict machine-readable contract is
[`docs/schemas/owner-reply-acceptance-v0.1.schema.json`](schemas/owner-reply-acceptance-v0.1.schema.json).
A client must treat a missing, malformed, out-of-range, or mismatched `accepted_sequence` as
ambiguous, never as success.

The route-state reconciliation response contains only:

- `workflow`: `pending`, `waiting`, `approved`, or `rejected`;
- `last_accepted_sequence`: the highest accepted sequence or `null`;
- `last_accepted_reply_macro_id`: its canonical reply-macro ID or `null`.

Its strict contract is
[`docs/schemas/owner-reply-reconciliation-v0.1.schema.json`](schemas/owner-reply-reconciliation-v0.1.schema.json).
The private adapter deliberately omits the router's internal terminal marker and all audit,
expansion, prompt, result, route-owner, and transport metadata.

## Reconciliation snapshot

`OwnerReplyTransport.reconcile` returns only the route-bound metadata needed for recovery:

- remote workflow state: `pending`, `waiting`, `approved`, or `rejected`;
- highest accepted sequence, if any;
- the last accepted reply macro ID, if any.

`OwnerNotificationController.reconcilePendingReply()` is an automatic runtime operation, not a
user-facing retry button. After connectivity is restored:

1. If the remote snapshot proves that the pending macro and sequence were consumed, the controller
   adopts the remote workflow state and advances to `lastSequence + 1`.
2. If the snapshot proves the pending sequence was not consumed, the controller clears the
   ambiguity and makes the same sequence available for a safe retry.
3. Until either condition is established, no higher sequence or second decision may be sent.

On the server side, `OwnerReplyRouter.reconcile()` joins the same per-event serialization queue as
reply delivery. Therefore a reconciliation read cannot overtake an in-flight workflow-sink commit
and incorrectly report that the pending reply was not consumed.

## Covered cases

`client/test/owner_notification_test.dart` covers:

- accepted approve/reject/wait replies;
- `WAIT` remaining non-terminal and a later terminal reply using the next sequence;
- deterministic rejection reusing the same sequence;
- ambiguous delivery that the server did consume, followed by reconciliation and sequence advance;
- ambiguous delivery that the server did not consume, followed by retry of the same sequence;
- visible handling of transport failure in the Flutter reference shell.

`client/test/owner_reply_ack_mismatch_test.dart` additionally covers both outcomes after a mismatched
acknowledgement: a server-proven unconsumed reply is retried at the same sequence, while a
server-proven consumed `WAIT` is adopted before a later terminal reply uses the next sequence.

`backend/test/owner-reply-reconciliation.test.ts` covers route/sender/capability binding, persisted
last reply-macro metadata, explicit acceptance, bounded reconciliation, workflow-sink failure, and
the ordering guarantee that a reconciliation read waits for an in-flight delivery to settle.

`backend/test/owner-reply-response-schemas.test.ts` pins both response field sets, rejects extra
properties through the schemas, and keeps the reconciliation macro IDs aligned with the canonical
reply pack.

## Remaining runtime dependency

The private N Agent runtime still needs a durable authenticated implementation of:

- reply submission into `OwnerReplyRouter`;
- route registration and transactional persistence of state/sequence/audit;
- the reconciliation snapshot operation above;
- an authenticated client identity bound to the allowed installation handle.

That runtime integration is the next real E2E boundary. It must stay inside the existing private
trust boundary and must not be hidden behind a mock or exposed through a public listener.
