# Owner notification reference client v0.1

This is the Lovable handoff for the isolated notification decision slice. It is a reusable test/reference client, not a production Babylon route, production screen, or push implementation.

## Paths

- Portable macro core: `backend/src/notification-macros/`
- Portable reply macro pack: `backend/src/reply-macros/`
- Endpoint delivery adapter: `backend/src/owner-notifications/delivery.ts`
- Reply model and transport contract: `backend/src/owner-notifications/protocol.ts`
- Private router: `backend/src/owner-notifications/reply-router.ts`
- Local private adapter/transport: `backend/src/owner-notifications/private-test-adapter.ts`
- Server contract tests and event-to-reply fixture: `backend/test/owner-notifications.test.ts`
- Flutter wire/domain model: `client/lib/src/owner_notification.dart`
- Flutter transport interface/local transport: `client/lib/src/owner_reply_transport.dart`
- Flutter state machine: `client/lib/src/owner_notification_controller.dart`
- Disposable UI shell: `client/lib/src/owner_notification_test_shell.dart`
- Flutter model/widget/E2E tests: `client/test/owner_notification_test.dart`
- Machine-readable reply schema: `docs/schemas/owner-decision-reply-v0.1.schema.json`
- Machine-readable reply pack: `docs/artifacts/owner-reply-macro-pack-v0.1.json`
- Private bridge contract and deployment boundary: `docs/OWNER_REPLY_BRIDGE.md`

The shell is deliberately not imported by `client/lib/main.dart`; the private adapter/router is deliberately not registered in `backend/src/server.ts`. Production runtime behavior is unchanged.

## Delivery and rendering

The delivery object has three siblings:

1. `notification`: the unchanged portable macro-core message containing opaque macro IDs/versions and optional text fragments.
2. `expansions`: endpoint-provided `{id, version, text}` records required by that message.
3. `reply_context`: the opaque `return_route` to echo in a reply.

The Flutter model joins expansions to macros by `id@version`. It fails closed if an expansion is missing or duplicated. Expansion text is not added to the portable macro-core transport or catalog.

## Reply schema

Canonical key order is `protocol_version`, `event_id`, `reply_macro_id`, `sequence`, `timestamp`, `sender_id`, then `return_route`.

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

`sequence` is monotonic per event. The router rejects a sequence less than or equal to the last accepted sequence. This permits the non-terminal wait macro at sequence 0 followed by either terminal macro at sequence 1. Literal decision words, comments, and endpoint expansion text are not part of the reply protocol. See [`OWNER_REPLY_BRIDGE.md`](OWNER_REPLY_BRIDGE.md) for canonical IDs, field constraints, rejection order, and deployment prerequisites.

## UI and workflow states

| State      | Display                          | Allowed meaning                                                                       |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `pending`  | `DECISION REQUIRED`              | No owner signal accepted yet.                                                         |
| `waiting`  | `WAITING · ACKNOWLEDGED / LÁTVA` | Owner saw the event; workflow pauses and may later accept a higher-sequence decision. |
| `approved` | `APPROVED · TERMINAL`            | Terminal approval signal.                                                             |
| `rejected` | `REJECTED · TERMINAL`            | Terminal rejection signal.                                                            |

The three 60-point-high buttons are `OK · MEHET`, `SEMMIKÉPP`, and `KÉRLEK, VÁRJ`. Those labels are trusted-client presentation only; the transport sends their opaque reply macro IDs. A reply only changes decision state. Push receipt and button taps must never directly invoke privileged work; the authenticated workflow service must separately consume the accepted signal according to its authorization and state-machine rules.

## Real iOS work Lovable must implement

1. Request notification permission with a clear user-triggered explanation and handle denied/provisional states.
2. Register with APNs using native iOS lifecycle APIs after permission handling.
3. Capture APNs device-token rotations and upload the current token through an authenticated, purpose-bound Babylon API.
4. Receive push payloads and decode the portable notification plus endpoint expansion data without treating receipt as authorization.
5. Present the same three large owner decisions in foreground, background notification actions, and the opened-app flow.
6. Send the exact IDs-only reply schema through an `OwnerReplyTransport` implementation, using the installation handle and echoed return route. Persist sequence allocation; after ambiguous delivery, reconcile accepted server state before allocating a new higher sequence instead of turning a retry into a second semantic decision.
7. Render the wait reply as acknowledged/paused and retain a path to a later higher-sequence terminal reply.

Do not represent APNs with UI-only fake registration. Real iOS work is blocked until Babylon defines the authenticated device-token upload/rotation API and push authentication/payload contract, and the existing private N Agent deployment binds the provided adapter to durable transactional route/replay state and an authenticated private client connection. No credential or new listener is introduced by this reference slice.
