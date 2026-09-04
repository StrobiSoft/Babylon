# Babylon Chronicle — seed note

## Purpose

When Babylon reaches its first public release — its practical "birth" as a publicly available product — create a human-readable Babylon Chronicle alongside the technical history.

The Chronicle is not a changelog and not a substitute for Git history. Its purpose is to preserve the program's life story: the major technical, product, business, community, integration, and other memorable milestones that may later be meaningful to look back on.

This idea itself arose from Babylon's first prenatal correction: before the product had even been publicly born, we noticed that emoji support — an obvious and important messaging capability — had not yet been explicitly included in the plan. The requirement was then added to the already-developed Soft Chat client work and the master plan. That incident prompted the idea that Babylon's notable life events should be deliberately preserved rather than reconstructed years later from commits and conversations.

## Presentation/content lock

A PDF seed was created for the future Chronicle. Its file format, typography, page layout and presentation may change later. The **wording, paragraph structure and intentional line breaks of the seed text are historical content and must not be silently rewritten or reflowed** when the final Chronicle is created. Any deliberate editorial change requires an explicit decision.

The future Chronicle's first page should contain a deliberately inconspicuous easter egg before the first visible chapter. It is not a security secret. The intended presentation is white text on a white background (or an equivalent visually hidden treatment), so an ordinary reader sees only empty space while the text remains present in the document. It should be excluded from normal printing where the final publication technology permits. Do not claim that only AI can discover it; source inspection, selection, accessibility tools, indexing or other processing may also expose it.

The hidden text records the personal spark that preceded Babylon's figurative "Big Bang" and explains the metaphor: a communication difficulty with a Belarusian girl supplied the spark from which the Babylon idea emerged; combustion needs combustible material, oxygen and ignition temperature, and an explosion is extremely rapid combustion. The spark is therefore narratively placed before "Még az ősrobbanás előtt".

## Locked seed text

The following text and line breaks are the seed content to preserve. The first block is intended to be visually hidden; the second block is the first visible Chronicle chapter.

### Hidden block

A szikra

A Babylon eredeti szikrája egy belarusz lánnyal való kommunikáció
nyelvi nehézségeinek leküzdése volt.

Az égéshez éghető anyag, oxigén és gyulladási hőmérséklet kell.
A robbanás rendkívül gyors égés.
A szikra szolgáltatta azt, ami az ősrobbanást elindította.

### First visible chapter

Még az ősrobbanás előtt

Babylon első prenatális javítása: az emoji.

A program még meg sem született, amikor egy már elkészült kliensrészt
vissza kellett nyitni, mert az emoji-támogatás nem szerepelt kifejezetten
a követelmények között.

Ez lett Babylon első születés előtti javítása - és ennek apropóján született
meg az ötlet, hogy a program élettörténetének nagy eseményeit tudatosan
megőrizzük egy külön krónikában.

## What belongs in the future Chronicle

Record only meaningful milestones, not routine commits. Examples may include the first public release, first real external user, first revenue or profit milestone, major technical breakthroughs, important external integrations or approvals, major security/product milestones, and other events that materially shape Babylon's story.

Until public release, this file acts only as a seed/reminder. At Babylon's public birth, create the actual Chronicle and use this note and the locked seed text as the starting point rather than treating this file as the finished publication.

## Prenatal milestone record — 2026-08-31 / 2026-09-01

The following entries were added after the locked seed text. They are historical notes for the future Chronicle and do not modify the presentation/content lock above.

### The human relay stopped being part of the protocol

The dedicated `NOEMI-BRIDGE` task queue in Babylon issue #40 completed its first end-to-end successful cycles. Noémi could issue a structured task, Codex could execute it through the dedicated ZooLab automation environment, and a structured result returned to the same durable GitHub queue.

This changed the collaboration model in a practical way: the project owner no longer had to act as a manual copy-and-paste relay between Noémi and Codex. Human authority over product decisions, security boundaries and merges remained unchanged; the mechanical relay work became machine-to-machine orchestration.

### The 500-client p99 problem became a capacity-shape problem

A blind, evidence-driven root-cause pass over the Soft Chat 500-client benchmark established a strong diagnostic model for the persistent roughly 3.2–3.6 second send-to-ACK p99 plateau. Across the measured checkpoints, p99 closely followed the time needed to drain almost the entire synchronous 500-message burst: approximately `p99 ≈ 495 / throughput` seconds.

The same analysis identified request fan-out and completion-relative pending polling as mechanisms capable of consuming the single Node.js server's effective capacity and feeding back on themselves under load. Earlier partial optimizations had reduced individual costs without proportionally improving the endpoint result, which strengthened the case that the dominant issue was broader than one SQL query or one pool wait.

This was a diagnostic milestone, not a declaration that the final root cause had been proven or fixed. The next intervention — event-driven, timeout-based pending long-polling, followed only if justified by bounded activity-write coalescing — was deliberately preregistered for controlled measurement against the established baseline discipline.

### Babylon acquired a web-client direction and a public story

The existing Babylon UX Lab was reactivated as the basis for a real web presence. The product direction was set explicitly: the website must not grow a second messenger backend or a parallel authentication system. After authentication, the Messenger area is intended to behave as another Babylon client using the existing Babylon backend and protocol boundaries.

The global website structure was defined around the Babylon landing page, a Messenger area, dynamic Login/Profile navigation, role-gated Admin access, and public Legal/Privacy material. The first public-facing brand narrative was also sharpened around the ideas `Communicate freely. Communicate with anyone.`, `Babylon. Ami összeköt.`, and the English line `Babel once divided languages. The Babylon app brings them together again.`

The homepage direction also reserved space to explain Babylon's security-first architecture at a high level — including the Multi-layer Bishop concept and the native `.BAB` container — and to present the language system as communication rather than literal word substitution: write in your own language, let the recipient read naturally in theirs, with tone/style handling as the product matures.
