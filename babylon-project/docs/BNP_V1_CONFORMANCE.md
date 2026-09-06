# BNP v1 Conformance Matrix

Status: DRAFT

A BNP implementation is not conformant merely because it can parse messages. Conformance requires identity, authorization, replay, versioning, and command-safety behavior to match the protocol contract.

## 1. Test classes

### C1 — Envelope and versioning

Required checks:

- valid BNP/1 envelope accepted;
- unsupported protocol version rejected;
- missing required bound field rejected;
- altered signed field invalidates signature;
- malformed timestamp rejected;
- recipient mismatch rejected;
- oversized body rejected according to implementation limits.

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
- duplicate WAKE is harmless;
- expired message rejected;
- same message ID with altered content rejected;
- non-idempotent command transport retry does not duplicate the effect;
- `at-most-once` command remains protected across receiver restart if the implementation claims durable replay protection;
- result/ACK references the originating message ID.

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
revoked key
unknown node
wrong recipient
expired message
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
- machine-readable bounded errors.

Registry federation, public discovery, hosted services, observability backends, provider adapters, and execution sandboxes are optional.

## 5. Release gate for public v1

Before BNP v1 is declared stable, all of the following are required:

1. protocol spec frozen;
2. signing/canonicalization profile frozen;
3. node fingerprint encoding frozen;
4. command-crate schema frozen;
5. replay window and duplicate semantics frozen;
6. at least one reference Bridge and one reference Node implementation pass all mandatory C1–C7 tests;
7. negative security suite passes;
8. one independent review of the security-sensitive contract is completed;
9. public/private example data is audited for secrets and deployment-specific information;
10. license and repository publication metadata are finalized.
