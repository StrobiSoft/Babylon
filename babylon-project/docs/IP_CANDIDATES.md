# Babylon IP candidates

## Purpose

`IP` in this document means **Intellectual Property (szellemi tulajdon)**. It does **not** mean identity, identifier, IP address, or Internet Protocol.

An **IP candidate** is a Babylon product or technical idea that appears sufficiently original, distinctive, or commercially valuable to deserve an explicit intellectual-property review before detailed public disclosure or irreversible implementation choices.

The label is an early-warning marker, not a legal conclusion. It does **not** assert that an idea is novel, patentable, registrable, or unused by others. Those conclusions require an appropriate prior-art / rights search and, where warranted, professional legal review.

## Working rule

When design work produces a potentially independent Babylon technical mechanism, protocol, format, API structure, product name, or other protectable value:

1. mark it as an **IP candidate** as early as practical;
2. record a short description of what is distinctive and what technical/product value it provides;
3. avoid unnecessary detailed public disclosure until the protection question has been considered;
4. before material public disclosure, assess whether the appropriate treatment is copyright, trade-secret/confidential treatment, trademark/design protection, patent review, or no special protection;
5. where novelty matters, perform an appropriate prior-art / existing-rights search before making novelty claims;
6. if protection is likely to require material cost, flag the likely timing and cost category early enough for financial planning.

## Current candidates

### Bishop / BAB container and protected-object architecture

**Status:** IP candidate; no novelty or patentability claim has been made.

Babylon's planned protected-object architecture combines the internal Bishop/BAB container concept with modular sensitive-object handling. The evolving design includes DHP (Discrete Handling Protocol), container/fragment handling, integrity/fingerprint verification, delayed release of decryption key material after successful verification, and independently selectable protection layers such as visual trace/watermark and view-once access where applicable.

The cryptographic primitive itself is intentionally expected to use established, reviewed standards rather than a home-grown cipher. Potential Babylon-specific intellectual-property value, if any, lies in the architecture, protocol composition, container semantics, key lifecycle, protection-layer composition, and resulting technical behaviour—not merely in choosing a standard cipher.

Before detailed public specification or any claim of novelty, review the mature design against prior art and decide the appropriate protection strategy.

## Review timing

IP review is event-driven rather than tied only to a completion percentage. A candidate must be reconsidered whenever its design becomes concrete enough for meaningful comparison with existing technology, before detailed public disclosure, or before a design decision would make later protection materially harder. A broader project-level IP review should also occur before public release.
