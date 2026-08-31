# AI collaboration and handoff workflow

Status: adopted development-process milestone

Date adopted: 2026-08-20

## Purpose

Babylon uses a human-owned, GitHub-centered collaboration model for AI-assisted implementation and review. The goal is to reduce manual handoff overhead without weakening engineering ownership, review independence, CI gates, or merge control.

GitHub is the shared source of truth between implementation agents, review agents, CI, and the human project owner. Chat transcripts are not treated as the authoritative project state.

## Core model

Each active implementation task uses one canonical pull request and branch.

The pull request contains a persistent top-level comment titled `AI HANDOFF / REVIEW STATE`. That comment acts as the live coordination record for the task.

The handoff record should contain, as applicable:

- current baseline/head SHA;
- RED blockers that prevent merge;
- YELLOW risks or follow-up items;
- GREEN verified properties;
- non-negotiable architecture/security invariants;
- current owner of the next action;
- exact next action;
- CI/review state needed before ownership changes again.

The comment is updated in place as the task advances instead of creating a new handoff note for every iteration.

## Roles

### Human project owner

The human owner retains final authority over scope, product decisions, security trade-offs, and merge approval.

No AI agent may treat green CI, an implementation completion message, or an automated review as implicit merge approval.

### Implementation agent

The implementation agent is expected to:

1. read the current PR head and the latest `AI HANDOFF / REVIEW STATE` before changing code;
2. inspect relevant existing code and tests rather than implementing only from a textual task summary;
3. implement unresolved assigned items on the existing task branch;
4. preserve documented architecture/security invariants;
5. add regression coverage for corrected behavior;
6. push recoverable commits/checkpoints;
7. report commit SHAs, validations actually run, and remaining assumptions or risks;
8. never merge unless the human owner explicitly authorizes it.

### Independent review agent

The review agent is expected to:

1. review the actual GitHub diff at the current head;
2. inspect relevant implementation files, tests, CI results, and lifecycle/security boundaries;
3. classify findings as RED, YELLOW, or GREEN;
4. update the shared handoff state with concrete unresolved items;
5. avoid silently repairing review findings when an independent implementation/review separation is desirable;
6. require another validation/review cycle after material fixes;
7. never recommend merge while a known RED item remains unresolved.

## RED / YELLOW / GREEN semantics

- **RED**: correctness, security, data-loss, privacy, lifecycle, or architecture issue that blocks merge.
- **YELLOW**: material risk, maintainability concern, operational weakness, or incomplete validation that should be addressed or explicitly accepted before merge.
- **GREEN**: behavior or validation directly verified from code, tests, CI, or another authoritative source.

GREEN means verified, not merely intended or documented.

## Handoff protocol

A normal cycle is:

1. Review agent inspects the current head.
2. Review agent updates the PR handoff state.
3. Ownership moves to the implementation agent for specific unresolved work.
4. Implementation agent reads the PR handoff state, implements, tests, commits, and pushes.
5. CI runs on the new head.
6. Ownership moves back to the independent review agent.
7. Review agent verifies the actual new diff and CI rather than relying on the implementation summary.
8. Repeat until no RED items remain and the merge gate is satisfied.

This makes the repository and PR conversation the coordination layer; the human owner does not need to manually copy detailed engineering state between AI systems.

## Required discipline

- The current GitHub head is authoritative; stale chat context is not.
- Validation is reported as passed only if it actually ran and passed.
- Material state-machine, persistence, security, crypto-boundary, or lifecycle changes require code-level review, not only CI.
- Security invariants must be written explicitly in the handoff state when relevant.
- Implementation and review should remain separable roles for high-risk changes.
- A failed or uncertain operation must not be converted into a stronger success claim by either agent.
- Human approval remains the final merge gate.
- A known in-scope correctness, security, data-integrity, reliability, or
  robustness issue that can reasonably be solved and validated now must not be
  deferred for convenience or prioritization. Deferral requires a genuine
  external dependency, explicit architectural boundary, or other unavoidable
  blocker; record and evaluate that dependency separately from solvable work.

## Why this is a project milestone

This workflow is considered a development-method milestone because it turns AI assistance from ad-hoc chat-based delegation into a repeatable engineering loop with:

- one shared authoritative state;
- reduced manual coordination overhead;
- explicit ownership transfer;
- independent review after implementation;
- reproducible CI evidence;
- durable RED/YELLOW/GREEN decision history;
- preserved human control over merge and architecture decisions.

The method does not increase Babylon's product-completion percentage by itself. It increases the reliability, auditability, and throughput of the development process used to reach those product milestones.

## Initial adoption

The workflow was first adopted during remediation and independent review of PR #22 (`Stage II: transient guaranteed message delivery (transport-v1)`). The PR's persistent `AI HANDOFF / REVIEW STATE` comment is the first live instance of this coordination model.

## NOEMI-BRIDGE extension — 2026-08-31

The collaboration model was extended from PR-local handoff records to a dedicated machine-readable task queue in Babylon issue #40.

The bridge uses explicit versioned envelopes:

- `NOEMI-BRIDGE/TASK v1`
- `NOEMI-BRIDGE/RESULT v1`

A task carries a unique `task_id`, the requested execution mode and the bounded prompt. A result carries the same `task_id`, execution status and a durable summary. Successful end-to-end tests demonstrated that Noémi can place a task into the queue, Codex can execute it through the dedicated ZooLab automation environment, and the result can return to the same GitHub thread without the human owner manually relaying prompts and responses.

The bridge is an execution and coordination mechanism, not a transfer of project authority. The following rules remain unchanged:

- the human owner retains final product, architecture, security and merge authority;
- a valid scoped task authorizes execution only within its stated boundaries;
- privilege expansion, secret exposure, destructive out-of-scope operations and security-boundary bypasses are not implied by task authorization;
- failed, timed-out or blocked execution must be reported as such and must not be upgraded into a success claim;
- GitHub remains the durable coordination record.

The practical milestone is that the human owner no longer needs to serve as a mechanical copy-and-paste proxy between Noémi and Codex. Human judgment stays in the loop; repetitive transport work does not.
