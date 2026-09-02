# Owner notification reference client v0.1

This is the Lovable handoff for the isolated notification decision slice. It is a reusable test/reference client, not a production Babylon route, production screen, or push implementation.

## Paths

- Portable macro core: `backend/src/notification-macros/`
- Endpoint delivery adapter: `backend/src/owner-notifications/delivery.ts`
- Reply model and transport contract: `backend/src/owner-notifications/protocol.ts`
- Local test receiver/transport: `backend/src/owner-notifications/test-receiver.ts`
- Server contract tests and event-to-reply fixture: `backend/test/owner-notifications.test.ts`
- Flutter wire/domain model: `client/lib/src/owner_notification.dart`
- Flutter transport interface/local transport: `client/lib/src/owner_reply_transport.dart`
- Flutter state machine: `client/lib/src/owner_notification_controller.dart`
- Disposable UI shell: `client/lib/src/owner_notification_test_shell.dart`
- Flutter model/widget/E2E tests: `client/test/owner_notification_test.dart`
- Machine-readable reply schema: `docs/schemas/owner-decision-reply-v0.1.schema.json`

The shell is deliberately not imported by `client/lib/main.dart`; the receiver is deliberately not registered in `backend/src/server.ts`. Production runtime behavior is unchanged.

## Delivery and rendering

The delivery object has two siblings:

1. `notification`: the unchanged portable macro-core message containing opaque macro IDs/versions and optional text fragments.
2. `expansions`: endpoint-provided `{id, version, text}` records required by that message.

The Flutter model joins expansions to macros by `id@version`. It fails closed if an expansion is missing or duplicated. Expansion text is not added to the portable macro-core transport or catalog.

## Reply schema

Canonical key order is `protocol_version`, `event_id`, `decision`, `timestamp`, `sequence`, then optional `comment`.

```json
{
  "protocol_version": "0.1",
  "event_id": "10000000-0000-4000-8000-000000000001",
  "decision": "WAIT",
  "timestamp": "2026-09-03T00:01:00.000Z",
  "sequence": 0,
  "comment": "Optional later conditional-approval context."
}
```

`sequence` is monotonic per event. The receiver rejects a sequence less than or equal to the last accepted sequence. This permits `WAIT` at sequence 0 followed by `APPROVE` or `REJECT` at sequence 1. Comments are optional, visible NFC text bounded to 280 Unicode code points and 1,024 UTF-8 bytes; controls and bidirectional formatting controls are rejected.

## UI and workflow states

| State      | Display                          | Allowed meaning                                                                       |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `pending`  | `DECISION REQUIRED`              | No owner signal accepted yet.                                                         |
| `waiting`  | `WAITING · ACKNOWLEDGED / LÁTVA` | Owner saw the event; workflow pauses and may later accept a higher-sequence decision. |
| `approved` | `APPROVED · TERMINAL`            | Terminal approval signal.                                                             |
| `rejected` | `REJECTED · TERMINAL`            | Terminal rejection signal.                                                            |

The three 60-point-high buttons are `APPROVE · OK · MEHET`, `REJECT · SEMMIKÉPP`, and `WAIT · KÉRLEK VÁRJ`. A reply only changes decision state. Push receipt and button taps must never directly invoke privileged work; the authenticated workflow service must separately consume the accepted signal according to its authorization and state-machine rules.

## Real iOS work Lovable must implement

1. Request notification permission with a clear user-triggered explanation and handle denied/provisional states.
2. Register with APNs using native iOS lifecycle APIs after permission handling.
3. Capture APNs device-token rotations and upload the current token through an authenticated, purpose-bound Babylon API.
4. Receive push payloads and decode the portable notification plus endpoint expansion data without treating receipt as authorization.
5. Present the same three large owner decisions in foreground, background notification actions, and the opened-app flow.
6. Send the exact reply schema through an `OwnerReplyTransport` implementation. Persist sequence allocation; after ambiguous delivery, reconcile accepted server state before allocating a new higher sequence instead of turning a retry into a second semantic decision.
7. Render `WAIT` as acknowledged/paused and retain a path to a later higher-sequence `APPROVE` or `REJECT`.

Do not represent APNs with UI-only fake registration. Real iOS work is blocked until Babylon defines the authenticated device-token upload/rotation API, push authentication and payload contract, and server-side durable transactional reply consumption. No such product/security contract or credential is introduced by this reference slice.
