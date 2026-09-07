# NODE IJET Node Core

This directory contains the transport-neutral reference Node core for BNP/1.

The boundary is intentionally narrow:

```text
authenticated BNP envelope -> Node Core -> signed BNP result
```

The core does not open sockets and does not depend on Bridge, GitHub, SSH, Tailscale, an LLM provider, or a specific transport adapter.

Current slice:

- RFC 8785 canonical JSON serialization for already-parsed I-JSON values;
- Ed25519 signing and verification with the `BNP/1\n` signature domain;
- SHA-256 fingerprinting over DER Ed25519 SPKI;
- structural envelope validation and caller-supplied time policy;
- atomic replay-store interface with an in-memory non-durable implementation;
- mandatory durable replay-store gate for COMMAND execution;
- versioned local command registry with no sender-selected executable surface;
- local authorization callback as an independent policy boundary;
- WAKE, READ, and COMMAND receive paths with signed correlated replies.

Reply correlation is the signed top-level `in_reply_to` field. The bundled deterministic public
test vector is at `docs/bnp/vectors/crypto-replay-v1.json`; its fixed key is unsafe for non-test use.

The in-memory replay store is suitable for WAKE/READ development only. The Node Core deliberately refuses COMMAND execution when the injected replay store is not durable. A production durable replay adapter remains a separate implementation slice.

Concrete TTL/skew values are not hard-coded because those BNP v1 values are not frozen yet. They must be supplied by deployment policy.
