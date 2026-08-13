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
