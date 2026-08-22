# Babylon Project — Master Plan

> **Estimated project completion: 40%**
>
> **Definition of 100%:** all function-affecting development is complete; the Android release build has been repeatedly tested and verified; no known release-blocking functional or security defect remains; the package is ready to enter the Google Play publication process. Google Play Console administration, store listing preparation and publication itself are outside this 100% definition.

## Purpose and maintenance rule

This document is the **current-state master plan** for Babylon. It intentionally lists **only work that is still outstanding**.

When a significant task or milestone is completed and recorded in the Babylon repository (commit, issue update, architecture record, benchmark record or equivalent project evidence):

1. remove the completed item from this active master plan;
2. keep the historical evidence in Git history / issues / project documentation;
3. update the estimated completion percentage at the top of this file;
4. preserve the ordering rule: the first remaining item is the next recommended task unless a documented dependency requires otherwise.

The master plan and the repository therefore have different roles:

- **Master plan:** what remains to be done, in priority order.
- **Repository history / issues / architecture records:** what has already been done and how it was verified.

### Dependency-ordering rule

New product capabilities are placed at the earliest stage where their prerequisites are already available and where implementing them will not force premature infrastructure or architecture work. Features that depend on later runtime, delivery, storage or security capabilities remain explicitly deferred until those dependencies are complete.

### Related project records

- [Babylon application README](../README.md)
- [Architecture](ARCHITECTURE.md)
- [Security architecture](SECURITY_ARCHITECTURE.md)
- [Communication modes and scaling decisions](COMMUNICATION_MODES_AND_SCALING.md)
- [Authentication state machine](AUTH_STATE_MACHINE.md)
- [Language system architecture](LANGUAGE_SYSTEM_ARCHITECTURE.md)
- [Voice calling and conference specification](VOICE_CALLING_AND_CONFERENCE_SPEC.md)
- [Language-system implementation roadmap — GitHub Issue #1](https://github.com/StrobiSoft/Babylon/issues/1)

---

# Stage II — Guaranteed delivery and baseline chat

**Approximate project range: 40% → 50%**

1. Implement the first real **Soft Chat** client flow on top of the completed delivery foundation: recipient selection, message composer, send, receive and local conversation display. Soft Chat is the default path and performs no translation, wording-style transformation or other model-mediated processing. The baseline composer and renderer must support ordinary Unicode emoji from the start, including mixed text+emoji and emoji-only messages, preserving them exactly as user-authored content rather than routing them through translation or AI processing.
2. Ensure the composer architecture treats every non-default transformation mode as explicit opt-in state and keeps the currently active mode continuously visible before send. Do not expose a mode as selectable until its processing path is actually functional. Keep the message-content model extensible beyond plain text so later expressive message types such as stickers/sticker packs can be added without redesigning the core composer or delivery contract; this is an extensibility requirement, not authorization to implement stickers in the baseline slice.
3. Build a repeatable Soft Chat load-test harness and establish the first empirical capacity baseline, including concurrent users, messages/second, p95/p99 latency, PostgreSQL pressure, API CPU/RAM, errors/retries and saturation behaviour. Include 100, 1,000, 5,000 and 10,000-user checkpoints where the test environment permits; higher checkpoints are evidence-driven rather than assumed capacity claims.
4. Complete `translation_pending` end-to-end by wiring the existing encrypted pending queue and retry worker into the real runtime and delivery path once the production model processor is available.
5. Activate the already bounded automatic retry worker in the real runtime once the production model processor is available.
6. Complete handling of the public delivery states:
   - `delivered`
   - `delivered_after_repair`
   - `delivered_via_fallback`
   - `delivered_unchanged`
   - `translation_pending`
   - `invalid_input`

**Dependency note:** Stage II items 4–5 require the real model processor/runtime integration planned in Stage III. Items 1–3 do not depend on the production model runtime and should be completed first. The transient delivery chain itself is complete once PR #22 passes its final PostgreSQL 17 validation and independent review.

**Stage exit criterion:** two real clients can exchange ordinary Soft Chat messages end-to-end, including Unicode emoji content, without AI/model availability, no accepted message can disappear silently, and every accepted processed message reaches a delivered or explicit pending state.

---

# Stage III — Pepper and the real local AI runtime

**Approximate project range: 50% → 60%**

1. Record the current 32 GB Pepper baseline.
2. Measure CPU-only execution.
3. Test Intel UHD 630 / Vulkan acceleration separately.
4. Install the second 32 GB memory module.
5. Run the full memory test.
6. Verify 64 GB total capacity and dual-channel operation.
7. Repeat the baseline workload and compare results.
8. Select the protected production-like model execution environment.
9. Install/configure Ollama or the selected equivalent runtime.
10. Integrate and smoke-test `gpt-oss:20b`.
11. Integrate and smoke-test `qwen3:8b`.
12. Prepare the reserve-model path without enabling it unnecessarily.
13. Reserve NVMe-backed active working storage for latency-sensitive future media processing, including speech recognition and speech synthesis workloads; bulk or completed media need not remain on NVMe.

**Stage exit criterion:** Babylon translation uses real local models on Pepper rather than only fake/stub engines, and the runtime layout does not block later latency-sensitive voice processing.

---

# Stage IV — Benchmarking and production model strategy

**Approximate project range: 60% → 70%**

1. Build a repeatable translation-quality benchmark set.
2. Test Hungarian, English and Belarusian comprehensively.
3. Test mixed-language input.
4. Test misspellings and noisy input.
5. Test short and long messages.
6. Test formal, everyday and casual styles as a separate output dimension: the user-selected style must be interpreted and applied by the AI language layer without changing semantic content or the explicitly selected target language.
7. Test wrong-language model output and recovery.
8. Measure latency.
9. Measure RAM usage.
10. Measure CPU / acceleration load.
11. Measure concurrent-request behaviour.
12. Run extended stability tests.
13. Benchmark **mixed Soft Chat + AI traffic** separately from pure model throughput and prove that AI saturation does not unnecessarily make Soft Chat unavailable.
14. Select final primary and secondary production model roles from evidence.
15. Record exact model versions, quantization and acceleration path.
16. Update architecture records with the measured deployment decision.

**Stage exit criterion:** production model ordering and execution configuration are evidence-based and reproducible, with model-assisted capacity measured separately from baseline Soft Chat capacity.

---

# Stage V — Complete the Babylon communication product

**Approximate project range: 70% → 80%**

1. Complete recipient-profile resolution beyond the baseline Soft Chat recipient selection.
2. Load recipient language/profile information for UI and for **explicitly selected translation modes**; recipient language alone must never silently force translation of a Soft Chat message.
3. Complete client → API → optional language agent → gateway → model routing for modes that explicitly request model processing. Soft Chat bypasses the language/model pipeline.
4. Return only independently validated model results to the delivery path when a model-assisted mode is active.
5. Complete the remaining recipient delivery and acknowledgement integration for model-assisted paths without changing the already verified Soft Chat delivery semantics.
6. Complete client-side conversation logging without creating central server-side conversation history.
7. Add first-release image and general file attachments: users can send and receive attached images and files alongside ordinary messages. Attachment binaries are transported unchanged. Attachment filenames/image filenames are preserved exactly and are never passed through the translation or wording-style pipeline. Text visibly embedded inside an image is not OCR-extracted or translated during ordinary message delivery. Attached document contents are likewise not translated automatically merely because the document is attached.
8. At the attachment integration point, preserve a modular protection-layer design so later protection choices do not require replacing the ordinary attachment transport. The first-release attachment UX and transport contracts must be able to represent independent, combinable protection flags without silently enabling them. Record the currently intended options as follows:
   - **DHP — Discrete Handling Protocol:** an explicitly selected enhanced-handling path for sensitive objects, separate from ordinary attachment delivery. The user-facing name intentionally emphasizes separate handling while also carrying a discretion/privacy association. The internal BAB/Bishop container mechanics remain implementation details and are not exposed as required user knowledge.
   - **Visual watermark / trace layer:** an optional image/visual-content protection mode that can add recipient- or transfer-specific visible or otherwise recoverable marking to discourage redistribution and improve traceability. It is not applicable to every file type and must therefore remain independent from DHP.
   - **View-once / self-expiring access:** an optional object-access policy in which opening starts or completes a short-lived access lifecycle and prevents ordinary reopening after the permitted view. Its implementation must be described in terms of access/key/cache lifecycle rather than claiming that already displayed pixels can be physically retracted.
   - **Screenshot/event alert:** where the operating system provides sufficiently reliable support, the client may detect or react to screenshot/capture events for protected visual content and surface an appropriate event/notification. Platform limitations must be explicit; unsupported platforms must not pretend to provide detection.
   - These layers may be selected independently or combined where the file type and platform support them. DHP must not become a monolithic bundle that forces watermarking, view-once behaviour or capture alerts.
9. Extend expressive messaging beyond the Stage II Unicode-emoji baseline only when product value justifies it. Preserve an explicit future path for **stickers and sticker packs** as distinct message content rather than pretending they are ordinary text characters. If implemented, sticker identity/versioning, pack lifecycle, local caching, sender/recipient rendering, safety/moderation implications and optional downloadable-pack behavior must be designed explicitly. The content model must remain open to later expressive-message ideas without making any unimplemented idea part of the release contract.
10. Complete profile-image handling.
11. Add the conversation partner language/flag UI indicator.
12. Complete user-controlled wording-style selection as an explicit AI-managed output mode: formal, everyday and casual are first-release modes; the client selects the mode, the language agent conveys that choice to the approved local model, and the model may alter wording/register only—not meaning, recipient, delivery language or product/security policy. Keep slang as a later extension.
13. Preserve the communication-mode visibility invariant: whenever translation, wording-style or another model-assisted mode is active, that state remains conspicuously visible at the composer until changed; Soft Chat remains the default zero-transformation state.
14. Ensure same-language communication bypasses unnecessary translation/model work unless AI wording-style transformation or another AI-assisted mode is explicitly selected. Cross-language Soft Chat likewise remains untranslated unless translation is explicitly selected.
15. Add client-side voice dictation as an input peripheral: microphone speech recognition inserts editable text into the normal message composer; dictation never sends automatically, and after user review/editing the submitted message follows the currently visible communication mode.
16. Add first-release voice messages without translation: record, send, receive and play the sender's original audio. When recipient and sender delivery languages differ, clearly warn that voice-message translation is not yet available and that the recipient will hear the original language; do not prohibit sending.
17. Integrate voice calling without translation according to the product decision and the dedicated [Voice calling and conference specification](VOICE_CALLING_AND_CONFERENCE_SPEC.md). Treat the first 1:1 call as the two-participant case of a multi-participant call-session model; include a visible mute control, telephone-number-based Babylon dialing independent of contact status, non-contact caller identity, and architecture that preserves both later conference-entry paths (merge an incoming caller into the current call, and explicitly invite a participant). Direct Babylon blocking also blocks direct Babylon calls, while voluntary conference participation with a blocked participant remains possible only after a clear pre-join warning and never implicitly removes the block or creates a contact relationship.
18. Complete the remaining Android user flows required for the intended first release.

**Expressive-content rule:** Unicode emoji are baseline user-authored text content and must survive input, transport, persistence and rendering unchanged. Future stickers/sticker packs are separate expressive content types and must remain additive and optional; their future introduction must not require breaking ordinary text/emoji message compatibility.

**Attachment translation rule:** ordinary image/file delivery is a transport feature, not a language-processing feature. Filenames, image filenames, text embedded in images and attached document contents remain exactly as supplied by the sender unless a future, separately invoked document/image translation feature is explicitly designed and authorized.

**Protected-attachment decision gate:** DHP, watermarking, view-once semantics and screenshot/capture handling are recorded product directions, not implementation authorization for an unreviewed security protocol. Before implementation begins, define the exact cryptographic/container semantics, key lifecycle, platform capabilities, performance cost and user-visible guarantees. If a material architectural choice is ambiguous, stop and obtain an explicit product decision rather than silently selecting one.

**Stage exit criterion:** two real Babylon users can complete the intended communication flow end-to-end, including default Soft Chat with emoji, explicitly selected model-assisted text modes, image/file attachment exchange and first-release untranslated voice messaging. Sticker/sticker-pack support is required only if explicitly promoted into the first-release scope by a later product decision.

---

# Stage VI — Security hardening and production boundary

**Approximate project range: 80% → 90%**

1. Test prompt-injection and instruction-confusion attacks.
2. Prove that the sender cannot override security/product language policy in model-assisted modes.
3. Prove that clients cannot request arbitrary model IDs.
4. Prove that model output cannot alter product/security policy.
5. Verify wrong-language output is never delivered when translation mode requires a specific target language.
6. Test complete model-engine outage and prove Soft Chat remains available unless an independent delivery dependency is also unavailable.
7. Test processing timeouts and retry exhaustion.
8. Verify translation-job encryption.
9. Verify expiry and deletion of transient jobs.
10. Verify that no central conversation archive is introduced.
11. Verify logs contain neither message text nor secrets.
12. Add the production reverse-proxy route.
13. Configure TLS.
14. Configure rate limits and request-size limits.
15. Isolate model endpoints from clients/public access.
16. Prove that no client can directly reach Ollama or the model gateway.
17. Define and verify image/file attachment security and lifecycle rules: authenticated upload/download, transport protection, bounded file size, allowed/blocked content handling, malware-aware validation where appropriate, transient server-side retention where required, deletion/expiry semantics, and preservation of the sender-supplied filename without translating it. For every implemented optional protection layer (including DHP, visual watermark/trace, view-once and screenshot/capture event handling), verify its precise guarantee separately, verify supported combinations, verify safe fallback on unsupported platforms, and benchmark the additional CPU/RAM/storage/I/O/network cost so protection layers are not retained merely for cosmetic security value.
18. Define and verify voice-media security and lifecycle rules: authenticated access, transport protection, bounded size/duration, transient server-side retention where required, and deletion/expiry semantics without creating a central voice-message archive.
19. Validate public-scale realtime transport so large connected-user counts do not depend on aggressive empty polling; preserve Stage II ACK/idempotency/restart/E2EE boundaries when introducing server-push/realtime transport.
20. Define measured GREEN/YELLOW/RED capacity thresholds and an expansion runbook covering local horizontal scaling and optional rented/cloud burst capacity before public-scale release.
21. Run the complete authentication/security regression suite.
22. Resolve all release-blocking security findings.

**Stage exit criterion:** the complete functional system operates behind a verified production security boundary, including the first-release file/image and voice-message paths, and the deployment has evidence-based capacity/expansion controls rather than a single-machine assumption.

---

# Stage VII — Release Candidate to DONE

**Approximate project range: 90% → 100%**

No new foundational feature should normally enter this stage. The focus is proving release readiness.

1. Run full end-to-end Android testing.
2. Test on multiple real Android devices where practical.
3. Test clean installation.
4. Test registration, login, passkey, logout and re-login.
5. Test network interruption and recovery.
6. Test Pepper/backend/model restart scenarios.
7. Test Soft Chat independently from model-assisted multilingual delivery, including mixed text+emoji and emoji-only message round trips.
8. Test multilingual translation-mode message delivery.
9. Test long messages and malformed/invalid input.
10. Test model failure, pending state and eventual acknowledgement while confirming ordinary Soft Chat remains independent of model availability.
11. Test client close/reopen and retained local state.
12. Test image/file attachment upload, interrupted transfer, retry, delivery, download/open flow, expiry/deletion and filename preservation. Confirm that filenames and text embedded in images are not translated automatically. Where optional protection layers are implemented, include DHP, watermark/trace, view-once and supported screenshot/capture-event combinations in release-candidate testing.
13. If stickers/sticker packs have been explicitly promoted into release scope, test their identity/versioning, caching, rendering, unavailable-pack behavior and compatibility with ordinary text/emoji conversations.
14. Test voice-message recording, interrupted upload, delivery, playback, expiry/deletion and cross-language warning behaviour.
15. Test client-side dictation review/edit/send behaviour and confirm that dictation cannot bypass the currently visible communication mode.
16. Run measured load tests at the release-candidate topology and compare against the recorded capacity baseline/thresholds.
17. Perform complete UI/UX defect review.
18. Fix crashes and edge cases.
19. Run security regression again after fixes.
20. Run performance regression after fixes.
21. Update documentation to the actually implemented topology and behaviour.
22. Remove obsolete planning language from normative documentation.
23. Record final architecture decisions and benchmark results.
24. Finalize Android release configuration.
25. Produce the Android release build.
26. Rebuild from a clean environment to prove reproducibility.
27. Test the Release Candidate comprehensively.
28. Fix remaining release-blocking defects.
29. Repeat the full release test suite.
30. Freeze the verified release build.

**Stage exit criterion — Babylon Project = 100% / DONE:** the functionally complete Android release package has been repeatedly verified and is ready to enter the Google Play publication process.

---

# Post-v1 — Translated voice-message pipeline

This capability is intentionally outside the first-release 100% definition. Its prerequisites are the verified text language engine, reliable delivery semantics, the real Pepper-hosted model runtime, first-release voice-message transport, and the production media-security/lifecycle rules.

1. Convert recorded voice to a reviewable transcript using speech recognition.
2. Preserve a user-review/correction path where product UX requires sender confirmation before translation.
3. Feed the approved transcript through the existing Babylon text translation and independent validation pipeline rather than creating a separate translation policy.
4. Convert only validated translated text to recipient-language speech using a neutral synthetic voice; speaker voice cloning is explicitly out of scope for the initial translated-voice implementation.
5. Use NVMe-backed active working storage for latency-sensitive speech-recognition, translation and speech-synthesis processing; move or delete completed/transient media according to the media lifecycle policy rather than treating NVMe as permanent message storage.
6. Add failure and pending semantics for speech recognition and speech synthesis without allowing media jobs to disappear silently.
7. Benchmark end-to-end latency, concurrency, CPU/RAM/storage pressure and perceived output quality before enabling the feature generally.

**Post-v1 exit criterion:** a voice message can be transformed into independently validated translated text and delivered as recipient-language synthetic speech without weakening Babylon's delivery, privacy or security guarantees.

---

## Progress scale

| Estimated completion | Meaning                                                                   |
| -------------------: | ------------------------------------------------------------------------- |
|                  30% | Baseline when this master plan was created                                |
|                  40% | Language engine complete                                                  |
|                  50% | Guaranteed delivery and baseline Soft Chat complete                       |
|                  60% | Real Pepper-hosted local AI integrated                                    |
|                  70% | Production model strategy benchmarked and selected                        |
|                  80% | Complete intended communication product integrated                        |
|                  90% | Production/security/scaling boundary verified                             |
|                 100% | Verified Android release build ready for Google Play publication workflow |

## Current next task

**Stage II / Item 1 — Implement the first real Soft Chat client flow on top of the completed delivery foundation, after PR #22 passes PostgreSQL 17 CI and independent review.**