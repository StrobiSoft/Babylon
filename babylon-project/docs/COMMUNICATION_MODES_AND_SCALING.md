# Babylon communication modes and scaling decisions

Status: adopted product/architecture direction

Date adopted: 2026-08-21

## 1. Default communication mode: Soft Chat

Babylon's default communication path is a direct, untransformed chat mode provisionally named **Soft Chat**.

Soft Chat means:

- the sender's submitted message is delivered without translation;
- no wording-style transformation is applied;
- no rewriting, summarization or other model-mediated content processing is performed;
- no AI/model request is required merely to send a message;
- the message still uses the normal authenticated Babylon delivery path, Outbox, acknowledgement/retry semantics, later E2EE, routing and lifecycle controls.

The model-processing layer is therefore optional functionality above the baseline communication system, not a prerequisite for communication.

If the recipient does not understand the sender's language, that alone does not authorize Babylon to translate automatically. Translation is an explicit user-selected mode/action.

## 2. AI-assisted modes are explicit opt-in transformations

Translation, wording-style transformation and future AI-assisted processing are optional modes layered on top of the baseline chat path.

The exact product names may change before release, but the invariant is fixed:

> No transformation mode is active merely because the user opened a conversation or started typing. Soft Chat is the default until the user explicitly selects another mode.

At minimum the product model distinguishes:

- Soft Chat — no model transformation;
- translation — explicit language transformation;
- wording/style transformation — explicit register/style modification without semantic change;
- future AI-assisted modes — only when separately designed and authorized.

## 3. Active mode must remain continuously visible

A selected non-default mode must be continuously and conspicuously visible at the message composer.

The user must not have to remember an earlier toggle or inspect a settings page to know whether translation/style/AI processing is active. The active mode indicator belongs in or immediately adjacent to the compose surface.

This is a correctness/UX requirement, not decoration. Users may intentionally use different registers with different recipients, and a forgotten transformation mode can produce unintended communication.

The final UI design may change, but it must preserve these properties:

- the current mode is visible before sending;
- switching mode produces an immediately visible state change;
- Soft Chat is clearly distinguishable from transformed modes;
- the send action never silently changes the processing mode.

## 4. Soft Chat is also the baseline capacity path

Soft Chat deliberately bypasses model inference. This reduces latency, compute cost, queue pressure and failure surface for the large class of messages that need no transformation.

It does **not** bypass Babylon's network/API/delivery/security infrastructure. The efficiency gain comes from avoiding model-processing work, not from bypassing delivery correctness or security controls.

Capacity planning must therefore measure Soft Chat and model-assisted traffic separately.

## 5. Viral-load and scaling assumption

Babylon must be designed for the possibility that adoption is discontinuous rather than gradual. A successful public release may produce a rapid step increase in concurrent users and message traffic.

The architecture must not require a redesign merely because the single Pepper deployment is outgrown.

The target direction is:

> **local-first, horizontally scalable, cloud-burst capable**

This means:

- Pepper/local infrastructure remains a valid development, reference and production node;
- stateless or horizontally scalable API/delivery components should be separable into multiple nodes when load requires it;
- database, realtime transport and model-inference capacity must be measurable independently;
- optional rented/cloud capacity may absorb burst traffic without forcing Babylon's core architecture to change;
- local AI nodes and future rented GPU capacity may coexist behind a controlled model-processing queue/gateway;
- no public-scale assumption may depend on one machine being permanently sufficient.

## 6. Realtime transport and polling pressure

A large number of connected users must not create avoidable request load through aggressive empty polling.

The current HTTP pending-message API is a valid delivery foundation, but public-scale realtime delivery must evaluate server-push/realtime mechanisms (for example WebSocket or an equivalent audited design) before large-scale deployment.

The choice must preserve the Stage II delivery invariants: durable identity, ACK semantics, restart safety, transient server content and later E2EE compatibility.

## 7. Mandatory capacity baseline before public-scale release

Before Babylon is treated as ready for significant public growth, establish a repeatable load-test harness and record empirical capacity curves.

At minimum measure separately:

### Soft Chat

- concurrent connected users;
- active conversations;
- messages per second;
- p50/p95/p99 end-to-end latency;
- API CPU and RAM;
- PostgreSQL CPU, connections, lock waits and transaction latency;
- network throughput;
- error/retry rate;
- queue/backlog growth;
- restart/recovery behaviour under load.

Initial synthetic checkpoints should include, where infrastructure permits:

- 100 users;
- 1,000 users;
- 5,000 users;
- 10,000 users;
- 20,000 users or the first clearly demonstrated saturation point.

These are benchmark checkpoints, not pre-declared capacity claims.

### Mixed Soft Chat + AI traffic

Measure model-assisted traffic independently from baseline chat traffic:

- AI requests per second;
- input/output token volume where applicable;
- queue depth and waiting time;
- model latency and throughput;
- CPU/GPU/VRAM/RAM pressure;
- effect of AI saturation on Soft Chat latency;
- admission/backpressure behaviour when model capacity is exhausted.

A saturated AI subsystem must not unnecessarily make Soft Chat unavailable.

## 8. Scaling decision thresholds

Operational thresholds must eventually be derived from measured data, not guessed hardware percentages. The deployment should nevertheless have explicit GREEN/YELLOW/RED capacity states so expansion is initiated before saturation.

Examples of signals to include are sustained p95/p99 latency, CPU/RAM pressure, database lock/connection pressure, queue growth and error rate.

The exact thresholds become normative only after benchmark evidence exists.

## 9. Architectural consequence

Soft Chat is the minimum viable communication product and the reference path against which AI-assisted modes are compared.

The client should therefore reach a real compose/send/receive Soft Chat flow before the production model runtime is required. Translation and style processing can then be added as explicit transformations without making basic communication depend on Stage III model availability.
