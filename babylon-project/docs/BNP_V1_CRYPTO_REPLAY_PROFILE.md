# BNP v1 Cryptographic and Replay Profile

Status: NORMATIVE BNP/1 profile; deployment time values remain open

This document defines the owner-approved BNP/1 cryptographic and replay invariants. Concrete
default/max TTL, clock-skew values, registry persistence, command-table negotiation, and production
replay-store technology remain open and are identified explicitly rather than invented here.

## 1. Goals

The v1 profile must provide:

- proof of possession of an enrolled node private key;
- deterministic cross-language signing and verification;
- explicit protocol-domain separation;
- sender, recipient, version, message kind, message identity, time bounds, body, and signing-key binding;
- replay resistance that remains safe under transport retries;
- key rotation and emergency revocation without changing logical `node_id`;
- no negotiation surface that allows an untrusted peer to downgrade the algorithm.

The profile should stay small enough to implement consistently in lightweight clients and non-AI services.

## 2. Algorithm profile

### 2.1 Node signing key

BNP v1 MUST use Ed25519 for node message signatures.

Reasons:

- fixed-size public keys and signatures;
- deterministic signatures;
- broad implementation availability;
- no per-message randomness requirement;
- compact wire representation.

BNP v1 should not expose a peer-controlled generic `alg` field. A node profile states which protocol/key profile is installed; a v1 verifier does not accept an arbitrary algorithm requested by the incoming message.

### 2.2 Fingerprint hash

BNP v1 fingerprints MUST use SHA-256.

A fingerprint is a stable key identifier only. It is not proof of private-key possession and does not replace signature verification.

## 3. Canonical public-key representation

Two interoperable representations were considered for fingerprint input:

1. raw 32-byte Ed25519 public key;
2. DER-encoded SubjectPublicKeyInfo (SPKI) carrying the Ed25519 algorithm identifier and key.

BNP v1 MUST hash the DER-encoded Ed25519 SubjectPublicKeyInfo as defined by the standard Ed25519 SPKI representation.

Rationale:

- the hashed input is self-describing at the key-container level;
- the representation is portable across common crypto libraries;
- it leaves fewer hidden assumptions if future profiles add other key types;
- DER gives one canonical binary encoding for the SPKI structure.

The fingerprint input MUST NOT be PEM text. Whitespace, PEM headers, line wrapping, or local text formatting must never affect identity.

## 4. Fingerprint text form

The normative fingerprint text form is:

```text
sha256:<base64url-no-padding(SHA256(spki_der))>
```

Properties:

- ASCII only;
- explicit hash family;
- no Base64 padding;
- canonical base64url spelling: decoding and unpadded base64url re-encoding MUST produce identical
  text;
- no case-normalization step;
- exact byte-for-byte comparison after schema validation.

A registry entry binds the fingerprint to a logical `node_id` and key lifecycle state.

## 5. Message canonicalization

### 5.1 Canonical JSON

BNP v1 MUST use RFC 8785 JSON Canonicalization Scheme (JCS) over UTF-8 JSON.

Before signing:

1. construct the complete BNP envelope except the `signature` member;
2. validate it against the applicable BNP schema;
3. canonicalize that JSON object with JCS;
4. UTF-8 encode the canonical JSON text.

The wire JSON itself does not have to preserve the canonical member order. Verification recreates the canonical bytes from the parsed validated object.

Implementations MUST NOT sign a locally serialized object whose key order, number formatting, escaping, or Unicode handling is implementation-specific.

### 5.2 Signature-domain separation

The normative signature input is:

```text
ASCII("BNP/1\n") || JCS_UTF8(envelope_without_signature)
```

The fixed prefix prevents a valid signature over identical JSON bytes in a different application/protocol from automatically becoming a valid BNP signature.

If a future incompatible signing transcript is introduced, it requires a new protocol/profile version rather than silent transcript mutation.

## 6. Signature text form

The normative signature text form is:

```text
ed25519:<base64url-no-padding(signature_64_bytes)>
```

The algorithm prefix is descriptive and fixed by the v1 profile; it is not an algorithm-negotiation input.

The verifier must reject:

- padding where the v1 encoding forbids it;
- malformed Base64url;
- a non-canonical terminal-pad-bit spelling even if it decodes to the same bytes;
- decoded signatures of any length other than 64 bytes;
- an unknown/future signature prefix unless that profile is explicitly supported.

## 7. Signed binding

The signed envelope binds at minimum:

```text
bnp
kind
message_id
from
to
issued_at
expires_at
key_fingerprint
body
```

Because JCS signs the whole validated envelope-without-signature, any additional future schema member admitted by the same profile is also signed unless a later version explicitly defines otherwise.

A verifier must not copy selected fields into a second ad-hoc signing structure. The validated envelope itself is the signed object.

## 8. Verification order

A receiver should fail closed in the following order before any state release or side effect:

1. parse JSON with duplicate-member rejection;
2. validate strict schema and `bnp` version;
3. validate message kind;
4. resolve `from` node without disclosing hidden registry detail;
5. verify node lifecycle is eligible;
6. resolve `key_fingerprint` to an enrolled non-revoked key for that node;
7. reconstruct canonical signature input;
8. verify Ed25519 signature;
9. validate `to` against the actual receiver/logical destination;
10. validate `issued_at` / `expires_at` policy;
11. check replay state for `message_id` within the sender namespace;
12. authorize the requested BNP capability;
13. validate the kind-specific body, table/version/command identifiers, or READ selector;
14. only then release state or execute a local handler.

The order is designed so that unauthenticated input cannot use body parsing, command resolution, or state visibility as an oracle.

## 9. Message identity

`message_id` is opaque and carries no semantic content.

Each new logical request `message_id` MUST be generated from at least 128 bits of cryptographically
random input before textual encoding. This is a sender-generation and conformance requirement;
schema `minLength` alone cannot establish entropy.

BNP does not require a specific presentation format such as UUID or ULID as long as the schema and entropy requirement are met. Time-sortable identifiers are permitted only if they do not reduce the random uniqueness requirement or leak deployment-sensitive meaning beyond what the deployment accepts.

A transport retry of the same logical delivery reuses the same `message_id`.

A new logical request uses a new `message_id`.

## 10. Time validity

Every signed request contains `issued_at` and `expires_at`.

The following are mandatory semantics even before concrete defaults are frozen:

- `expires_at` MUST be later than `issued_at`;
- receivers reject messages that are not yet valid beyond the configured future clock-skew allowance;
- receivers reject messages after expiry beyond the configured late clock-skew allowance;
- deployments may choose a shorter maximum lifetime than the sender requested;
- a sender cannot extend receiver replay retention by supplying an arbitrarily distant `expires_at`.

### 10.1 Default lifetime

**BLOCKED-OPEN-DECISION:** concrete v1 default/max TTL and allowed clock skew.

Recommendation for discussion:

- short interactive/control-plane messages: tens of seconds to a few minutes, not hours;
- Bridge and node clocks should use normal authenticated/managed system time where available;
- long-running work is represented by state plus new messages, not by keeping one command envelope valid for the duration of a job.

## 11. Replay key and retention

The replay-store key is conceptually:

```text
(sender_node_id, message_id)
```

A receiver MUST NOT use `message_id` globally without the sender namespace unless its identifier format is proven globally collision-resistant and the implementation deliberately chooses a stricter global rule.

For every authenticated accepted message, the receiver stores enough replay metadata to prevent unsafe re-execution until at least:

```text
receiver_effective_expiry + allowed_late_clock_skew
```

For non-idempotent/at-most-once commands, the implementation SHOULD retain the terminal result reference or a bounded result digest so a duplicate can return the prior outcome without re-running the handler.

Replay state survives ordinary process restart. An implementation that loses replay state on restart does not conform for COMMAND handling unless another durable boundary guarantees equivalent at-most-once behavior.

## 12. Duplicate semantics by plane

### 12.1 WAKE

A duplicate WAKE is safe to acknowledge again. It must not create additional authority or force repeated downstream side effects.

### 12.2 READ

A duplicate READ may be evaluated again if READ is side-effect free. The response remains a fresh authorized read unless a deployment explicitly caches a result under a stronger contract.

### 12.3 COMMAND

A duplicate authenticated COMMAND with the same `(sender, message_id)` MUST NOT execute the local command handler twice.

Allowed duplicate response behavior:

- return the previously recorded terminal result;
- return a bounded `already_processed`/equivalent ACK correlated to the original message;
- if the original is still in progress, return a bounded in-progress correlation without starting another execution.

The receiver must never reinterpret the same message ID with a different body. Because the body is signed, a valid second envelope with the same ID but different signed content is treated as a replay/conflict and rejected.

## 13. Idempotency class

Each command-table entry declares one execution class:

```text
idempotent
at_most_once
state_checked
```

Definitions:

- `idempotent`: repeated execution would be semantically safe, but BNP replay handling still suppresses duplicate transport execution by default;
- `at_most_once`: replay state plus durable execution/result correlation must prevent a second effect;
- `state_checked`: the local handler evaluates a current-state precondition at execution time; duplicate delivery still does not bypass replay handling.

These classes describe execution semantics. They do not grant permission.

## 14. Result correlation

A `command_result`, `read_result`, `ack`, or `error` response MUST include a bounded, top-level
correlation identifier covered by the response signature. Request kinds MUST NOT contain it.

Normative field:

```json
{
  "in_reply_to": "<originating message_id>"
}
```

The result is itself a new signed BNP envelope with its own new `message_id`.

This avoids treating an unsigned transport response as proof of a BNP result when the deployment uses asynchronous or relayed transport.

## 15. Key rotation

During an explicit rotation window a logical node may have two eligible enrolled keys:

- old key: `rotating`;
- new key: `active` or `rotating` according to the registry state machine.

Both fingerprints remain separately auditable.

Rotation rules:

- no capability is inferred from the presented key alone; capability belongs to the logical node/profile policy;
- the signed message fingerprint selects exactly one enrolled public key;
- once the old key becomes `revoked`, all new messages under it fail even if their timestamp would otherwise be valid;
- replay records created under the old key are retained through their normal retention period;
- rotation never changes `node_id`.

## 16. Emergency revocation

Emergency revocation takes precedence over message age, prior success, cached discovery information, or capability state.

After a key/node becomes revoked, a receiver must not:

- release new state;
- execute a new command;
- accept a freshly presented envelope signed by that key.

A duplicate lookup for a command that was conclusively completed before revocation may return only the minimum pre-recorded correlation/result allowed by deployment policy; it must not cause a new side effect or leak additional current state.

## 17. Sequence counters

A signed monotonic sequence number can detect some forms of reordering and make gap analysis easier, but it creates persistent per-sender synchronization state and complicates multi-process senders.

BNP v1 core does not require a sequence counter for security. It MUST use cryptographically random
`message_id` + bounded lifetime + durable replay state for COMMAND as the replay mechanism.

A future optional ordered-stream profile may add signed sequence semantics without changing the core replay guarantee.

No implementation may require a sequence counter as a condition of BNP/1 core interoperability.

## 18. Error behavior

Authentication and replay failures must be bounded and should avoid telling an untrusted peer whether a hidden node, capability, table, or state object exists.

Recommended external distinctions:

- malformed/unsupported protocol;
- authentication failed;
- replay/expired;
- authorization denied;
- valid authenticated request but unsupported visible operation.

Detailed internal audit reason codes may be richer than the external response.

## 19. Deterministic conformance vectors

The public machine-readable vector and its executable validator are
[`bnp/vectors/crypto-replay-v1.json`](bnp/vectors/crypto-replay-v1.json). Its fixed seed/private key
is conspicuously test-only and MUST NOT be used outside conformance testing. Together with
`node-core/test/conformance-vectors.test.ts` and `node-core/test/node-core.test.ts`, they cover:

1. fixed Ed25519 test private/public key pair dedicated only to conformance;
2. exact DER SPKI bytes;
3. expected SHA-256 fingerprint bytes and text form;
4. representative unsigned envelope JSON;
5. exact RFC 8785 canonical JSON bytes;
6. exact domain-separated signing bytes;
7. expected Ed25519 signature bytes and wire text;
8. successful verification result;
9. one vector for every signed-field mutation showing verification failure;
10. replay vectors for first accept, duplicate same content, same ID/different content, expired message, revoked key, and restart-preserved replay state.

At least two independent implementations/languages SHOULD reproduce the vectors before the full
public protocol is called stable. This interoperability release gate does not make the approved
cryptographic choices provisional.

## 20. Decision status

Owner-approved and normative for BNP/1:

- RFC 8785 JCS as canonicalization;
- Ed25519 as the v1 signing algorithm;
- SHA-256 over DER SPKI as fingerprint construction;
- fingerprint and signature text encodings;
- `BNP/1\n` signature-domain prefix;
- minimum message-ID entropy;
- replay retention rule;
- sequence numbers remain non-core;
- `in_reply_to` result-correlation field;
- a public deterministic conformance vector and executable reference validation.

Still **BLOCKED-OPEN-DECISION** and intentionally not selected by this profile:

- concrete default/max TTL and clock-skew values;
- registry persistence model;
- command-table negotiation/downgrade rules;
- production durable replay-store technology.
