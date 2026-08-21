# Codex task — Stage 4 Soft Chat client vertical slice

## Objective
Implement the first real Soft Chat client flow on top of the already merged Stage II transport/delivery foundation.

## Required scope
1. Recipient selection/input suitable for the current backend contract.
2. Message composer for ordinary text messages.
3. Send through the existing delivery API/outbox/ACK path; do not bypass the verified delivery foundation.
4. Receive and display incoming messages locally.
5. Display sent and received messages in a minimal local conversation view.
6. Represent user-visible delivery state cleanly: sending, delivered, explicit pending, failure and retryable state where the existing backend contract supports it.
7. Preserve the existing durable/idempotent delivery semantics and restart-safe outbox behavior.
8. Structure composer state so future explicit translation/style modes can be added without redesigning the basic composer, but do not expose any non-functional mode selector.

## Explicitly out of scope
- AI/model processing
- translation
- wording-style transformation
- file/image attachments
- DHP/protected attachments
- voice messages or calls
- unrelated backend feature work

Soft Chat is the zero-transformation default path. It must not invoke the language/model pipeline.

## Dependency rule — mandatory repository default
Read and obey `AGENTS.md`. If implementation reveals a missing backend API, field, contract, client dependency or other component dependency:
- do not hide it with a mock, temporary product behavior, silent fallback or invented contract;
- document exactly what is missing, what it blocks, and the smallest change that would unblock the work;
- if resolving it requires a product, architecture, security, privacy, data-model or UX decision, STOP and request an explicit owner decision;
- deviate from this rule only if the repository owner explicitly authorizes an exception for that case.

## Validation
Add focused unit/widget/integration tests appropriate to the change, including send/receive, pending/error handling and supported restart/local-state behavior. Run and report exact results for:
- `flutter analyze`
- `flutter test`
- Android debug build
- Windows debug build

Do not claim end-to-end completion from mocks alone. Where two-real-client verification cannot be automated in the current environment, state exactly what remains to be proven and provide the smallest reproducible manual verification procedure.

## Delivery
Work only on branch `codex/stage4-soft-chat-client`. Push recoverable commits after coherent slices. Keep the PR draft until implementation and validation are complete. Do not merge. Post a completion comment containing commit SHAs, changed areas, exact validation results, remaining limitations, and any dependency that required owner review.

## Definition of done
Two real Babylon clients can exchange an ordinary text Soft Chat message using the existing guaranteed delivery foundation, with local conversation display and truthful delivery state, while Android and Windows client builds remain green. No AI, translation, attachment or voice feature is introduced as part of this task.
