# Bridge Node Protocol (BNP) v1

Status: DRAFT — first canonical implementation contract

## 1. Purpose

BNP is a compact, transport-neutral protocol for authenticated logical nodes that need to discover each other, read authorized state, receive semantic events, and execute narrowly allowlisted commands.

The core protocol is intentionally small. Optional registry, federation, audit, provider adapters, agent runtimes, and execution sandboxes are extensions rather than prerequisites.

Core design rule:

> Minimal core, optional capabilities.

BNP does not require GitHub, Codex, any specific LLM, any specific programming language, or any hosted provider in the real-time path.

## 2. Roles

### 2.1 Bridge

The Bridge is the trust and routing hub for one BNP trust domain. It:

- authenticates node requests;
- resolves node identity and lifecycle state;
- authorizes each requested operation independently;
- releases only the state fields visible to the requesting node;
- routes WAKE/EVENT and COMMAND envelopes;
- enforces replay and duplicate handling rules;
- records bounded audit metadata where configured.

### 2.2 Node

A node is any implementation that speaks BNP and has an enrolled logical identity. A node may be an AI agent, service, daemon, client, gateway, worker, or other software component.

No node type is mandatory.

## 3. Node model

A logical node has a stable opaque `node_id` independent of its current key, profile version, endpoint, host, process, provider, or implementation language.

Minimum registry fields:

```text
node_id
status
active_key_fingerprints[]
profile_version
protocol_versions[]
capabilities[]
visibility_scope
interfaces[]
declared_endpoints[]
runtime_endpoints[]
```

### 3.1 Lifecycle

Minimum lifecycle states:

```text
pending
active
rotating
suspended
revoked
```

A revoked node or key MUST fail closed.

### 3.2 Profile/version separation

Node identity, node profile version, protocol interfaces, declared endpoints, and runtime endpoint observations are separate facts with separate lifecycles.

Changing a runtime address MUST NOT create a new logical node identity.

Rotating a key MUST NOT create a new logical node identity.

Changing command-table support SHOULD advance the relevant profile/table version rather than mutating old semantics silently.

## 4. Cryptographic identity

A public-key fingerprint identifies a key; it is not proof of identity by itself.

Every authenticated BNP operation MUST prove possession of a currently enrolled private key.

### 4.1 Normative v1 signing profile

BNP/1 implementations MUST use:

- Ed25519 node keys;
- `sha256:<base64url-no-padding(SHA-256(DER Ed25519 SPKI))>` public-key fingerprints;
- UTF-8 JSON messages;
- RFC 8785 JCS canonicalization of the validated envelope without `signature`;
- the signature transcript `ASCII("BNP/1\n") || JCS_UTF8(envelope_without_signature)`;
- `ed25519:<base64url-no-padding(signature_64_bytes)>` signature text.

The algorithm and encodings are fixed BNP/1 wire identity, not peer-negotiated inputs.

### 4.2 Signed binding

The signature MUST bind at least:

```text
protocol_version
kind
message_id
sender_node_id
recipient_node_id
issued_at
expires_at
body
key_fingerprint
```

Changing any bound field MUST invalidate the signature.

## 5. Common envelope

Logical v1 envelope:

```json
{
  "bnp": "1",
  "kind": "wake|read|read_result|command|command_result|ack|error",
  "message_id": "<opaque unique id>",
  "from": "<opaque node_id>",
  "to": "<opaque node_id>",
  "issued_at": "<UTC timestamp>",
  "expires_at": "<UTC timestamp>",
  "key_fingerprint": "<fingerprint>",
  "body": {},
  "in_reply_to": "<originating message_id; responses only>",
  "signature": "<signature>"
}
```

`read_result`, `command_result`, `ack`, and `error` response envelopes MUST contain top-level
`in_reply_to`. It MUST equal the originating request's `message_id` and is covered by the response
signature. Request kinds (`wake`, `read`, and `command`) MUST NOT contain `in_reply_to`.

Opaque node IDs and message IDs MUST NOT carry business semantics.

Free-form natural-language command execution is outside BNP v1 core.

## 6. Protocol planes

### 6.1 WAKE / EVENT plane

Purpose: tell a node that a meaningful semantic transition occurred without transporting task content.

Example body:

```json
{
  "event_code": "N18-01",
  "event_id": "<opaque event id>"
}
```

Rules:

- change-only by default;
- no task prompt/body required;
- no execution authority is granted;
- duplicates are safe and idempotent;
- the receiver performs a fresh READ when authoritative state is needed.

A WAKE event MUST NEVER grant COMMAND capability.

### 6.2 READ plane

Purpose: retrieve fresh authoritative state after authentication and authorization.

Example request body:

```json
{
  "resource": "task.current",
  "view": "self"
}
```

The Bridge MUST evaluate visibility and capability before releasing any state fields.

A node MUST receive only the minimum state slice authorized for its identity and requested view.

### 6.3 COMMAND plane

Purpose: invoke a predefined, bounded semantic action through a versioned command-table reference.

Example body:

```json
{
  "table_id": "core",
  "table_version": "1",
  "command_id": "continue"
}
```

The network command references semantics; it MUST NOT contain arbitrary shell, eval, prompt, or unrestricted argument text.

The receiving node resolves the command to a local allowlisted handler only after:

1. signature validation;
2. sender identity validation;
3. recipient validation;
4. replay validation;
5. capability authorization;
6. command-table/version validation.

Knowing a command ID MUST NOT be sufficient to execute it.

## 7. Authorization

Authentication and authorization are independent checks.

Example capability vocabulary:

```text
wake.receive
state.read:self
state.read:supervisor
result.ack
command.execute:<table>
command.execute:<table>/<command>
task.execute:<scope>
```

Rules:

- deny by default;
- unknown capability fails closed;
- capability scope MUST be evaluated for every operation;
- one compromised node MUST NOT inherit another node's state visibility or command authority;
- privileged local execution remains subject to the host's own policy boundary in addition to BNP authorization.

## 8. Replay and idempotency

Every signed request MUST include a unique `message_id`, bounded lifetime, sender, and recipient.
The sender MUST generate each new logical request ID from at least 128 bits of cryptographically
random input. A transport retry of the same logical request MUST preserve the ID; a new logical
request MUST use a new ID. String length alone does not prove this semantic generation property,
and BNP/1 does not mandate one textual presentation encoding for message IDs.

Receiver requirements:

- reject expired messages outside the configured clock-skew allowance;
- use `(sender_node_id, message_id)` as the durable replay identity;
- remember accepted message IDs for at least the receiver-effective expiry plus allowed late skew;
- reject or idempotently acknowledge duplicates according to message kind;
- never execute the same non-idempotent command twice because of transport retry;
- bind result/ACK messages to the originating message ID.

COMMAND handling MUST use replay state that survives ordinary receiver process restart. It MUST
fail closed if no durable replay boundary is available. BNP/1 does not mandate a production replay
store technology.

BNP/1 core does not require a sequence counter. An optional future ordered-stream profile may add
one without weakening the core random-ID and durable-replay requirements.

WAKE duplicates SHOULD be harmless.

COMMAND handlers MUST declare one of:

```text
idempotent
at-most-once
state-checked
```

The local handler contract determines safe duplicate behavior.

## 9. Registry and discovery

BNP registry data describes who a node is and how it may currently be reached; it is not the command transport itself.

Recommended logical separation:

```text
NodeIdentity
NodeProfileVersion
NodeInterface
DeclaredEndpoint
RuntimeEndpoint
CapabilitySet
VisibilityScope
```

A node MAY have multiple interfaces and endpoints.

Runtime endpoint health MAY change without mutating the node profile.

Discovery MUST NOT itself grant access. A discovered endpoint still requires normal BNP authentication and authorization.

## 10. Transport neutrality

BNP core defines signed logical messages and semantics, not one mandatory carrier.

Possible adapters include:

- HTTPS request/response;
- WebSocket;
- Unix-domain socket;
- local IPC;
- private overlay-network transport;
- provider-specific event adapters.

A transport adapter MUST NOT weaken BNP identity, signature, replay, or authorization rules.

No public listener is required by the protocol.

## 11. Error model

Errors SHOULD be machine-readable and bounded.

Minimum draft error codes:

```text
BNP_AUTH_INVALID
BNP_KEY_REVOKED
BNP_NODE_UNKNOWN
BNP_RECIPIENT_MISMATCH
BNP_REPLAY
BNP_EXPIRED
BNP_CAPABILITY_DENIED
BNP_TABLE_UNKNOWN
BNP_TABLE_VERSION_UNSUPPORTED
BNP_COMMAND_UNKNOWN
BNP_STATE_NOT_VISIBLE
BNP_PROTOCOL_UNSUPPORTED
BNP_INTERNAL
```

Error responses SHOULD avoid leaking hidden registry, capability, or state information.

## 12. Privacy and metadata minimization

BNP identifiers SHOULD be opaque.

WAKE/EVENT payloads SHOULD expose the smallest useful semantic signal.

If even event-category metadata is considered sensitive for a deployment, the deployment MAY collapse event codes to a single opaque wake semantic and recover meaning only through READ.

Command IDs are not secrets. Security MUST come from authenticated identity, authorization, signed binding, replay protection, and local handler policy.

## 13. Key rotation and revocation

Key rotation is first-class.

A node MAY temporarily have old and new active keys during an explicit rotation window.

After rotation completion:

- the old key MUST be revoked;
- replay state from the old key MUST remain effective for its required retention window;
- the logical `node_id` MUST remain unchanged;
- capability assignments MUST remain bound to the logical node, not implicitly copied from arbitrary presented keys.

Emergency revocation MUST take effect before any new state release or command execution.

## 14. Core/non-core boundary

BNP core contains:

- logical node identity;
- signed envelope;
- authentication;
- capability authorization;
- WAKE/EVENT;
- READ;
- COMMAND references;
- replay/idempotency;
- version negotiation/error semantics.

Optional extensions may provide:

- distributed/federated registry;
- richer health/discovery;
- provider adapters;
- audit backends;
- SDKs;
- hosted Bridge services;
- execution sandbox integrations;
- observability and metrics.

## 15. Security invariants

1. No arbitrary shell/eval surface.
2. No unrestricted free-form command/prompt field.
3. Authenticate before state release.
4. Authorize every operation independently.
5. WAKE never grants execution authority.
6. Discovery never grants execution authority.
7. Unknown/revoked keys fail closed.
8. Duplicate transport delivery MUST NOT cause duplicate unsafe execution.
9. A command identifier is not a credential.
10. Host-local privilege policy remains an additional boundary.
11. Protocol design MUST NOT require firewall or public-exposure widening.

## 16. Open decisions before v1 freeze

The following remain explicit review items:

- default message TTL and clock-skew window;
- exact registry persistence model;
- table-version negotiation rules;
- production durable replay-store technology;
- final public repository name and license;
- the complete public-v1 release test gate beyond the normative minimum in the conformance matrix.

No implementation should silently invent incompatible answers to these open decisions.
