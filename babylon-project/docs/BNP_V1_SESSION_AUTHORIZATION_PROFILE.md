# BNP v1 Session Authorization Profile

Status: DRAFT — owner-approved authorization model, package contents not yet frozen

## 1. Purpose

This profile defines how authenticated BNP nodes acquire effective authority for a connection/session.

The core rule is deliberately conservative:

> Authentication opens the door; authorization decides what the node may do after entering.

Possession of an enrolled key, discovery of an endpoint, reconnection of a previously privileged node, or presentation of privilege claims MUST NOT by itself activate elevated authority.

## 2. Identity eligibility before baseline access

`BASIC-1` is not anonymous access.

Before a session can receive any BNP authorization package, the peer MUST:

1. present a syntactically valid BNP request/handshake;
2. resolve to an enrolled logical `node_id`;
3. prove possession of an eligible enrolled private key;
4. pass node/key lifecycle checks;
5. pass recipient/trust-domain checks required by the deployment.

Unknown, invalid, revoked, or otherwise non-eligible peers are denied and receive no BNP baseline authority.

## 3. Connection reset invariant

Every successfully authenticated eligible BNP connection/session MUST begin with:

```text
effective_profile = BASIC-1
```

This rule applies regardless of:

- the node's prior session authority;
- its durable assigned role/profile;
- permissions claimed by the peer;
- the key used to authenticate;
- whether the node is reconnecting after a normal disconnect, restart, or reversible suspension.

Incoming privilege claims MUST NOT increase `effective_profile`.

A reconnect is therefore a privilege reset point.

## 4. Assigned versus effective authority

BNP distinguishes durable policy assignment from currently active authority.

Conceptually:

```text
assigned_profile  = policy package approved for the logical node/work role
effective_profile = package currently active for this authenticated session
```

Example:

```text
node_id: <opaque node id>
assigned_profile: WORKER@2
effective_profile: BASIC-1
```

After a successful step-up decision:

```text
assigned_profile: WORKER@2
effective_profile: WORKER@2
```

The two fields MUST NOT be treated as synonyms.

## 5. Versioned permission packages

Permission packages are stored as versioned descriptors and assigned by reference rather than by copying ad-hoc capability lists into transient sessions.

A package descriptor SHOULD be able to define at least:

```text
profile_id
profile_version
capabilities[]
visibility_scope[]
command_tables[]
constraints[]
resume_policy
session_policy
```

Possible package names such as `BASIC-1`, `WORKER`, `SUPERVISOR`, `BENCHMARK`, or `MAINTENANCE` are deployment vocabulary, not automatically granted protocol roles.

The exact capability contents of `BASIC-1` remain an explicit freeze item. The package MUST be minimal and MUST NOT include broad execution or administrative authority.

## 6. Step-up authorization

Elevated authority requires a separate post-authentication authorization decision.

A conforming implementation MUST NOT infer step-up merely because:

- the node had elevated authority previously;
- the presented key was previously associated with a privileged node;
- the node advertises a role;
- the node knows a command-table or command identifier;
- the node reconnects from a previously known endpoint.

Step-up evaluates the current policy for the authenticated logical node and session.

Conceptual flow:

```text
CONNECT
  -> AUTHENTICATE IDENTITY
  -> BASIC-1
  -> STEP-UP POLICY EVALUATION
  -> APPROVED PROFILE OR REMAIN BASIC-1
```

A denied, unavailable, expired, or ambiguous step-up decision leaves the session at `BASIC-1`.

## 7. Suspension and fast resume

`suspended` is reversible and distinct from `revoked`.

A suspended logical node MAY preserve:

- `node_id`;
- enrolled key/fingerprint metadata subject to lifecycle policy;
- assigned permission profile;
- interfaces and profile metadata;
- replay/idempotency state;
- bounded routing/endpoint metadata allowed by policy.

Suspension MUST disable ordinary elevated authority.

On reconnection, even a previously elevated suspended node starts at `BASIC-1` after successful authentication.

The previously assigned profile may then be reactivated through step-up policy without reprovisioning the node from scratch.

Security-sensitive suspension reasons MAY require stronger recovery such as explicit operator approval or re-key before any elevated profile can become effective.

## 8. Revocation

Revocation is not a fast-resume state.

A revoked node/key fails closed before baseline access and cannot regain authority through ordinary session step-up.

Recovery from revocation requires an explicit enrollment/recovery process defined outside ordinary reconnect semantics.

## 9. Replay preservation across reset and suspension

Connection reset, reconnect, process restart, profile downgrade, and suspension MUST NOT erase replay state needed to prevent duplicate unsafe COMMAND execution.

Returning to `BASIC-1` never makes an already processed message executable again.

## 10. Authorization evaluation

For each operation the effective authority is conceptually bounded by all applicable gates:

```text
protocol validity
AND authenticated eligible identity
AND lifecycle state
AND session effective_profile
AND operation capability
AND visibility scope
AND command-table/version policy
AND local host/runtime policy
AND current state guards
```

Failure of any required gate results in deny/fail-closed behavior.

## 11. Permission package changes

Changing the contents or meaning of a package SHOULD create a new profile version rather than silently mutating historical semantics when compatibility or auditability would be affected.

A node's `assigned_profile` may be changed by an authorized policy decision. Existing sessions SHOULD NOT silently gain newly added authority without an explicit step-up/re-evaluation event.

## 12. Optional leases

Deployments MAY make elevated effective profiles time-bounded leases.

If a lease expires, effective authority MUST fall back to `BASIC-1` or terminate the session according to deployment policy; it MUST NOT continue elevated authority implicitly.

Lease duration and whether elevated profiles are always leased remain deployment/profile decisions and are not yet BNP v1 core requirements.

## 13. Conformance requirements

The BNP v1 conformance suite MUST include negative tests proving at least:

1. unknown key gets no `BASIC-1` access;
2. revoked key gets no `BASIC-1` access;
3. authenticated privileged node reconnects as `BASIC-1`;
4. peer-supplied privilege claims do not change effective authority;
5. prior elevated session authority is not inherited by a new session;
6. step-up denial leaves the node at `BASIC-1`;
7. approved step-up activates only the approved versioned package;
8. suspension preserves assigned profile but reconnect begins at `BASIC-1`;
9. security-sensitive suspension can require approval/re-key;
10. replay state survives reconnect/suspension/profile reset;
11. knowledge of command IDs does not grant capability;
12. host-local policy can still deny an operation permitted by BNP profile policy.

## 14. Open freeze items

The following remain to be decided explicitly:

- exact `BASIC-1` capability/visibility contents;
- mandatory versus optional lease behavior for elevated profiles;
- exact step-up handshake/messages;
- profile descriptor schema and digest/version semantics;
- automatic reactivation rules for non-security suspension reasons;
- approval/re-key rules for security-sensitive suspension reasons.

No implementation may use these open items to grant broader authority by default.
