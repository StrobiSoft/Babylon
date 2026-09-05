# Soft Chat capacity harness

This opt-in harness measures the real Fastify/PostgreSQL Soft Chat delivery and acknowledgement
path. It starts the production server, creates two accounts through the real invitation,
email-verification, WebAuthn, PKCE, callback, and token-exchange flow, then ramps virtual
authenticated HTTP clients through 100, 500, 1,000, 2,000, and 5,000 concurrent conversations.
The virtual clients share the two authenticated load-test identities; this measures delivery-path
capacity rather than the cost of provisioning thousands of passkeys.

The database is never truncated. Each run creates a uniquely named PostgreSQL schema, applies all
versioned migrations within it, and drops it during cleanup. Non-loopback PostgreSQL hosts are
rejected unless `ALLOW_REMOTE_LOAD_DATABASE=1` is explicitly set for a dedicated test instance.

Run from `babylon-project/`:

```bash
RUN_SOFT_CHAT_LOAD=1 \
TEST_DATABASE_URL='postgresql://babylon_test:babylon_test@127.0.0.1:5432/babylon_load' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome \
npm run load:soft-chat
```

Optional controls are `SOFT_CHAT_LOAD_STAGES`, `SOFT_CHAT_LOAD_MAX_ERROR_RATE` (default `0.01`),
`SOFT_CHAT_LOAD_MAX_P99_MS` (default `2000`), and `SOFT_CHAT_LOAD_OUTPUT_DIR`. The harness stops
escalating after the first failed stage. It fails a stage when authentication or message/ACK errors
exceed 1%, p99 end-to-end delivery/ACK latency exceeds two seconds, a duplicate is observed, or the
readiness endpoint becomes unhealthy.

Timestamped JSON, CSV, and text summaries are written under
`load-results/soft-chat/` by default. This generated directory is ignored by Git.
