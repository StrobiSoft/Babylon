# Babylon authentication security architecture

## Trust boundaries and domain model

The backend is the policy enforcement point. Flutter, browsers, callback listeners, SMTP and request
metadata are untrusted inputs. PostgreSQL is the durable source of truth; possession of an opaque
token is never sufficient without a live database check. WebAuthn uses exact RP ID/origin, required
user verification and discoverable credentials.

Users are separate from identities and credentials. A user can have several identities and future
authentication methods. Passkeys, devices, sessions, token families and authentication transactions
are independent, user-bound entities. Audit events describe accountability; security events describe
risk and notification/export signals. Both streams are append-only. Delivery state lives separately.

## User lifecycle

Canonical states are `pending_verification`, `active`, `suspended`, `locked`, `disabled`,
`pending_deletion` and `tombstoned`; `invited` is an invitation before a user exists. Allowed server-
side transitions are active → suspended/locked/disabled/pending deletion; suspended or locked →
active/disabled; disabled → active/pending deletion; pending deletion → active/tombstoned.

Every transition increments `security_version` and revokes all sessions. Only active users with a
matching session version can authenticate or refresh. Legal tombstone retention is not guessed.

## Token, session and transaction lifecycle

Bearer capabilities use cryptographic randomness and are stored only as hashes. Invitations,
verification tokens, enrollment grants, WebAuthn challenges, native/return/recovery transactions and
recovery codes have a purpose, TTL and single-consumption marker. Row locks serialize consumption.

Access tokens are short lived. Sessions have absolute and inactivity expiry, assurance level,
authentication method, activity and refresh timestamps. Refresh tokens rotate in a family. Reuse
revokes the family/session and emits a critical event. Lifecycle change and recovery increment the
user security version, invalidating every older session.

## Assurance and step-up

`aal1`, `aal2` and `aal3` are persisted policy inputs. Passkey sessions are `aal2` because user
verification is required. `authenticated_at` and `step_up_at` establish freshness. Passkey removal,
recovery-code regeneration and bulk session revocation require a fresh non-AAL1 session. The initial
verified WebAuthn ceremony is the first step-up. Later authorization can require AAL3 unchanged.

## Recovery

Recovery requires two independent factors: a short-lived e-mail transaction token and one high-
entropy, one-time recovery code generated under fresh AAL2. Codes are shown once, stored as hashes
and replaced atomically. Recovery consumes both factors, increments security version, revokes every
session, records events and grants only short-lived passkey enrollment—not a session.

## Abuse, enumeration and privacy

Endpoint/IP burst limits are supplemented by database-backed account/e-mail/transaction counters,
longer windows and bounded exponential cooldown; there is no permanent lockout. Public recovery and
resume responses are generic. Authentication uses discoverable credentials without an e-mail input.

Raw IPs are not stored: a minimized prefix is domain-separated and hashed. User-agent/client version
are bounded metadata, not identity. Device binding secrets are hashed; public-key/key-version fields
prepare later challenge-response binding. Secrets and credential material never enter events/logs.

Expired capabilities may be cleaned up. Audit/security retention requires an approved policy before
automation; the technical model distinguishes deletable operational data from immutable evidence.

## Threat model and controls

- Credential/database theft: hashed capabilities; passkey private keys never reach Babylon.
- Token theft/session hijack: short TTL, binding, inactivity/absolute expiry and server-side revoke.
- Refresh replay: transactional rotation, family revoke and critical event.
- CSRF: bearer API, no cookie auth, strict CORS/CSP and no-referrer pages.
- PKCE/state bypass: S256, hashed state, fixed return profiles and one-time return codes.
- WebAuthn replay: locked one-time challenges, exact RP/origin and user verification.
- Counter anomaly: suspicious marker and high event; multi-device zero counters are not misclassified.
- Enumeration/brute force: generic responses, discoverable credentials and multi-key rate limits.
- Malicious client: no arbitrary callback, strict schemas and purpose-bound capabilities.
- Compromised device: device and associated sessions can be revoked immediately.
- SMTP compromise: e-mail alone cannot recover; a recovery code is also required.
- Insider/admin abuse: separate bootstrap authorization, reason, audit and security event.

## Secrets, keys and intentional deferrals

Development `.env` remains. `NAME_FILE` and systemd `CREDENTIALS_DIRECTORY` sources support Docker
secrets/systemd credentials; an external manager can populate the same interface. There is currently
no server signing/encryption key because tokens are opaque. If signed artifacts appear, they require
key IDs plus active and grace-period verification keys.

Production TLS/domain, platform links, release signing, enterprise SMTP, SIEM transport, legal
retention, organization/role authorization, administrator passkey step-up and device attestation need
external policy/infrastructure. Interfaces exist; placeholder security claims are intentionally absent.

## Transient delivery privacy boundary

Message envelopes are operational delivery data, not audit or conversation history. Pending payloads have a maximum lifetime; delivered and expired rows have no payload. Cleanup is batch-bounded, and content-free terminal tombstones are retained only long enough for late sender reconciliation. The server never logs the payload field. The server-visible routing metadata is limited to sender, recipient, stable request ID, format marker, state, failure code, and lifecycle timestamps.

The client receipt ledger stores only sender/request identity, processing state, and a retention timestamp. Its retention extends beyond authoritative payload expiry to cover late fetch/ACK behavior, after which startup or subsequent inbound activity prunes it. The production consumer contract requires durable idempotency on that identity; arbitrary callbacks are not represented as exactly-once operations.

## Bishop / DHP delayed-key protection direction

For the future BAB/Bishop-based DHP path, preserve the following security direction as a candidate protection layer with a strong cost/benefit profile:

1. The protected object/container is transmitted first in encrypted form; possession of the transported object alone must not be sufficient to open it.
2. Sender and receiver establish and verify a stable cryptographic integrity/identity value (the user-facing concept may be described as a fingerprint). The exact value, scope and authentication semantics must be defined before implementation; a transport-success indicator alone is not sufficient.
3. The decryption key or key-enabling material is released only after the protocol has reached the explicitly defined successful integrity/endpoint-verification state. Key release must be separately authenticated and bound to the intended object, sender, recipient and transfer identity so that a valid key cannot be replayed or substituted for another object.
4. Failure, timeout, mismatch or ambiguous verification must fail closed: no key release, no silent downgrade to ordinary handling, and a clear recoverable/terminal state according to the final protocol contract.
5. The server should learn no more key material or object relationship information than is technically required by the final design. Whether the server participates in key relay, stores only opaque key envelopes, or can be removed from key knowledge entirely is an architectural decision that must be made explicitly before implementation.
6. This delayed-key layer is expected to be computationally inexpensive relative to repeated fragmentation/reassembly because it primarily adds bounded hashing/integrity checks, authenticated state transitions and a small key-control exchange rather than another large-payload transformation pass. This is a design expectation, not a performance claim: benchmark CPU, RAM, I/O, network round trips and failure/retry cost before enabling it by default.
7. Do not claim that this layer protects a compromised endpoint after plaintext is legitimately displayed. Its purpose is to strengthen object/key separation, integrity binding and controlled key release during delivery.

This direction is recorded now so later attachment/DHP integration does not accidentally choose a transport or key lifecycle that makes delayed key release difficult to add. It is not implementation authorization. The exact cryptographic primitive, fingerprint construction, key derivation/wrapping, endpoint authentication and recovery behaviour remain a mandatory decision gate.
