# BNP v1 Session Authorization Contract

Status: DRAFT — public interoperability contract

## 1. Purpose

This document defines only the public authorization guarantees required for BNP interoperability.

Deployment-specific authorization packages, exact privilege-transition points, recovery policy, node-to-role assignments, local handler mappings, and diagnostic rules are intentionally outside the public protocol contract.

BNP security MUST NOT depend on those deployment details remaining secret.

## 2. Authentication is not authorization

Successful cryptographic authentication proves possession of an eligible enrolled key for a logical node. It does not, by itself, grant unrestricted state access or command authority.

Every protected operation remains subject to authorization after authentication.

Unknown, invalid, revoked, or otherwise ineligible identities fail closed.

## 3. Session authority is deployment-controlled

A BNP implementation MUST NOT assume that authority from a previous connection or session automatically becomes effective in a later one.

Deployments MAY re-evaluate, reduce, suspend, replace, or require renewed approval for effective authority across connection, lifecycle, policy, or recovery transitions.

A peer-supplied role, privilege claim, endpoint, command identifier, or previous success MUST NOT by itself activate additional authority.

## 4. Authorization profiles

Deployments MAY represent permission sets as versioned profiles/packages rather than ad-hoc capability lists.

The exact names, contents, assignment rules, transition rules, and activation policy of those profiles are deployment configuration rather than BNP wire-level requirements.

Independent implementations therefore must not rely on a specific public role vocabulary.

## 5. Elevated authority

If a deployment supports authority above its normal baseline, activation of that authority requires an explicit policy decision after identity has been established.

The mechanism may depend on deployment policy, current lifecycle state, operator approval, time bounds, current task scope, or other local controls.

Failure, ambiguity, expiry, or denial MUST fail closed rather than silently activating broader authority.

## 6. Suspension and revocation

`suspended` is reversible and distinct from `revoked`.

A deployment MAY preserve logical identity and selected configuration for a suspended node so it can return without full reprovisioning, but suspension does not imply continued elevated authority.

A revoked node/key is not eligible for ordinary authorization recovery and fails closed until an explicit enrollment/recovery process establishes new eligible identity material.

## 7. Replay state survives authorization transitions

Connection changes, process restart, authorization downgrade, suspension, or policy re-evaluation MUST NOT erase replay/idempotency state required to prevent duplicate unsafe COMMAND execution.

An authorization transition never makes an already processed unsafe request executable again.

## 8. Information minimization

BNP error responses SHOULD expose only the information required for interoperable behavior.

Implementations MAY keep richer internal audit reasons than they return to the peer. They are not required to disclose deployment-specific authorization branches, role mappings, recovery conditions, or policy transition details.

This is information minimization, not a substitute for cryptographic authentication, authorization, replay protection, or host-local privilege enforcement.

## 9. Authorization evaluation

For each protected operation, the effective decision is bounded by all applicable gates, including:

```text
protocol validity
AND authenticated eligible identity
AND lifecycle state
AND deployment authorization policy
AND operation capability
AND visibility scope
AND command-table/version policy
AND local host/runtime policy
AND current state guards
```

Failure of any required gate results in deny/fail-closed behavior.

## 10. Public conformance requirements

The BNP v1 conformance suite MUST prove at least that:

1. forged or invalid authentication cannot obtain protected access;
2. revoked identity material fails closed;
3. peer-supplied privilege claims cannot increase authority by themselves;
4. knowledge of a command ID or table does not grant capability;
5. protected operations are authorized independently from authentication;
6. denied or ambiguous authority elevation fails closed;
7. replay protection remains effective across reconnect/restart/lifecycle transitions;
8. host-local policy can still deny an operation otherwise allowed by BNP-level policy;
9. external errors do not need to reveal private deployment authorization topology.

## 11. Public/private boundary

The public BNP specification SHOULD document security invariants and interoperability behavior, but SHOULD NOT require publication of a deployment's exact authorization packages, privilege-transition logic, recovery thresholds, node assignments, local execution bindings, or internal diagnostic map.

Those details may remain private without weakening the public protocol contract.
