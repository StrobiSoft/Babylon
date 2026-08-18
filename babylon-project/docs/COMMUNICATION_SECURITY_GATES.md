# Communication security acceptance gates

This document turns lessons from early Viber user failures and security incidents into Babylon
acceptance gates. It deliberately distinguishes a current defect, a missing regression check and a
future requirement. Passing a gate is required before the corresponding capability can ship; it is
not authorization to add the product feature.

GSM modems, SMS transport and SMS integration are retired scope. They are not a dependency,
fallback or future task unless the owner explicitly reverses that decision.

## Current surfaces and enforced controls

| Observed risk                                                                      | Babylon classification              | Required control and regression evidence                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A transient network failure looks like logout                                      | Current defect, corrected           | Bounded HTTP calls; `NETWORK_TIMEOUT` and `NETWORK_UNAVAILABLE` do not erase a valid refresh token; session restoration shows unavailable rather than signed out. Client tests cover all three behaviours.                                                                                                                                                               |
| A lost response leads to blind duplicate mutation                                  | Missing regression check, corrected | The client never automatically retries a mutation. A cancelled initial mutation completes under the flow-generation guard before a replacement starts; cancellation does not pretend to roll back an already sent request. The timeout test proves one send only. Any future automatic retry first requires a server-issued idempotency key and duplicate-delivery test. |
| Authentication or account data appears in recents, lock-screen previews or capture | Current protection gap, corrected   | Flutter covers content whenever inactive; Android sets `FLAG_SECURE`; Windows requests `WDA_EXCLUDEFROMCAPTURE`, checks the result and falls back to `WDA_MONITOR` with diagnostics. Widget and source-policy tests preserve these controls.                                                                                                                             |
| Onboarding transaction material remains in memory after the flow                   | Current defect, corrected           | E-mail, transaction token and state are cleared after successful exchange, logout, cancellation and terminal failure. Controller regression tests prove that resend cannot reuse them.                                                                                                                                                                                   |
| One phished admin capability controls unrelated operations                         | Current design weakness, deferred   | The existing bootstrap credential remains for deployment compatibility. Before any support UI or broader administration ships, an approved migration must introduce purpose-bound roles or credentials, phishing-resistant administrator authentication and cross-use tests without an insecure shared-token fallback.                                                   |

## Gates for capabilities that do not exist yet

### Telephone numbers and contacts

Before any phone or contacts code, dependency or platform permission is added:

1. The owner approves the exact user flow and data purpose; address-book upload is off by default.
2. Phone numbers are parsed and stored in one canonical international representation by a reviewed
   library, with country-context and malformed/ambiguous-number tests.
3. Permission is requested in context and denial leaves the rest of the application usable.
4. Contact discovery exposes no raw address book, provides revocation/deletion and never announces a
   user to contacts without a separate explicit consent.
5. Server and client tests cover duplicate numbers, recycled numbers, normalization collisions,
   consent withdrawal and enumeration resistance.

### Push notifications and background work

Before notification permission, a push SDK or background delivery service is added:

1. Notification opt-in is separate from messaging consent and can be revoked.
2. Lock-screen text is non-sensitive by default; sender, message, token, location and recovery data
   require an unlocked in-app view.
3. Deduplication, ordering, collapse and rate/burst limits are tested so reconnect cannot create
   notification storms.
4. Android and Windows lifecycle tests cover killed, suspended, offline and resumed states; measured
   battery/network budgets are documented before background polling is allowed.

### User media and location

Before an attachment, media picker, storage endpoint or location permission is added:

1. Every upload and read is authenticated and object-authorized; guessing an identifier or reusing a
   URL from another account must fail.
2. Transport uses TLS. Stored objects are private; any delegated URL is short-lived, purpose-bound
   and excluded from logs. File type, size, malware and metadata handling are defined and tested.
3. Location is a separate, one-time user action with no background collection. Denial and revocation
   are tested on both platforms.
4. Client caches, thumbnails, recents and backups have an approved retention and deletion policy.

### Multi-device end-to-end encryption

Before message content exists outside the current fake/local flow:

1. No custom cryptography is permitted. An independently reviewed protocol and maintained library,
   including license and platform support, must be approved.
2. The threat model defines server-visible metadata, identity keys, device keys, verification,
   backup/recovery and compromise behaviour without claiming protection that is not implemented.
3. Adding, removing, losing or restoring a device has explicit key-change UX. Removed devices cannot
   decrypt new content; key changes are visible and auditable without exposing message content.
4. Deterministic tests cover key rotation, concurrent devices, out-of-order delivery, replay,
   downgrade attempts, reinstall, lost device and recovery. An external security review is required
   before production activation.

## Change rule

The regression policy test allowlists every current Android permission, direct Flutter dependency and
backend route. It therefore fails when a new capability is introduced through those reviewed
surfaces. Generated platform manifests and transitive plugin permissions still require Android and
Windows release-build inspection. A future approved feature must replace the applicable blocked
assertion with its acceptance evidence in the same pull request.
