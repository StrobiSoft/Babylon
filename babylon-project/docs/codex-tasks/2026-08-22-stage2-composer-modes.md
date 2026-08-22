# Stage II/2 — Explicit composer modes

Implement Stage II item 2 from `docs/MASTER_PLAN.md`.

## Goal

The composer architecture must treat every non-default transformation mode as explicit opt-in state and keep the currently active mode continuously visible before send.

## Requirements

- Keep Soft Chat as the default mode and preserve its no-AI/no-translation behavior.
- Any non-default transformation mode must require explicit user selection; no silent or implicit activation.
- The active composer mode must remain continuously visible before send.
- Do not expose a mode as selectable until its processing path is actually functional.
- Preserve all current Soft Chat send/receive, outbox, ACK, exactly-once, persistence, and delivery-state guarantees.
- Do not implement translation/model processing in this task.
- Add or update tests that prove default Soft Chat behavior and explicit mode-state behavior.
- Keep changes narrowly scoped to Stage II/2.

## Validation

Run the relevant Flutter analyze/tests/builds and any affected backend checks. Report exact results and any blocker. Do not merge without explicit owner approval.
