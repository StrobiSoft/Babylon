# BNP v1 Command Crate

Status: DRAFT

## 1. Purpose

The Command Crate is the portable, versioned semantic dictionary used by BNP COMMAND messages.

It separates:

- a compact wire reference;
- a human-readable catalog description;
- a local executable handler binding;
- authorization policy.

The command identifier is never a credential.

## 2. Design goals

- compact wire messages;
- deterministic semantics;
- no arbitrary remote command strings;
- no hidden semantic mutation under an existing version;
- local implementation freedom;
- capability-gated execution;
- safe replay/idempotency behavior;
- portable publication of public command tables;
- optional private deployment-specific tables.

## 3. Crate structure

Logical crate:

```json
{
  "crate_id": "bnp-core",
  "crate_version": "1",
  "protocol": "BNP/1",
  "tables": []
}
```

A crate MAY contain one or more command tables.

## 4. Command table

Logical table:

```json
{
  "table_id": "core",
  "table_version": "1",
  "visibility": "public",
  "commands": []
}
```

Required properties:

- `table_id` is stable within its namespace;
- `table_version` identifies one immutable semantic contract;
- changing the meaning of an existing command requires a new table version or new command identifier;
- removal/deprecation MUST be explicit;
- table discovery does not grant execution authority.

## 5. Command entry

Draft logical entry:

```json
{
  "command_id": "continue",
  "description": "Continue the currently resumable operation.",
  "required_capability": "command.execute:core/continue",
  "execution_semantics": "state-checked",
  "parameters": null,
  "result_contract": "ack-or-terminal-error",
  "deprecated": false
}
```

### 5.1 Required fields

Each command entry MUST define:

```text
command_id
required_capability
execution_semantics
parameters
result_contract
deprecated
```

Human-readable labels/descriptions are catalog metadata and are not required on the wire.

### 5.2 Execution semantics

Allowed v1 classes:

```text
idempotent
at-most-once
state-checked
```

`idempotent`
: The same logical command may safely be applied multiple times with the same final effect.

`at-most-once`
: The receiver must persist enough execution state to prevent duplicate execution after acceptance.

`state-checked`
: Execution is allowed only when current canonical state satisfies the handler's declared precondition. Duplicate delivery is resolved from state rather than blindly re-running the effect.

## 6. Parameter rule

BNP v1 core prefers parameterless primitive commands.

For v1:

```json
"parameters": null
```

is the default.

The following are forbidden as generic parameter escape hatches:

```text
args: "..."
command: "..."
shell: "..."
prompt: "..."
script: "..."
eval: "..."
```

If a future command genuinely requires data, that command family MUST define a typed, bounded, schema-validated parameter object with explicit size/range rules. Generic arbitrary text remains forbidden.

## 7. Wire reference

A BNP COMMAND message references the crate semantics without transporting the whole catalog:

```json
{
  "table_id": "core",
  "table_version": "1",
  "command_id": "continue"
}
```

The receiving node MUST resolve this reference against an installed compatible table before any handler is selected.

Unknown table, unsupported table version, unknown command, or deprecated-without-policy command MUST fail closed.

## 8. Local handler binding

Executable handlers are local implementation details and MUST NOT be supplied by the sender.

Example local-only mapping:

```text
core/1/continue -> resume_current_operation()
core/1/pause    -> request_clean_pause()
core/1/status   -> produce_status_snapshot()
```

The wire protocol never carries these function names.

A node implementation MUST maintain a fixed allowlisted mapping from command reference to local handler.

No dynamic import, eval, shell construction, arbitrary executable path, or sender-selected handler name is allowed.

## 9. Authorization sequence

A receiver MUST perform the following sequence before executing a handler:

1. parse envelope;
2. validate protocol version;
3. validate recipient;
4. validate sender key and signature;
5. reject revoked/suspended identity;
6. validate timestamp/expiry;
7. apply replay/duplicate rules;
8. resolve table and command version;
9. evaluate required capability;
10. evaluate handler preconditions;
11. execute local allowlisted handler;
12. persist execution/result state as required by idempotency class;
13. return signed result/ACK.

A command key by itself is never authorization.

## 10. Versioning

Command semantics are immutable within a table version.

Allowed evolution mechanisms:

- add a new command in a new compatible table version;
- deprecate an old command explicitly;
- replace a command with a new command identifier;
- publish a migration/alias map when operationally useful.

Forbidden evolution:

- silently changing `continue` from one action to a materially different action while retaining the same table/version contract;
- changing capability requirements invisibly;
- changing parameter type/range without a versioned contract change.

## 11. Compatibility negotiation

A node profile SHOULD advertise supported command tables as:

```json
{
  "table_id": "core",
  "versions": ["1"]
}
```

The Bridge MUST NOT route a COMMAND version the recipient does not advertise unless an explicit compatibility rule is defined.

No implicit downgrade is allowed for security-sensitive commands.

## 12. Suggested initial core semantics

The first public table may contain only small, generic operations such as:

```text
status
ack
checkpoint
continue
pause
stop_clean
retry_last
```

These names remain draft until the first table is frozen.

Each final command requires an exact semantic definition, precondition, required capability, idempotency class, and result contract before publication.

## 13. Public and private crates

BNP supports both:

- public generic crates suitable for an open repository;
- private deployment-specific crates containing internal operational semantics.

Privacy of a private crate may reduce information disclosure, but MUST NOT be relied upon for authorization.

## 14. Result contract

A COMMAND result MUST bind to the originating `message_id`.

Minimum result states:

```text
accepted
completed
rejected
blocked
failed
already_applied
```

A result MAY include a bounded machine-readable reason code.

Arbitrary logs, prompts, stack traces, secrets, or unrestricted free text are not required by the core protocol.

## 15. Security invariants

1. Sender cannot select executable code.
2. Sender cannot bypass local handler allowlists.
3. Table visibility does not grant capability.
4. Command knowledge does not grant capability.
5. Unknown versions fail closed.
6. Replay cannot cause duplicate unsafe effects.
7. Local privilege boundaries remain independently enforced.
8. Generic free-form argument channels are outside BNP v1.
