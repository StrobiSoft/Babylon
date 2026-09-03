# Private owner-reply bridge v0.1

## Boundary and status

This slice is the server-side N Agent routing core and an exact local/private adapter seam. It does
not register a route in the Babylon Fastify server, bind a socket, expose an Internet listener,
configure a reverse proxy or tunnel, send push notifications, or publish Babylon. The executable
end-to-end harness is in `backend/test/owner-notifications.test.ts`:

`serialized mini-client reply -> LocalPrivateOwnerReplyAdapter -> OwnerReplyRouter -> OwnerWorkflowSink`

`OwnerWorkflowSink` and route registration are the deployment abstractions. The N Agent runtime
registers an event correlation ID, a random opaque return-route handle, the allowed installation
handle(s), and its sink. The router compares those values byte-for-byte; it does not encode or infer
whether the workflow owner is Noemi, Codex, or another actor.

## Reply macro pack

The router imports only [`backend/src/reply-macros/catalog.ts`](../backend/src/reply-macros/catalog.ts),
which contains opaque IDs and lifecycle effects. Human endpoint labels are isolated in
`backend/src/reply-macros/expansions.ts` and the client artifact. They are not imported by the
protocol, adapter, router, or default reply-pack entry point.

| Opaque reply macro ID        | Trusted-client presentation | Workflow behavior                     |
| ---------------------------- | --------------------------- | ------------------------------------- |
| `01K4J8Q2N6C9R5T3V7W0X1YBZA` | OK / mehet                  | terminal confirmation                 |
| `01K4J9R3P7D0S6V2W8X1Y5ZBCA` | Semmiképp                   | terminal rejection                    |
| `01K4JAT4Q8E1R7W3X9Y2Z6ABCD` | Kérlek, várj                | non-terminal pause; later reply valid |

The machine-readable endpoint pack is
[`docs/artifacts/owner-reply-macro-pack-v0.1.json`](artifacts/owner-reply-macro-pack-v0.1.json).
Changing a macro's behavior requires a new ID. Wording/localization changes stay in versioned,
trusted endpoint data and never change the wire value.

## Exact client wire contract

The normative JSON Schema is
[`docs/schemas/owner-decision-reply-v0.1.schema.json`](schemas/owner-decision-reply-v0.1.schema.json).
Canonical serialization uses this exact key order:

1. `protocol_version`: exactly `0.1`; this is both wire protocol and schema version.
2. `event_id`: UUID correlation ID from the originating decision request.
3. `reply_macro_id`: exactly one canonical 26-character ID in the v0.1 pack.
4. `sequence`: integer `0..2147483647`, strictly increasing for the registered event.
5. `timestamp`: offset-aware RFC 3339 timestamp.
6. `sender_id`: 16–128 characters, `[A-Za-z0-9_-]`; opaque installation/client handle.
7. `return_route`: 16–128 characters, `[A-Za-z0-9_-]`; opaque request-owner route handle.

No other fields are accepted. In particular, literal decision words and human expansion text are
not protocol fields.

```json
{
  "protocol_version": "0.1",
  "event_id": "10000000-0000-4000-8000-000000000001",
  "reply_macro_id": "01K4JAT4Q8E1R7W3X9Y2Z6ABCD",
  "sequence": 0,
  "timestamp": "2026-09-03T00:01:00.000Z",
  "sender_id": "install_7V3W9X2Y6Z8A4BCD",
  "return_route": "route_8R4T2V6W9X3Y7ZAB"
}
```

After ambiguous delivery, the client must reconcile accepted state before allocating a higher
sequence. Retrying the identical sequence is a replay and is rejected deterministically.

## State and rejection rules

The wait macro moves `pending` or `waiting` to `waiting`; it never resolves the decision. Either
terminal macro moves the request to its respective terminal state. A later opposite terminal macro
is `TERMINAL_DECISION_CONFLICT`; any other higher-sequence reply after termination is
`EVENT_TERMINAL`.

Validation order is stable: envelope/version, known reply ID, registered correlation, exact route
handle, allowed sender, monotonic sequence, then terminal state. Other deterministic codes are
`INVALID_ENVELOPE`, `UNKNOWN_REPLY_MACRO_ID`, `UNKNOWN_CORRELATION`,
`ROUTE_HANDLE_MISMATCH`, `SENDER_MISMATCH`, `REPLAYED_SEQUENCE`, and `DELIVERY_FAILED`.

Audit entries contain available protocol/event/reply IDs, sequence, client/observed timestamps,
sender ID, SHA-256 route and canonical payload hashes, delivery state, and rejection code. They do
not contain endpoint expansion text or route-handle plaintext. Deployment must still supply access
control, retention, durable state, and any keyed hashing required by its threat model.

## Remaining private deployment prerequisite

Before native iOS/APNs E2E, the existing private/Tailscale N Agent deployment must implement this
adapter and sink with authenticated client identity, cryptographically random return-route handles,
and durable transactional storage for route binding, sequence, terminal state, audit, and sink
consumption. That is the exact point at which transport authentication and deployment credentials
must be selected inside the existing trust boundary. This change deliberately does not invent that
credential mechanism or open a listener.

Native iOS additionally needs the already-recorded authenticated APNs device-token upload/rotation
API, push authentication and payload delivery. The smallest next E2E step is to deploy the private
adapter above, register one isolated test event/installation/route tuple, deliver that tuple in the
test push payload, and submit each canonical reply from the iOS client through the authenticated
private connection to a durable test sink.
