# Babylon Project — Master Plan

> **Estimated project completion: 43%**
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

### Progress-estimation rule

The completion percentage is a planning estimate against the **currently approved first-release scope**, not a linear count of commits, files or checklist items. When new first-release capabilities or mandatory security requirements are accepted, the denominator grows; therefore substantial completed work may produce only a small percentage increase or may temporarily leave the estimate unchanged. The current 43% estimate reflects both the completed language-system foundation and the expanded delivery, E2EE, attachment/BSOP, voice and release-security scope now required for the first production-ready build.

### Dependency-ordering rule

New product capabilities are placed at the earliest stage where their prerequisites are already available and where implementing them will not force premature infrastructure or architecture work. Features that depend on later runtime, delivery, storage or security capabilities remain explicitly deferred until those dependencies are complete.

Security architecture that constrains wire formats, durable client state or server trust boundaries must be decided **before** those interfaces become expensive to retrofit. In particular, message E2EE and the BSOP/`.bab` attachment boundary are cross-stage prerequisites rather than Stage VI cleanup work.

### Related project records

- [Babylon application README](../README.md)
- [Architecture](ARCHITECTURE.md)
- [Security architecture](SECURITY_ARCHITECTURE.md)
- [Authentication state machine](AUTH_STATE_MACHINE.md)
- [Language system architecture](LANGUAGE_SYSTEM_ARCHITECTURE.md)
- [Messaging E2EE and BAB security](MESSAGING_E2EE_AND_BAB_SECURITY.md)
- [Communication security acceptance gates](COMMUNICATION_SECURITY_GATES.md)
- [Language-system implementation roadmap — GitHub Issue #1](https://github.com/StrobiSoft/Babylon/issues/1)

---

# Stage II — Guaranteed delivery and pending processing

**Approximate project range: 40% → 50%**

1. Complete `translation_pending` end-to-end by wiring the existing encrypted pending queue and retry worker into the real runtime and delivery path once the production model processor is available.
2. Activate the already bounded automatic retry worker in the real runtime once the production model processor is available.
3. Finish the durable client Outbox so the client-side source copy survives restart and remains recoverable until explicit delivery acknowledgement; close the current correctness hardening around late acknowledgements, duplicate acknowledgements and serialized durable writes.
4. Protect persistent Outbox content **at rest** with client-held/platform-protected key material. Message text, `.tmp` files and `.bak` files must not remain as plaintext durable storage; corruption or authentication failure must fail closed.
5. Implement delivery acknowledgement semantics end-to-end, including idempotent late/duplicate ACK handling and the rule that client content is removed only after verified acknowledgement.
6. Before real message content leaves the current fake/local flow, select and approve the maintained, independently reviewed E2EE protocol/library and freeze the minimum interoperability contract: per-device identity, authenticated session establishment, key evolution/rotation, forward-secrecy expectations, removed-device behaviour, recovery/lost-device semantics, replay/downgrade handling and documented server-visible metadata. Babylon must not invent custom cryptography.
7. Delete transient server-side content after successful delivery.
8. Expire and securely delete abandoned jobs in the running system.
9. Complete handling of the public delivery states:
   - `delivered`
   - `delivered_after_repair`
   - `delivered_via_fallback`
   - `delivered_unchanged`
   - `translation_pending`
   - `invalid_input`

**Dependency note:** Stage II items 1–2 require the real model processor/runtime integration planned in Stage III. Until that dependency is available, the actionable delivery sequence is items 3–6. E2EE protocol/library selection is required before the later real client-to-recipient content path is activated.

**Stage exit criterion:** no accepted message can disappear silently; durable client state is protected at rest; delivery acknowledgement semantics are defined and robust; and the production message path has an approved E2EE contract before real content transport is activated.

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
6. Test formal, everyday and casual styles as a separate output dimension: the user-selected style must be interpreted and applied by the AI language layer without changing semantic content or the locked recipient language.
7. Test wrong-language model output and recovery.
8. Measure latency.
9. Measure RAM usage.
10. Measure CPU / acceleration load.
11. Measure concurrent-request behaviour.
12. Run extended stability tests.
13. Select final primary and secondary production model roles from evidence.
14. Record exact model versions, quantization and acceleration path.
15. Update architecture records with the measured deployment decision.

**Stage exit criterion:** production model ordering and execution configuration are evidence-based and reproducible.

---

# Stage V — Complete the Babylon communication product

**Approximate project range: 70% → 80%**

1. Implement the approved multi-device E2EE message-content path using the reviewed protocol/library selected earlier. Babylon servers may route, queue and temporarily retain encrypted payloads but must not receive usable content-decryption keys.
2. Complete recipient selection and recipient-profile resolution.
3. Load and lock the recipient delivery language at the API boundary.
4. Complete client → API → language agent → gateway → model routing.
5. Return only independently validated results to the delivery path.
6. Complete recipient delivery and acknowledgement flow over the E2EE-compatible transport.
7. Complete client-side conversation logging without creating central server-side conversation history; locally persisted conversation content must follow the approved client-held encryption-key model.
8. Add first-release image and general file attachments. Ordinary allowed attachment payloads remain byte-for-byte unchanged as user content. Attachment filenames/image filenames are preserved exactly and are never passed through the translation or wording-style pipeline. Text visibly embedded inside an image is not OCR-extracted or translated during ordinary message delivery. Attached document contents are likewise not translated automatically merely because the document is attached.
9. Implement **BSOP — Babylon Secure Object Protocol (“Bishop”)** for suspicious/high-risk but policy-permitted attachments. `.bab` is the BSOP container extension, selected automatically by the client security pipeline rather than by the user as a compression option. The sender-side client classifies the original object before encryption; BSOP may apply lossless Zstandard compression when beneficial, then authenticated encryption/integrity protection. The server treats the resulting object as opaque and cannot extract or malware-scan the encrypted payload. The recipient must not automatically extract/open risky `.bab` content and must receive an explicit warning before deliberate extraction/opening.
10. Define BSOP object framing and versioning without inventing cryptographic primitives: magic/version fields, cipher/compression identifiers, authenticated metadata boundary, chunk/stream rules for large objects, original-name/MIME/hash placement, per-object content key handling and multi-recipient/device key wrapping through the approved E2EE layer.
11. Complete profile-image handling.
12. Add the conversation partner language/flag UI indicator.
13. Complete user-controlled wording-style selection as an AI-managed output layer: formal, everyday and casual are first-release modes; the client selects the mode, the language agent conveys that choice to the approved local model, and the model may alter wording/register only—not meaning, recipient, delivery language or product/security policy. Keep slang as a later extension.
14. Ensure same-language communication bypasses unnecessary translation/model work unless AI wording-style transformation is explicitly required by the selected mode.
15. Add client-side voice dictation as an input peripheral: microphone speech recognition inserts editable text into the normal message composer; dictation never sends automatically, and after user review/editing the submitted message follows the ordinary text-processing path.
16. Add first-release voice messages without translation: record, send, receive and play the sender's original audio. When recipient and sender delivery languages differ, clearly warn that voice-message translation is not yet available and that the recipient will hear the original language; do not prohibit sending.
17. Integrate voice calling without translation, according to the product decision.
18. Complete the remaining Android user flows required for the intended first release.

**Attachment translation rule:** ordinary image/file delivery is a transport feature, not a language-processing feature. Filenames, image filenames, text embedded in images and attached document contents remain exactly as supplied by the sender unless a future, separately invoked document/image translation feature is explicitly designed and authorized. BSOP containment may transform the **transport representation** while preserving the original object bytes for authorized restoration.

**Stage exit criterion:** two real Babylon users can complete the intended communication flow end-to-end over the approved E2EE boundary, including ordinary text communication, image/file attachment exchange, BSOP-contained risky attachment handling and first-release untranslated voice messaging.

---

# Stage VI — Security hardening and production boundary

**Approximate project range: 80% → 90%**

1. Test prompt-injection and instruction-confusion attacks.
2. Prove that the sender cannot override recipient delivery language.
3. Prove that clients cannot request arbitrary model IDs.
4. Prove that model output cannot alter product/security policy.
5. Verify wrong-language output is never delivered.
6. Test complete model-engine outage.
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
17. Verify message E2EE under the explicit threat model: server cannot decrypt content; device add/remove/reinstall/loss/recovery semantics behave as documented; removed devices cannot decrypt new content; key rotation/evolution, concurrent devices, out-of-order delivery, replay and downgrade attempts have deterministic regression coverage.
18. Obtain an external cryptographic/security review before production E2EE activation and resolve all release-blocking findings from that review.
19. Define and verify image/file attachment security and lifecycle rules: authenticated upload/download, transport protection, bounded file size, ordinary/suspicious/blocked handling, sender-side malware-aware validation, transient server-side retention where required, deletion/expiry semantics, and preservation of the sender-supplied filename without translating it.
20. Verify BSOP/`.bab` security properties: authenticated-encryption failure is fail-closed; server-side content remains opaque; risky objects never auto-extract/auto-execute; sender classification and recipient warning are enforced; optional recipient re-scan is defense in depth rather than a claim that the sender scan guarantees safety; temporary and cached plaintext created during extraction follows explicit deletion rules.
21. Define and verify voice-media security and lifecycle rules: authenticated access, transport protection, bounded size/duration, transient server-side retention where required, and deletion/expiry semantics without creating a central voice-message archive.
22. Run the complete authentication/security regression suite.
23. Resolve all release-blocking security findings.

**Stage exit criterion:** the complete functional system operates behind a verified production security boundary, including reviewed E2EE, BSOP-contained attachment handling, the first-release file/image path and the voice-message path.

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
7. Test multilingual message delivery.
8. Test long messages and malformed/invalid input.
9. Test model failure, pending state and eventual acknowledgement.
10. Test client close/reopen and retained local state, including encrypted Outbox recovery.
11. Test E2EE across at least two users and multiple-device/reinstall/lost-device/key-change scenarios required by the approved threat model; confirm that the server has no usable content-decryption capability.
12. Test image/file attachment upload, interrupted transfer, retry, delivery, download/open flow, expiry/deletion and filename preservation. Confirm that filenames and text embedded in images are not translated automatically.
13. Test BSOP/`.bab` end-to-end: sender classification, conditional Zstandard compression, encrypted opaque transport, interrupted/resumed transfer, authentication/tamper failure, recipient warning, deliberate extraction/opening and restoration of the exact original object.
14. Test voice-message recording, interrupted upload, delivery, playback, expiry/deletion and cross-language warning behaviour.
15. Test client-side dictation review/edit/send behaviour and confirm that dictation cannot bypass the normal text-processing path.
16. Perform complete UI/UX defect review.
17. Fix crashes and edge cases.
18. Run security regression again after fixes.
19. Run performance regression after fixes.
20. Update documentation to the actually implemented topology and behaviour.
21. Remove obsolete planning language from normative documentation.
22. Record final architecture decisions and benchmark results.
23. Finalize Android release configuration.
24. Produce the Android release build.
25. Rebuild from a clean environment to prove reproducibility.
26. Test the Release Candidate comprehensively.
27. Fix remaining release-blocking defects.
28. Repeat the full release test suite.
29. Freeze the verified release build.

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
|                  43% | Current recalibrated estimate with expanded v1 security/product scope     |
|                  50% | Guaranteed delivery/pending processing and E2EE contract complete         |
|                  60% | Real Pepper-hosted local AI integrated                                    |
|                  70% | Production model strategy benchmarked and selected                        |
|                  80% | Complete intended communication product integrated over E2EE/BSOP         |
|                  90% | Production/security boundary externally reviewed and verified             |
|                 100% | Verified Android release build ready for Google Play publication workflow |

## Current next task

**Stage II / Item 3 — finish the durable client Outbox hardening and validation; then complete client-side at-rest encryption before advancing to the remaining delivery/E2EE prerequisites.**
