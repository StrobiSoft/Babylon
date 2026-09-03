# N Agent private reply runtime checkpoint — 2026-09-03

## Stage goal

Close the transport-independent owner-reply slice needed by the N Agent mini client before native iOS/APNs deployment, without opening a listener, port, tunnel, reverse proxy, or adding credentials.

## Base and branch

- Base implementation: Babylon PR #46, branch `codex/notification-macro-core-v0.1`.
- Continuation branch: `noemi/n-agent-client-runtime-hardening-v0.1`.
- Stacked review: PR #47; it must not be merged independently before PR #46.

## Completed in this stage

### Canonical reply contract

The client and server use protocol/schema version `0.1` and the authoritative reply-macro pack `0.1.0`.

The wire object contains exactly these seven fields in canonical order:

1. `protocol_version`
2. `event_id`
3. `reply_macro_id`
4. `sequence`
5. `timestamp`
6. `sender_id`
7. `return_route`

Human labels, local intent names, latency, device token, client diagnostics, and macro expansion text are not wire fields.

### Client delivery state machine

- An accepted reply advances the sequence only when the acknowledged sequence exactly matches the submitted sequence.
- A deterministic rejection does not consume the sequence.
- An ambiguous delivery retains the exact pending reply and blocks later decisions.
- Route-bound reconciliation is required before allocating a higher sequence after ambiguity.
- If reconciliation proves a non-terminal WAIT was consumed, the client adopts `waiting` and may later submit a terminal decision at `lastSequence + 1`.
- If reconciliation proves the reply was not consumed, the same sequence is retried.
- Recovery is internal plumbing; no user-facing retry or reconciliation control is exposed.

### Server reconciliation seam

The private reply router exposes a bounded route-state snapshot only after exact correlation, return-route capability, and sender binding checks.

The snapshot contains only:

- workflow state;
- last accepted sequence;
- last accepted reply-macro ID;
- terminal macro ID, when present.

The local/private adapter serializes submission and reconciliation for the same event. A reconciliation request therefore cannot observe stale state while an earlier reply is still being consumed after its acknowledgement was lost.

### Test coverage

Focused tests cover:

- accepted sequence matching;
- deterministic rejection and same-sequence retry;
- ambiguous-but-consumed WAIT recovery;
- ambiguous-and-unconsumed same-sequence retry;
- blocking a second decision while recovery is unresolved;
- exact route/sender/correlation enforcement;
- failure of the workflow sink not being reported as consumed;
- reconciliation waiting behind an in-flight submission for the same event;
- strict seven-field serialization with no local diagnostic leakage.

The repository validation set for this stage is:

```text
npm run check
npm run check:test
npm run lint
npm run format:check
npx vitest run backend/test/owner-reply-reconciliation.test.ts backend/test/owner-notifications.test.ts
flutter analyze
flutter test
```

GitHub Actions remains the authoritative clean-run gate before merge.

## Security effect

- No public network surface was created.
- No Fastify route was registered.
- No socket was bound.
- No Tailscale route, firewall rule, reverse proxy, or tunnel was changed.
- No secret, APNs key, signing material, token, or production credential was added.
- Route handles remain opaque capabilities; reconciliation requires exact event, route, and sender binding.
- Human macro expansions remain outside the routing and wire layers.

## Exact remaining deployment boundary

A real phone-to-N-Agent test still requires all of the following outside this repository-only stage:

1. an authenticated private N Agent runtime transport for reply submission and route-state reconciliation;
2. durable transactional storage for event binding, accepted sequence, workflow state, and audit state;
3. native iOS packaging/signing and a real bundle identifier;
4. Apple Push Notification service credentials and device-token registration/upload;
5. deployment activation inside the existing private/Tailscale trust boundary.

Those steps require owner-provisioned credentials and/or root-side activation. They are deliberately not invented or bypassed here.

## Codex quota hold

No new Codex task is to be dispatched while the remaining seven-day quota is approximately two percent. The work in this checkpoint is a continuation from preserved GitHub artifacts and does not require a fresh Codex run.

## Next concrete step

Obtain a fully green PR #47 clean run, align the Lovable reference client with the same recovery contract, then prepare the smallest authenticated private runtime adapter and its activation runbook. Only after that gate should native APNs packaging and the first real device E2E be attempted.
