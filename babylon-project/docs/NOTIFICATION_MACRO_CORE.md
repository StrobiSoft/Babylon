# Notification macro core v0.1

## Purpose and boundary

The notification macro core is a small, provider-neutral language for concise operational notifications. It lets N Agent and Babylon reuse the same stable identifiers while endpoints choose when and how to display human text. This version contains no phone mini-app, credentials, provider SDK, push provider, network sender, or delivery implementation.

The initial vocabulary is intentionally useful but incomplete. Adding a meaning requires a new opaque ID; changing an existing ID's meaning is forbidden. Any future wording change must be explicit and versioned rather than silently changing an installed expansion.

Opaque identifiers minimize incidental information exposed to a router or observer, but they are not encryption, cryptographic secrecy, access control, or authorization. Traffic analysis and a known codebook can still reveal meaning.

## Repository layout and groups

The canonical groups are directories beneath `backend/src/notification-macros/`:

- `attention`: how strongly the endpoint should call attention to the message;
- `status`: current, terminal, or decision state;
- `reason`: the explicit reason for a terminal or decision state.

Each group has a `catalog.ts` containing stable ID, version, canonical name, audience, relevant severity/priority, and deprecation state. Status entries also declare whether they are progress, terminal, or decision states. Each separate `expansions.ts` contains human text. Free text is an optional bounded fragment, not a fourth macro group.

`catalog.ts`, `transport.ts`, and `assembler.ts` do not import expansion tables. A router or observer can therefore validate and carry IDs without receiving the human expansion text. Only an endpoint that imports `expansion.ts` needs the expansion tables.

## Initial v0.1 vocabulary

| Group     | Canonical names                                                                                                            | Purpose                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| attention | `please_note`, `action_needed`, `urgent_attention`                                                                         | Normal, high, and urgent attention                  |
| status    | `work_started`, `work_completed`, `work_blocked`, `decision_required`, `work_failed`                                       | One progress status plus terminal/decision statuses |
| reason    | `requested_work_finished`, `more_information_required`, `dependency_unavailable`, `validation_failed`, `approval_required` | Small explicit reason set                           |

The catalog is authoritative for group membership and supported versions. All v0.1 entries currently use macro version `0.1.0` and are non-deprecated.

## Fragment contract

The portable JSON Schema is [`schemas/notification-macro-fragment-v0.1.schema.json`](schemas/notification-macro-fragment-v0.1.schema.json). The TypeScript runtime validator adds checks that JSON Schema cannot express compactly: fragment index below total, replay message ID different from current message ID, NFC normalization, a 1,024-byte UTF-8 limit, and disallowed control characters.

Every fragment repeats immutable message metadata:

- `protocolVersion`: exactly `0.1`;
- `eventId`: UUID for the event that caused the notification;
- `messageId`: UUID for this message attempt;
- `createdAt`: offset-aware RFC 3339 timestamp;
- `sequence.message`: non-negative ordering number within the event stream;
- `sequence.fragment` and `totalFragments`: zero-based fragment position and declared total (2–4);
- `replay.attempt`: zero for an original message, positive for a replay;
- `replay.originalMessageId`: absent at attempt zero and required for a replay;
- `fragment`: one macro reference or one optional-text value.

Optional text must contain 1–280 Unicode code points, occupy no more than 1,024 UTF-8 bytes, be NFC-normalized, and contain no C0/C1 controls other than tab, line feed, or carriage return. It is never synthesized.

## Assembly and rejection rules

Fragments may arrive in any order. The assembler waits until every declared fragment index is present, then emits exactly:

`ATTENTION -> STATUS -> REASON -> OPTIONAL_TEXT`

Exactly one attention and one status macro are required. At most one macro from each group and at most one optional-text fragment are allowed. A non-terminal progress status may omit reason; terminal (`work_completed`, `work_blocked`, `work_failed`) and decision (`decision_required`) statuses require a caller-supplied reason. The assembler never guesses a missing reason or adds free text.

An exact retransmission at the same fragment sequence is idempotent and reports `duplicate`. A different payload at an occupied sequence, or a second value for the same group/text slot, is an incompatible duplicate. All fragments must agree on IDs, timestamp, message sequence, declared count, and replay metadata.

The assembler rejects malformed envelopes/versions, unknown macro IDs, wrong group claims, unsupported macro versions, deprecated macros, invalid or oversized free text, incompatible duplicates, missing fragment indices, missing attention/status, and terminal or decision messages without a reason.

## IDs-only wire example

The following three complete fragment envelopes form one IDs-only message. Transport may deliver them in any order; their fragment indices describe transport completeness, not display order:

```json
[
  {
    "protocolVersion": "0.1",
    "eventId": "10000000-0000-4000-8000-000000000001",
    "messageId": "20000000-0000-4000-8000-000000000002",
    "createdAt": "2026-09-03T00:00:00.000Z",
    "sequence": { "message": 17, "fragment": 0, "totalFragments": 3 },
    "replay": { "attempt": 0 },
    "fragment": {
      "kind": "macro",
      "group": "reason",
      "macroId": "01JQ803C6N9M2K5D8F4H0R1BVA",
      "macroVersion": "0.1.0"
    }
  },
  {
    "protocolVersion": "0.1",
    "eventId": "10000000-0000-4000-8000-000000000001",
    "messageId": "20000000-0000-4000-8000-000000000002",
    "createdAt": "2026-09-03T00:00:00.000Z",
    "sequence": { "message": 17, "fragment": 1, "totalFragments": 3 },
    "replay": { "attempt": 0 },
    "fragment": {
      "kind": "macro",
      "group": "attention",
      "macroId": "01JQ7S4C8N2W6K9D3F5H0M1PXT",
      "macroVersion": "0.1.0"
    }
  },
  {
    "protocolVersion": "0.1",
    "eventId": "10000000-0000-4000-8000-000000000001",
    "messageId": "20000000-0000-4000-8000-000000000002",
    "createdAt": "2026-09-03T00:00:00.000Z",
    "sequence": { "message": 17, "fragment": 2, "totalFragments": 3 },
    "replay": { "attempt": 0 },
    "fragment": {
      "kind": "macro",
      "group": "status",
      "macroId": "01JQ7W5N2C8M4K9D6F3H0R1BVA",
      "macroVersion": "0.1.0"
    }
  }
]
```

The assembled IDs-only representation preserves message metadata and reorders `fragments` canonically.

## Endpoint expansion example

An endpoint with the English v0.1 tables expands that message to:

> Action needed. Work is complete. The requested work finished.

Expansion occurs only after validation and canonical assembly. A transport component must not expand or log this text.

## Logging and privacy model

Operational logs should record only protocol version, event ID, message ID, message/fragment sequence, replay attempt/original ID, macro IDs and versions, timestamps, and delivery state such as accepted, duplicate, queued, delivered, or failed. If optional text must be correlated, log a keyed or unkeyed payload hash chosen by the deployment threat model and byte length; do not log the payload itself. Do not log canonical names or expanded text.

Logs still require retention limits and access control. An optional payload hash may permit guessing when payloads have low entropy, so it is correlation metadata rather than anonymization.

## Reuse and next boundary

N Agent can produce or consume the same IDs as Babylon without linking to provider code. Babylon can embed the runtime validator and assembler now, while a future disposable phone E2E client needs only: load the v0.1 expansion tables, accept a locally supplied IDs-only fixture, expand it on-device, display it, and report a local acknowledgement. Provider registration, remote push, credentials, background delivery, and production persistence remain outside that smallest next task.
