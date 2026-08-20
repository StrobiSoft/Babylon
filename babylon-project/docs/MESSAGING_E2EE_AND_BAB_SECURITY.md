# Babylon messaging E2EE and `.bab` attachment security

## Status and scope

This record captures approved architectural direction for Babylon messaging and attachment transport.
It does **not** select the final cryptographic protocol/library yet. Protocol selection, key-backup UX,
multi-device recovery details and the exact `.bab` binary format remain implementation decisions that
must be completed before production activation.

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

Babylon must not invent a custom E2EE cryptographic protocol. A maintained, independently reviewed
protocol/library with suitable Android/Windows support and licensing must be selected before
production use.

The endpoint model must support:

- per-device cryptographic identity rather than treating one account as one permanent secret;
- authenticated establishment of peer/device sessions;
- key evolution/rotation without sending reusable raw long-term content keys through the server;
- forward-secrecy-oriented key derivation where supported by the selected protocol;
- explicit device addition/removal, reinstall, lost-device and compromise handling;
- replay, downgrade, out-of-order and concurrent-device tests;
- visible/auditable key-change events without exposing message content.

The exact rotation cadence and protocol state machine remain open until the reviewed protocol is
selected.

## Local Outbox implication

E2EE does not replace encryption at rest on the client. Pending Outbox content is sensitive before
and after network encryption, therefore persistent local Outbox storage must also be protected at
rest with client-held/platform-protected key material. A server-held Outbox decryption key is not an
acceptable privacy boundary.

## `.bab` container role

`.bab` is a Babylon-controlled transport/isolation container concept. It is **not** a new
cryptographic primitive and does not make malware harmless.

For content placed into `.bab`:

- the payload is encrypted before transport so Babylon servers cannot inspect or extract it;
- the server handles the object as an opaque blob plus only the minimum routing/lifecycle metadata;
- executable or otherwise dangerous content remains non-executable while it is encrypted and
  encapsulated;
- compression, if used, is an implementation detail and is not the security property—the security
  boundary is authenticated encryption plus controlled extraction;
- the final format must be versioned and integrity-protected, and may carry non-secret metadata such
  as format version, ciphertext length and delivery identifiers as required by the protocol;
- decryption secrets must not be stored beside the ciphertext in a form usable by Babylon servers.

The exact binary/container layout, algorithm identifiers and multi-recipient key wrapping remain open
until the E2EE protocol is selected.

## Automatic classification of risky attachments

The sender does not choose `.bab` as a cosmetic archive option. The client security pipeline decides
when special containment is required.

Before sending an attachment, the sender-side client must perform the approved local checks available
for the platform, including file-type/structure validation and malware-aware scanning where
available. Based on policy, the client classifies the attachment, for example as ordinary, suspicious
or blocked.

For suspicious/high-risk but still policy-permitted content:

1. the sender client warns the sender as appropriate;
2. the system automatically places the payload into the protected `.bab` transport path;
3. the encrypted container is transmitted without server-side content inspection;
4. the recipient client must not automatically decrypt/extract/open it;
5. the recipient receives an explicit risk warning before any extraction/open action;
6. the recipient action is deliberate and attributable in local/application security telemetry that
   does not record the attachment contents;
7. a recipient-side re-scan before extraction/open is recommended where the platform provides a
   reliable mechanism, because the sender scanner may be outdated or the sender device compromised.

Content classified as blocked by mandatory product/platform/security policy is not sent merely by
wrapping it in `.bab`.

## Malware-scanning consequence of E2EE

Once attachment content is E2EE-encrypted, Babylon servers cannot perform meaningful antivirus or
content inspection without breaking the E2EE trust boundary. Therefore the primary pre-send malware
classification is a **sender-client responsibility**.

A recipient-side check remains defense in depth at the moment the payload becomes usable again. This
does not change the sender-side requirement that risky content be identified and contained before
leaving the sender device.

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

- reviewed E2EE protocol/library selection;
- account/device verification UX and multi-device key distribution;
- key backup/recovery policy and consequences of lost keys;
- exact rotation/session-rekey rules;
- final `.bab` binary format and naming/versioning rules;
- exact suspicious-versus-blocked file policy;
- platform-specific malware engines and update policy;
- recipient-side scanning capability and sandbox/open behavior;
- attachment size, retention, transfer-resume and temporary-storage limits;
- external cryptographic/security review before production activation.
