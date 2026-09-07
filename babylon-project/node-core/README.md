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
- atomic replay-store interface with an in-memory non-durable implementation for WAKE/READ;
- a separate durable COMMAND journal contract that is the single source of truth for COMMAND replay identity and execution state;
- an atomic START deadline gate evaluated by the durable journal at the transition boundary;
- COMMAND execution states `received -> started -> terminal`, with `started -> indeterminate` as the conservative uncertainty path;
- immutable terminal outcomes and stale-attempt rejection at the journal boundary;
- unresolved `received`, `started`, and `indeterminate` records may not be forgotten merely because a replay/result retention deadline passed;
- terminal result retention is extended from the actual terminal commit time, so a long-running command cannot consume its own result-retention window before it finishes;
- no automatic rerun from `started` or `indeterminate` in this slice;
- deployment-supplied COMMAND result-size and result-retention policy, with no protocol default frozen here;
- metadata-only optional COMMAND phase tracing that cannot block execution;
- versioned local command registry with no sender-selected executable surface;
- immutable registry snapshots that bind execution to the exact definition and handler authorized before START;
- local authorization callback as an independent policy boundary;
- WAKE, READ, and COMMAND receive paths with signed correlated replies.

Reply correlation is the signed top-level `in_reply_to` field. The bundled deterministic public
test vector is at `docs/bnp/vectors/crypto-replay-v1.json`; its fixed key is unsafe for non-test use.

For COMMAND, the replay claim and execution record are intentionally not split across two sources of truth. A production `CommandJournal` implementation must provide atomic receive/start/terminal transitions, enforce the supplied START validity deadline against its authoritative clock in the same operation that commits STARTED, reject stale attempt IDs, keep terminal outcomes immutable, and retain every unresolved non-terminal record until an explicit recovery/resolution policy says otherwise. No production storage technology is selected by Node Core.

A known exact COMMAND may return its stored terminal outcome after the original request validity window has expired. A previously unseen expired COMMAND is still rejected and cannot start a new side effect. The terminal outcome retention deadline is anchored to terminal commit time rather than initial receipt time.

The current implementation does not yet provide a watchdog, lease, mailbox/completion latch, automatic recovery from `indeterminate`, or production fencing against an already-running external side effect. Those mechanisms must be driven by measured failure/latency evidence and command-specific recovery semantics rather than by an arbitrary timeout.

Concrete TTL/skew values are not hard-coded because those BNP v1 values are not frozen yet. They must be supplied by deployment policy.
