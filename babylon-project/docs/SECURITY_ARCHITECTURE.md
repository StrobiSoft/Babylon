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
