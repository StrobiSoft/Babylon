# Babylon Voice Calling and Conference Specification

## Status

Product specification for the planned first-release Babylon voice-calling path. This document records product behaviour and architecture constraints discussed before implementation. It does **not** authorize premature implementation where required signaling, realtime transport, NAT traversal, media security, platform APIs or other dependencies are not yet ready.

Voice calling is intentionally **not translated** in the first release. AI/model processing is not part of the live audio path.

## Core model

1. The calling system must be designed as a **multi-participant call session** from the start.
2. The first implemented/released case may be a two-participant call, but two participants must not be hard-coded as an architectural limit.
3. A call/session has its own stable identity and a participant set. Participant state is modeled per participant so later conference calling does not require replacing the basic call model.
4. Conference calling is an extension of the same call-session model, not a separate incompatible calling subsystem.
5. The design goal is that conference capability can be added with bounded changes to client/session/signaling logic. This is an architectural goal, not a promise that multi-party media scaling will be trivial; the eventual media topology must be selected from measured technical evidence.

## Basic one-to-one calling

- A Babylon user can dial another user by telephone number whether or not the two users are Babylon contacts, provided Babylon policy does not currently block communication between them.
- The called party must receive enough identity information to make an informed decision. The UI may show the caller's display name, Babylon identity and/or telephone number according to the final privacy rules, and must clearly indicate when the caller is **not a contact**.
- The called party can accept or decline the call. Hold/wait behavior may be exposed where supported by the final call-state design.
- Accepting a call does **not** automatically create a Babylon contact relationship.
- Returning a missed or rejected Babylon call does **not** automatically create a Babylon contact relationship.
- This separation is deliberate: calling, messaging and durable contact status are distinct concepts.

## Dialing and route resolution

The telephone number is a user-facing addressing mechanism. Babylon may resolve the available communication route for that number.

1. If the number belongs to a reachable Babylon user, Babylon calling can be offered.
2. If the number is not registered with Babylon, the client may explain that the number is not available on Babylon and offer to continue using the device's ordinary carrier calling path.
3. Where a device has multiple SIM/eSIM lines, Babylon should expose the available carrier choice only to the extent permitted by the operating system. If the platform requires its own SIM/line chooser, Babylon must hand off to that chooser rather than pretending to control a line it cannot reliably select.
4. Carrier calling remains an operating-system/mobile-network function; Babylon must not claim guarantees it does not control.

## Mute

- A **Mute** control is required in the call architecture and UI.
- Mute disables the local microphone contribution while leaving incoming audio available.
- The user's mute state must always be clearly visible.
- Although useful in a two-party call, mute is especially important as a foundational participant-state primitive for later conference calls.

## Conference calling: two distinct join paths

The end state can be the same multi-participant room, but Babylon must model the two principal entry paths separately because their user intent and signaling flow differ.

### A. Merge an incoming call into the current call

Example: A and B are already talking. C calls A. A may choose, after seeing who is calling, to add C to the existing call rather than ending the A–B call.

The UI should be able to distinguish choices such as:
- decline the incoming call;
- hold the current call and answer separately, where supported;
- add/merge the incoming caller into the current call.

The merge operation adds the new participant to the existing call session; it must not silently create durable contact relationships.

### B. Invite a participant into the current call

Example: A and B are talking and decide that C's opinion is needed. A or another authorized participant explicitly invites C into the current session.

This is an invitation into an existing call session, not an independent incoming call that is later merged. The product and signaling model must preserve that distinction even though both paths can result in the same three-person session.

## Contacts and conference participation

- Conference participation must **not** require every participant to be a contact of every other participant.
- A participant can be invited by someone who knows or can reach that person even when other people already in the room do not know them.
- Joining the same conference does **not** automatically make previously unrelated participants Babylon contacts.
- An unknown participant should be clearly identifiable as not being in the local user's contacts, but that alone must not prevent participation.

## Blocking: direct communication

A Babylon block protects the user from direct Babylon communication by the blocked person.

When A has blocked B:
- B cannot send A direct Babylon messages;
- B cannot start a direct Babylon voice call to A;
- a direct Babylon communication attempt must not silently change or weaken the block;
- accepting or participating in some other allowed context must not automatically remove the block.

Whether carrier-call fallback should be offered when a dialed number resolves to a Babylon user who is currently blocked is an implementation/product decision that must be reviewed explicitly before release; Babylon must not silently use route fallback as a block-bypass mechanism.

## Blocking: conference exception / temporary communication channel

Blocking must not categorically prevent a user from voluntarily entering a shared conference that also contains a blocked person.

If a user is invited to, or attempts to join, a conference containing one or more people on that user's block list:

1. Babylon must warn the user **before joining** that the conference contains blocked participant(s).
2. The warning should identify the relevant participant(s) sufficiently for an informed decision.
3. The user chooses whether to join or decline.
4. Joining creates only a **temporary shared communication channel** for the lifetime of that common conference/session.
5. The block itself remains fully intact outside that shared session.
6. The conference does not make the blocked person a contact and does not reopen direct messaging or direct Babylon calling.
7. When the shared session ends, the temporary channel ends automatically; no separate cleanup action is required.

This supports legitimate mediated conversations—such as dispute resolution or reconciliation—without turning a block into an irreversible prohibition on the user's own future choices.

## Unblocking UX

- Removing a block must be approximately as easy to find as creating the block; it must not be buried deep in unrelated settings.
- Unblocking must remain a deliberate user action.
- A single lightweight confirmation is sufficient to prevent accidental taps, for example: **"Unblock this user?"**
- Conference participation, call acceptance, call return, message viewing or any other ordinary communication action must never implicitly remove a block.

## Relationship to messaging

- Messaging and calling have different contact-creation semantics.
- Under the current messaging concept, replying to an unknown sender may establish a Babylon contact relationship.
- Calling or returning a call specifically does **not** establish that durable contact relationship.
- This allows a user to return a call or verbally set a boundary without being forced to accept the caller as a contact.

## Privacy and identity principles

- The called party must be able to tell who is attempting to reach them to the extent allowed by the final privacy policy.
- Babylon should avoid the historical equivalent of an opaque hidden-number experience unless an explicit privacy feature is later designed and authorized.
- The exact combination of display name, Babylon ID and telephone number exposed to non-contacts remains subject to privacy/security review before implementation.

## Architecture and dependency gate

Before implementation begins, verify the real dependencies for:
- call signaling and realtime session state;
- NAT traversal and any STUN/TURN requirements;
- the one-to-one versus multi-party media topology;
- microphone/audio permissions and lifecycle on each supported platform;
- interruption, hold, audio-route and background behavior;
- authentication/authorization for call invitations and session membership;
- abuse/rate-limit controls for calls from non-contacts;
- secure media transport and key/session lifecycle;
- Android and later iOS/desktop platform restrictions around ordinary carrier calling and SIM/eSIM selection.

If a required dependency is missing or a material security/privacy/product choice remains ambiguous, stop for an explicit owner decision rather than inventing a temporary product behavior.

## First vertical-slice target

When dependencies permit implementation, the first voice-calling vertical slice should prove with real clients:

1. authenticated user A can call authenticated user B by telephone-number-based Babylon addressing;
2. B sees caller identity/non-contact status and can accept or decline;
3. accepted calls establish bidirectional untranslated audio;
4. mute works and its state is visible;
5. either party can end the call cleanly;
6. the call does not create a contact relationship merely because it occurred;
7. blocking prevents direct Babylon calls;
8. session/participant state is structured so a later third participant can be added without replacing the call model.

Conference join/merge behavior may be implemented in a later slice, but the first slice must not close off either conference entry path defined above.
