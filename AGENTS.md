# Repository guidance

## Scope

- The Babylon application is under `babylon-project/`; preserve its existing architecture and Git history.
- `services/zoolab-monitor/` is an independent historical component and must not be treated as a Babylon dependency.
- `services/babylon-status/` is local, protected, and outside repository scope. Never inspect, edit, stage, commit, or publish its contents as part of Babylon work.

## Security

- Never commit `.env` files, tokens, passwords, private keys, certificates, signing material, database data/dumps, or local credentials.
- Never commit `node_modules`, Flutter/Android caches, coverage, build directories, APK/AAB files, or local tooling.
- Keep authentication tokens purpose-bound, hashed at rest where applicable, short-lived, replay-safe, and transactionally consumed.
- Preserve WebAuthn origin/RP ID checks, PKCE and state binding, refresh-token rotation, session/device revocation, audit, and security-event invariants.
- Do not weaken Docker socket permissions or production security controls to simplify development.

## Development

- Use versioned PostgreSQL migrations; never edit an already-applied migration without accounting for its checksum and deployed state.
- Keep the OpenAPI contract and security/architecture documentation synchronized with backend behavior.
- Run format, lint, typecheck, build, dependency audit, relevant PostgreSQL tests, Flutter analysis/tests, and platform builds in proportion to the change.
- Real WebAuthn E2E must use `RUN_WEBAUTHN_E2E=1`, Chromium, a virtual authenticator, and an isolated PostgreSQL test database.
- Do not use destructive Git operations or force-push unless the repository owner explicitly authorizes them.

## Dependency stop rule

- When implementation reveals a missing backend API, data field, contract, client capability, runtime dependency, or other cross-component prerequisite, do not hide or bypass the dependency with a mock, temporary workaround, silent fallback, or self-invented product behavior.
- Record exactly what is missing, what work is blocked, and the smallest technically sufficient change that would unblock it.
- If resolving the dependency requires a product, architecture, security, privacy, data-model, compatibility, or user-experience decision, stop the affected work and request an explicit decision before implementing that choice.
- If the missing prerequisite is a purely mechanical technical requirement whose correct solution is already uniquely determined by existing architecture and recorded product rules, it may be proposed as the minimal unblocker, but must still be reported clearly rather than being hidden inside unrelated work.
- This rule is the default for all agent work. It may be ignored only when the repository owner explicitly authorizes an exception for the specific case.

## Delivery and change control

- Perform non-trivial work on a dedicated remote branch, not directly on the default branch.
- Push recoverable remote checkpoints after each coherent work slice; do not leave substantial completed work only in an ephemeral or local workspace.
- Do not report work as complete until the remote commit and pull-request URL exist and are included in the report.
- For complex, security-sensitive, or multi-component changes, obtain an independent review against the recorded acceptance criteria before presenting the work for approval.
- Run the relevant validation for the change and report the actual results, including controlled skips and any remaining failure.
- Never merge a pull request without the repository owner's explicit approval.

## Retired product scope

- GSM modems, SMS transport, and SMS integration have been removed from the Babylon product plan.
- Do not design, implement, procure, test, estimate, schedule, or create backlog work for GSM/SMS functionality unless the repository owner explicitly reactivates it.
- Do not list GSM/SMS work as a current goal, pending task, milestone, dependency, or remaining-work item in project summaries or status reports.
- Historical references may remain only when clearly identified as retired context; they are not evidence of current scope.
