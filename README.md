# Babylon

Babylon is a multi-platform Flutter client and a security-focused authentication backend. The implemented vertical slice covers invitation onboarding, e-mail verification, WebAuthn/passkeys, PKCE-bound native return, explicit device sessions, refresh-token rotation and revocation, recovery foundations, security events, and append-only auditing.

The application lives in [`babylon-project/`](babylon-project/README.md). The existing repository history also contains the independent `services/zoolab-monitor` operational component; it is not a Babylon application dependency. The local `services/babylon-status` service is explicitly excluded from this repository.

## Components

- `babylon-project/backend/`: Node.js 24, TypeScript, Fastify, SimpleWebAuthn, and PostgreSQL 17.
- `babylon-project/backend/migrations/`: versioned, checksummed database migrations.
- `babylon-project/backend/public/`: browser-side WebAuthn flow.
- `babylon-project/client/`: Flutter client targeting Android and Windows.
- `babylon-project/docs/`: architecture, security model, state machine, and OpenAPI 3.1 contract.
- `babylon-project/compose.yaml`: local PostgreSQL, Mailpit, and backend environment.

## Prerequisites

- Docker Engine with Docker Compose v2 for the complete local stack.
- Node.js 24 and npm for direct backend development.
- Flutter 3.44 or a compatible stable release for the client.
- Android SDK and JDK 21 for Android builds.

## Local development

```sh
cd babylon-project
cp .env.example .env
# Replace all marked placeholders with local-only values.
docker compose config
docker compose up --build -d
docker compose ps
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

The committed `.env.example` documents the required variable names. Never commit the resulting `.env`, credentials, signing material, database files, or generated build output.

## Validation

Backend static checks:

```sh
cd babylon-project
npm ci
npm run format:check
npm run lint
npm run check
npm run check:test
npm run build
npm audit --audit-level=high
```

Database integration tests require a dedicated disposable PostgreSQL database through `TEST_DATABASE_URL`. Flutter checks are:

```sh
cd babylon-project/client
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
flutter build apk --debug
```

See the [application README](babylon-project/README.md) for the full Compose, migration, WebAuthn E2E, configuration, and production-boundary documentation.
