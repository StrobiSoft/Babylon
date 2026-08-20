# Babylon messaging E2EE and `.bab` attachment security

## Status and scope

This record captures approved architectural direction for Babylon messaging and attachment transport.
It does **not** select the final message E2EE protocol/library yet. Protocol selection, key-backup UX,
multi-device recovery details and the exact production cryptographic suite remain implementation
decisions that must be completed before production activation.

The intent is to make later client, delivery, attachment and API work compatible with end-to-end
encryption from the start rather than retrofit it after message transport is fixed.

## End-to-end encryption boundary

Ordinary private message and attachment content must be designed for end-to-end encryption (E2EE):

- encryption and decryption happen on trusted user endpoints;
- Babylon servers may route, queue and temporarily retain opaque encrypted payloads but must not hold
  content-decryption keys in usable form;
- server-visible metadata must be minimized and documented separately from encrypted content;
- message/attachment keys are endpoint-controlled and are not placed in application logs, analytics,
  audit payloads or server-side conversation history;
- removed/revoked devices must not decrypt new content after revocation has taken effect.

Transport TLS remains required even when E2EE is active; TLS protects the network hop while E2EE
protects message content from intermediary/server decryption.

## Key management direction

Babylon must not invent a custom message E2EE cryptographic protocol. A maintained, independently
reviewed protocol/library with suitable Android/Windows support and licensing must be selected before
production use.

The endpoint model must support:

- per-device cryptographic identity rather than treating one account as one permanent secret;
- authenticated establishment of peer/device sessions;
- key evolution/rotation without sending reusable raw long-term content keys through the server;
- forward-secrecy-oriented key derivation where supported by the selected protocol;
- explicit device addition/removal, reinstall, lost-device and compromise handling;
- replay, downgrade, out-of-order and concurrent-device tests;
- visible/auditable key-change events without exposing message content.

The exact rotation cadence and E2EE session state machine remain open until the reviewed protocol is
selected.

## Local Outbox implication

E2EE does not replace encryption at rest on the client. Pending Outbox content is sensitive before
and after network encryption, therefore persistent local Outbox storage must also be protected at
rest with client-held/platform-protected key material. A server-held Outbox decryption key is not an
acceptable privacy boundary.

## BSOP — Babylon Secure Object Protocol ("Bishop")

The approved Babylon object-containment protocol name is **BSOP — Babylon Secure Object Protocol**,
pronounced internally as **"Bishop"**.

Terminology:

- **BSOP** is the versioned protocol/specification that creates, authenticates, encrypts, transports
  and restores protected Babylon objects;
- **BAB object/container** is an object encoded according to BSOP;
- **`.bab`** is the file extension used for a serialized BAB container.

BSOP is a Babylon transport/container protocol, not a new cryptographic primitive. It must compose
reviewed standard cryptographic building blocks rather than inventing new ciphers, hashes, key
exchange algorithms or ratchets.

The scope is intentionally broader than ordinary files so the same object model can later carry
images, documents, audio or other binary payloads without changing the security boundary.

## BSOP processing order

For a locally selected attachment/object, the canonical sender-side order is:

1. identify and validate the source object;
2. run the approved sender-side malware/security classification while plaintext is still locally
   available;
3. choose the security policy (`ordinary`, `suspicious` or `blocked`, or the later approved equivalent);
4. if policy permits transport, optionally compress the plaintext payload;
5. create protected metadata;
6. encrypt and integrity-protect metadata and payload using endpoint-controlled key material;
7. serialize the result as a BAB container for transport.

Compression therefore happens **before encryption**. Encrypted ciphertext is not subsequently
compressed.

Content classified as blocked by mandatory product/platform/security policy is not made sendable by
placing it in a BAB container.

## Compression policy

BSOP v1 should use **lossless Zstandard (Zstd)** when compression materially reduces payload size.
Compression is an optimization, not a security property.

The sender client must not blindly recompress every object. Content that is already efficiently
compressed (for example many JPEG/PNG/video/archive inputs) may be stored with `compression = none`
when Zstd would provide no meaningful gain.

The exact threshold for choosing Zstd versus no compression remains a benchmarked implementation
parameter. The encoder must preserve the original bytes exactly after decrypt/decompress round-trip;
BSOP never applies lossy transformation to attachment content.

## BAB container security properties

A BAB container must be:

- versioned;
- encrypted end-to-end;
- integrity/authenticity protected with an approved AEAD construction;
- streamable/chunkable so large objects do not need to be held entirely in memory;
- resistant to truncation, chunk reordering, replay and metadata substitution;
- self-describing only to the minimum extent required to parse the protected envelope safely;
- opaque to Babylon servers except for explicitly approved routing/lifecycle metadata.

Each object should use fresh per-object content-encryption key material rather than reusing a single
long-lived content key. How that object key is derived or wrapped for one or multiple recipient
devices is delegated to the selected E2EE/key-management layer and must not expose a usable content
key to Babylon servers.

Large payloads should be protected in authenticated chunks. The exact chunk size is deliberately not
fixed until Android/Windows memory, throughput and resume benchmarks are available.

## BAB metadata boundary

The cleartext BAB header should contain only data required to recognize and safely parse the format,
for example a magic/version marker, algorithm-suite identifier, structural lengths and other strictly
necessary framing data.

Sensitive object metadata belongs inside the encrypted/authenticated region, including where
practical:

- original filename;
- original media/MIME classification;
- original size;
- integrity hash/reference data;
- sender-side malware/security classification;
- scanner/version/timestamp metadata when policy retains it.

Babylon servers should not need the original filename or payload type merely to route a BAB object.

## `.bab` containment role

The sender does not choose `.bab` as a cosmetic archive/compression option. The client security
pipeline decides when special containment is required.

For suspicious/high-risk but still policy-permitted content:

1. the sender client warns the sender as appropriate;
2. the system automatically uses the BSOP/BAB protected transport path;
3. the encrypted BAB object is transmitted without server-side content inspection;
4. the recipient client must not automatically decrypt/extract/open it;
5. the recipient receives an explicit risk warning before any extraction/open action;
6. the recipient action is deliberate and attributable in local/application security telemetry that
   does not record the attachment contents;
7. a recipient-side re-scan before extraction/open is recommended where the platform provides a
   reliable mechanism, because the sender scanner may be outdated or the sender device compromised.

An executable or otherwise dangerous original payload remains non-functional while it remains inside
its encrypted BAB representation. This is containment during storage/transport, not malware
neutralization: the original risk returns when the payload is restored to usable plaintext.

## Malware-scanning consequence of E2EE

Once attachment content is E2EE-encrypted, Babylon servers cannot perform meaningful antivirus or
content inspection without breaking the E2EE trust boundary. Therefore the primary pre-send malware
classification is a **sender-client responsibility**.

A recipient-side check remains defense in depth at the moment the payload becomes usable again. This
does not change the sender-side requirement that risky content be identified and contained before
leaving the sender device.

## Recipient restoration rule

For protected risky content, the recipient flow is conceptually:

`receive -> authenticate container -> decrypt protected metadata -> show classification/warning ->
explicit user decision -> optional local re-scan -> decrypt/decompress/restore original bytes`

The client must never implement an automatic `receive -> extract -> execute/open` path for content
that requires risk containment.

## User warning and responsibility model

Warnings and contractual terms are not a substitute for technical controls. Babylon's defensible
model is the combination of:

- pre-send client classification;
- automatic containment for suspicious/high-risk permitted files;
- E2EE opaque transport;
- no automatic extraction/execution;
- clear recipient warning and explicit user action;
- optional/available recipient re-scan;
- documented lifecycle, deletion and access controls.

The product must not promise that malware scanning guarantees safety. User-facing terms should state
that Babylon applies defined technical protections but cannot guarantee that every file is harmless,
and that opening content explicitly marked as risky is a conscious user action.

## Open items to revisit at the relevant master-plan stage

The following are intentionally preserved rather than prematurely fixed:

- reviewed message E2EE protocol/library selection;
- exact E2EE/object-key wrapping relationship;
- account/device verification UX and multi-device key distribution;
- key backup/recovery policy and consequences of lost keys;
- exact rotation/session-rekey rules;
- final BSOP v1 binary framing and algorithm suite;
- authenticated chunk size and resume semantics;
- benchmarked Zstd compression threshold;
- exact suspicious-versus-blocked file policy;
- platform-specific malware engines and update policy;
- recipient-side scanning capability and sandbox/open behavior;
- attachment size, retention, transfer-resume and temporary-storage limits;
- external cryptographic/security review before production activation.
