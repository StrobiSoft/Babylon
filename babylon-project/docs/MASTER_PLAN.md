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
- [Authentication state machine](AUTH_STATE_MACHINE.md)
- [Language system architecture](LANGUAGE_SYSTEM_ARCHITECTURE.md)
- [Language-system implementation roadmap — GitHub Issue #1](https://github.com/StrobiSoft/Babylon/issues/1)

---

# Stage II — Guaranteed delivery and pending processing

**Approximate project range: 40% → 50%**

1. Implement `translation_pending` end-to-end.
2. Add short-lived encrypted translation jobs.
3. Add bounded automatic retries.
4. Configure explicit retry limits, timeouts, backoff and expiry.
5. Keep the client-side copy until delivery acknowledgement arrives.
6. Implement delivery acknowledgement semantics.
7. Delete transient server-side content after successful delivery.
8. Expire and securely delete abandoned jobs.
9. Complete handling of the public delivery states:
   - `delivered`
   - `delivered_after_repair`
   - `delivered_via_fallback`
   - `delivered_unchanged`
   - `translation_pending`
   - `invalid_input`

**Stage exit criterion:** no accepted message can disappear silently; every accepted message reaches a delivered or explicit pending state.

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
6. Test formal, everyday and casual styles.
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

1. Complete recipient selection and recipient-profile resolution.
2. Load and lock the recipient delivery language at the API boundary.
3. Complete client → API → language agent → gateway → model routing.
4. Return only independently validated results to the delivery path.
5. Complete recipient delivery and acknowledgement flow.
6. Complete client-side conversation logging without creating central server-side conversation history.
7. Complete profile-image handling.
8. Add the conversation partner language/flag UI indicator.
9. Complete wording-style selection: formal, everyday, casual.
10. Ensure same-language communication bypasses unnecessary translation/model work.
11. Add client-side voice dictation as an input peripheral: microphone speech recognition inserts editable text into the normal message composer; dictation never sends automatically, and after user review/editing the submitted message follows the ordinary text-processing path.
12. Add first-release voice messages without translation: record, send, receive and play the sender's original audio. When recipient and sender delivery languages differ, clearly warn that voice-message translation is not yet available and that the recipient will hear the original language; do not prohibit sending.
13. Integrate voice calling without translation, according to the product decision.
14. Complete the remaining Android user flows required for the intended first release.

**Stage exit criterion:** two real Babylon users can complete the intended communication flow end-to-end, including ordinary text communication and first-release untranslated voice messaging.

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
17. Define and verify voice-media security and lifecycle rules: authenticated access, transport protection, bounded size/duration, transient server-side retention where required, and deletion/expiry semantics without creating a central voice-message archive.
18. Run the complete authentication/security regression suite.
19. Resolve all release-blocking security findings.

**Stage exit criterion:** the complete functional system operates behind a verified production security boundary, including the first-release voice-message path.

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
10. Test client close/reopen and retained local state.
11. Test voice-message recording, interrupted upload, delivery, playback, expiry/deletion and cross-language warning behaviour.
12. Test client-side dictation review/edit/send behaviour and confirm that dictation cannot bypass the normal text-processing path.
13. Perform complete UI/UX defect review.
14. Fix crashes and edge cases.
15. Run security regression again after fixes.
16. Run performance regression after fixes.
17. Update documentation to the actually implemented topology and behaviour.
18. Remove obsolete planning language from normative documentation.
19. Record final architecture decisions and benchmark results.
20. Finalize Android release configuration.
21. Produce the Android release build.
22. Rebuild from a clean environment to prove reproducibility.
23. Test the Release Candidate comprehensively.
24. Fix remaining release-blocking defects.
25. Repeat the full release test suite.
26. Freeze the verified release build.

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
|                  50% | Guaranteed delivery/pending processing complete                           |
|                  60% | Real Pepper-hosted local AI integrated                                    |
|                  70% | Production model strategy benchmarked and selected                        |
|                  80% | Complete intended communication product integrated                        |
|                  90% | Production/security boundary verified                                     |
|                 100% | Verified Android release build ready for Google Play publication workflow |

## Current next task

**Stage II / Item 1 — Implement `translation_pending` end-to-end.**
