# Bridge Node Protocol (BNP) v1 — Public Overview

Status: DRAFT — public-facing design summary

BNP is a compact, transport-neutral control protocol for authenticated logical nodes. Its design goal is deliberately simple:

> Keep the trusted protocol core small while giving that small core strong, explicit security properties.

## Compact by design

BNP does not require GitHub, a specific LLM/provider, a specific programming language, or an SSH control channel in the real-time semantic path.

A deployment may carry BNP over HTTPS, WebSocket, local IPC, Unix sockets, a private overlay network, or another adapter that preserves the protocol's security invariants. BNP itself does not require a public listener.

This keeps the mandatory control plane small and reduces the number of always-on components that must be trusted, configured, patched, observed, and defended.

## High security density

BNP aims for high **security density**: strong security guarantees relative to the size and complexity of the mandatory core.

The public BNP v1 design includes or requires:

- enrolled asymmetric node identity and signed protocol messages;
- sender, recipient, message, version, time-window, and payload binding;
- authorization of every protected operation independently from authentication;
- replay protection and duplicate-safe command handling;
- versioned, allowlisted semantic commands rather than arbitrary shell, eval, script, or free-form execution surfaces;
- bounded state visibility;
- key lifecycle, rotation, suspension, and revocation handling;
- host-local privilege policy as an additional security boundary;
- transport independence without requiring firewall or public-exposure widening.

A smaller core does not mean a weaker threat model. The intent is to remove unnecessary machinery while keeping the security checks that actually enforce identity, authority, freshness, destination binding, and execution scope.

## What BNP deliberately does not claim

BNP does not claim that a small implementation is automatically safer than every larger enterprise stack, nor that implementation size alone proves security.

Security still depends on correct cryptographic implementation, key protection, durable replay handling, authorization policy, local privilege boundaries, conformance testing, and independent review.

The design claim is narrower: within the threat model BNP is designed to cover, strong security properties should not require a large orchestration platform or a provider-specific control plane.

## Public protocol versus private deployment policy

The public BNP specification defines the interoperability contract and the security guarantees that independent implementations must preserve.

Deployment-specific authorization packages, exact policy-transition rules, recovery thresholds, node-to-role assignments, local handler mappings, operational diagnostics, live endpoints, keys, and sensitive state are not required for public interoperability and may remain private.

Protocol security must not depend on those details remaining secret. Keeping deployment policy private is an additional information-minimization layer, not a substitute for cryptography, authorization, replay protection, or least privilege.

## Why compactness matters operationally

Every extra daemon, proxy, token broker, provider adapter, privileged control channel, or configuration service adds code, dependencies, state, failure modes, and operational attack surface.

BNP therefore follows a simple rule:

> Minimal core, optional capabilities.

Features that are not required for authenticated node communication belong in optional adapters or deployment layers rather than in the mandatory protocol core.
