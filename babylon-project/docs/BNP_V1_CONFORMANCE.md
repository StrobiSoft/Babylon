# BNP v1 Conformance Matrix

Status: NORMATIVE MINIMUM for BNP/1

A BNP implementation is not conformant merely because it can parse messages. Conformance requires identity, authorization, replay, versioning, and command-safety behavior to match the protocol contract.

## 1. Test classes

### C1 — Envelope and versioning

Required checks:

- valid BNP/1 envelope accepted;
- unsupported protocol version rejected;
- missing required bound field rejected;
- altered signed field invalidates signature;
- fingerprint must match `sha256:<43 base64url-no-padding characters>` and decode to a 32-byte
  SHA-256 digest identifier;
- signature must match `ed25519:<86 base64url-no-padding characters>` and decode to 64 bytes;
- fingerprint and signature payloads must decode and re-encode to the identical canonical base64url
  text, rejecting alternate terminal-pad-bit spellings;
- malformed timestamp rejected;
- recipient mismatch rejected;
- response kinds require signed top-level `in_reply_to`; request kinds reject it;
- oversized body rejected according to implementation limits.

Sender conformance MUST demonstrate that new logical request IDs are generated from at least 128
cryptographically random bits. Schema length checks do not prove this property. A transport retry
MUST retain the same ID and a new logical request MUST generate a new one; the textual message-ID
encoding is not fixed by BNP/1.

### C2 — Identity and key lifecycle

Required checks:

- active enrolled key accepted;
- unknown key rejected;
- fingerprint without valid private-key proof rejected;
- revoked key rejected;
- suspended node rejected where operation policy requires active state;
- key rotation accepts old/new key only during explicit overlap window;
- old key rejected after rotation finalization;
- logical node identity remains stable across key rotation.

### C3 — Authorization

Required checks:

- authenticated node with required capability succeeds;
- authenticated node without capability is denied;
- capability for another table/command does not authorize current command;
- READ releases only fields allowed by visibility scope;
- WAKE receipt never grants COMMAND authority;
- discovery of an endpoint never grants READ or COMMAND authority.

### C4 — Replay and idempotency

Required checks:

- first valid message ID accepted;
- replay identity is the pair `(sender_node_id, message_id)`;
- duplicate WAKE is harmless;
- expired message rejected;
- not-yet-valid and excessive-lifetime messages are rejected under caller-supplied policy;
- same message ID with altered content rejected;
- non-idempotent command transport retry does not duplicate the effect;
- every COMMAND receiver fails closed without a durable replay boundary;
- every COMMAND remains replay-protected across ordinary receiver process restart;
- result/ACK carries signed top-level `in_reply_to` equal to the originating message ID.

### C5 — Command crate safety

Required checks:

- known table/version/command resolves to the expected local handler;
- unknown table rejected;
- unsupported version rejected;
- unknown command rejected;
- deprecated command follows explicit policy;
- sender cannot choose a function name, executable path, shell command, script, or dynamic handler;
- generic arbitrary argument channel is rejected;
- required capability is evaluated before handler execution;
- handler precondition is evaluated for `state-checked` commands.

### C6 — Privacy and data minimization

Required checks:

- WAKE does not require task content;
- opaque node/message IDs do not encode business data by specification;
- error response does not enumerate hidden capabilities or hidden registry contents;
- unauthorized READ does not leak partial protected state;
- command-table secrecy is not used as an authorization mechanism.

### C7 — Registry/discovery separation

Required checks:

- endpoint update does not create a new logical node;
- key rotation does not create a new logical node;
- runtime endpoint health change does not silently mutate profile semantics;
- discovered endpoint still requires normal BNP authentication;
- unsupported interface/profile version is rejected or negotiated explicitly.

### C8 — Transport independence

At least two independent transport adapters SHOULD be able to carry the same signed logical BNP envelope without changing its security semantics.

A transport adapter fails conformance if it:

- strips or rewrites signed fields;
- bypasses recipient validation;
- skips signature validation;
- disables replay checks;
- widens command semantics through transport-specific free-form fields.

## 2. Negative security tests

The following MUST fail closed:

```text
forged signature
malformed fingerprint/signature encoding
revoked key
inactive key
unknown node
wrong recipient
expired message
message issued beyond allowed future skew
message lifetime above caller policy
replayed unsafe command
capability mismatch
unknown command table
unsupported table version
unknown command id
sender-supplied handler name
sender-supplied shell/script/eval payload
unauthorized state view
```

## 3. Command execution evidence

For every COMMAND conformance case, test evidence SHOULD record:

```text
message_id
sender node id
recipient node id
table/version/command
identity validation outcome
capability decision
replay decision
handler selected
handler execution count
result state
```

Secrets, private keys, credentials, and unnecessary business payloads MUST NOT appear in evidence artifacts.

## 4. Minimal interoperable implementation profile

A minimal BNP v1 implementation MUST provide:

- stable logical node ID;
- asymmetric node identity;
- signed envelope validation;
- active/revoked key handling;
- deny-by-default capability checks;
- WAKE/EVENT receive path;
- READ request/response path;
- COMMAND table resolution;
- replay protection;
- signed ACK/result;
- RFC 8785 JCS and the `BNP/1\n` domain-separated Ed25519 transcript;
- SHA-256-over-DER-SPKI fingerprint and fixed base64url-no-padding text forms;
- signed top-level `in_reply_to` response correlation;
- machine-readable bounded errors.

Registry federation, public discovery, hosted services, observability backends, provider adapters, and execution sandboxes are optional.

## 5. Release gate for public v1

Before BNP v1 is declared stable, all of the following are required:

1. protocol spec frozen;
2. deterministic vectors reproduced by an independent implementation/language;
3. exact deployment TTL/skew profile selected without changing the BNP/1 transcript;
4. command-crate schema frozen;
5. production durable replay boundary selected and validated;
6. at least one reference Bridge and one reference Node implementation pass all mandatory C1–C7 tests;
7. negative security suite passes;
8. one independent review of the security-sensitive contract is completed;
9. public/private example data is audited for secrets and deployment-specific information;
10. license and repository publication metadata are finalized.
