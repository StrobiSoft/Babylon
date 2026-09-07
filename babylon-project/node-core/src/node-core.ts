import { createPublicKey, type KeyObject } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type {
  CommandDescriptor,
  CommandJournal,
  CommandJournalEntry,
  CommandTerminalOutcome,
} from './command-journal.js';
import { CommandRegistry, parseCommandReference, type CommandDefinition } from './commands.js';
import {
  fingerprintPublicKey,
  replayEnvelopeDigest,
  signEnvelope,
  verifyEnvelopeSignature,
} from './crypto.js';
import {
  assertSignedEnvelope,
  createMessageId,
  type TimePolicy,
  validateEnvelopeTime,
} from './envelope.js';
import { canonicalizeJcs } from './jcs.js';
import type { ReplayStore } from './replay.js';
import type {
  BnpKind,
  JsonObject,
  NodeLifecycleStatus,
  SignedBnpEnvelope,
  UnsignedBnpEnvelope,
} from './types.js';

export type NodeCoreErrorCode =
  | 'INVALID_ENVELOPE'
  | 'WRONG_RECIPIENT'
  | 'UNKNOWN_NODE'
  | 'NODE_NOT_ACTIVE'
  | 'UNKNOWN_KEY'
  | 'KEY_NOT_ACTIVE'
  | 'BAD_SIGNATURE'
  | 'INVALID_TIME'
  | 'REPLAY_DETECTED'
  | 'REPLAY_CONFLICT'
  | 'DURABLE_REPLAY_REQUIRED'
  | 'COMMAND_EXECUTION_POLICY_REQUIRED'
  | 'COMMAND_JOURNAL_FAILURE'
  | 'COMMAND_DEFINITION_CHANGED'
  | 'CAPABILITY_DENIED'
  | 'UNKNOWN_COMMAND'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_OPERATION_BODY';

export class NodeCoreError extends Error {
  constructor(readonly code: NodeCoreErrorCode) {
    super(code);
    this.name = 'NodeCoreError';
  }
}

export interface PeerKey {
  publicKey: KeyObject;
  status: 'active' | 'rotating' | 'inactive' | 'revoked';
}

export interface PeerIdentity {
  nodeId: string;
  status: NodeLifecycleStatus;
  keys: ReadonlyMap<string, PeerKey>;
  capabilities: ReadonlySet<string>;
}

export interface AuthorizationContext {
  sender: PeerIdentity;
  envelope: SignedBnpEnvelope;
  operation: 'wake' | 'read' | 'command';
  resource?: string;
  view?: string;
  command?: {
    tableId: string;
    tableVersion: string;
    commandId: string;
    requiredCapability: string;
  };
}

export interface CommandExecutionPolicy {
  maxResultBytes: number;
  resultRetentionMs: number;
}

export type CommandTracePhase =
  | 'received'
  | 'authorized'
  | 'duplicate_observed'
  | 'started'
  | 'handler_returned'
  | 'indeterminate'
  | 'terminal_committed'
  | 'response_signed';

export interface CommandTraceEvent {
  phase: CommandTracePhase;
  senderNodeId: string;
  messageId: string;
  atMs: number;
  attemptId?: string;
}

export interface NodeCoreOptions {
  nodeId: string;
  privateKey: KeyObject;
  keyFingerprint: string;
  replayStore: ReplayStore;
  commandJournal?: CommandJournal;
  commandExecutionPolicy?: CommandExecutionPolicy;
  commandRegistry: CommandRegistry;
  timePolicy: TimePolicy;
  responseLifetimeMs: number;
  resolvePeer: (nodeId: string) => Promise<PeerIdentity | null> | PeerIdentity | null;
  authorize: (context: AuthorizationContext) => Promise<boolean> | boolean;
  onWake?: (sender: PeerIdentity, body: JsonObject) => Promise<void> | void;
  onRead?: (
    sender: PeerIdentity,
    resource: string,
    view: string,
  ) => Promise<JsonObject> | JsonObject;
  onCommandTrace?: (event: CommandTraceEvent) => void;
  now?: () => number;
  monotonicNow?: () => number;
}

function activeLifecycle(status: NodeLifecycleStatus): boolean {
  return status === 'active' || status === 'rotating';
}

function expectString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new NodeCoreError('INVALID_OPERATION_BODY');
  }
  return value;
}

function assertOnlyKeys(body: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedSet.has(key))) {
    throw new NodeCoreError('INVALID_OPERATION_BODY');
  }
}

function replayRetentionUntilMs(envelope: SignedBnpEnvelope, policy: TimePolicy): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Date.parse(envelope.expires_at) + policy.maxLateSkewMs);
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function commandExecutionKey(
  senderNodeId: string,
  messageId: string,
  envelopeDigest: string,
): string {
  return `${senderNodeId}\u0000${messageId}\u0000${envelopeDigest}`;
}

function descriptorFromDefinition(definition: CommandDefinition): CommandDescriptor {
  return {
    tableId: definition.table_id,
    tableVersion: definition.table_version,
    commandId: definition.command_id,
    requiredCapability: definition.requiredCapability,
    executionSemantics: definition.executionSemantics,
  };
}

function definitionMatchesDescriptor(
  definition: CommandDefinition,
  descriptor: CommandDescriptor,
): boolean {
  return (
    definition.table_id === descriptor.tableId &&
    definition.table_version === descriptor.tableVersion &&
    definition.command_id === descriptor.commandId &&
    definition.requiredCapability === descriptor.requiredCapability &&
    definition.executionSemantics === descriptor.executionSemantics
  );
}

export class NodeCore {
  readonly #options: NodeCoreOptions;

  constructor(options: NodeCoreOptions) {
    if (options.nodeId.length < 8 || options.nodeId.length > 128) {
      throw new TypeError('invalid local nodeId');
    }
    if (
      !Number.isFinite(options.responseLifetimeMs) ||
      options.responseLifetimeMs <= 0 ||
      options.responseLifetimeMs > options.timePolicy.maxLifetimeMs
    ) {
      throw new TypeError('responseLifetimeMs must be positive and within maxLifetimeMs');
    }
    if (options.commandExecutionPolicy !== undefined) {
      const { maxResultBytes, resultRetentionMs } = options.commandExecutionPolicy;
      if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0) {
        throw new TypeError('maxResultBytes must be a positive safe integer');
      }
      if (!Number.isSafeInteger(resultRetentionMs) || resultRetentionMs <= 0) {
        throw new TypeError('resultRetentionMs must be a positive safe integer');
      }
    }
    const derivedFingerprint = fingerprintPublicKey(createPublicKey(options.privateKey));
    if (derivedFingerprint !== options.keyFingerprint) {
      throw new TypeError('keyFingerprint does not match privateKey');
    }
    this.#options = options;
  }

  async process(rawEnvelope: unknown): Promise<SignedBnpEnvelope> {
    let envelope: SignedBnpEnvelope;
    try {
      assertSignedEnvelope(rawEnvelope);
      envelope = rawEnvelope;
    } catch {
      throw new NodeCoreError('INVALID_ENVELOPE');
    }

    const sender = await this.#options.resolvePeer(envelope.from);
    if (sender?.nodeId !== envelope.from) {
      throw new NodeCoreError('UNKNOWN_NODE');
    }
    if (!activeLifecycle(sender.status)) {
      throw new NodeCoreError('NODE_NOT_ACTIVE');
    }

    const key = sender.keys.get(envelope.key_fingerprint);
    if (key === undefined) {
      throw new NodeCoreError('UNKNOWN_KEY');
    }
    if (key.status !== 'active' && key.status !== 'rotating') {
      throw new NodeCoreError('KEY_NOT_ACTIVE');
    }

    let fingerprintMatches = false;
    try {
      fingerprintMatches = fingerprintPublicKey(key.publicKey) === envelope.key_fingerprint;
    } catch {
      fingerprintMatches = false;
    }
    if (!fingerprintMatches) {
      throw new NodeCoreError('UNKNOWN_KEY');
    }

    let signatureValid = false;
    try {
      signatureValid = verifyEnvelopeSignature(envelope, key.publicKey);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new NodeCoreError('BAD_SIGNATURE');
    }

    if (envelope.to !== this.#options.nodeId) {
      throw new NodeCoreError('WRONG_RECIPIENT');
    }

    const nowMs = this.#now();
    if (envelope.kind === 'command') {
      return this.#handleCommand(sender, envelope, nowMs);
    }

    try {
      validateEnvelopeTime(envelope, nowMs, this.#options.timePolicy);
    } catch {
      throw new NodeCoreError('INVALID_TIME');
    }

    const replay = await this.#options.replayStore.claim(
      sender.nodeId,
      envelope.message_id,
      replayRetentionUntilMs(envelope, this.#options.timePolicy),
      nowMs,
      replayEnvelopeDigest(envelope),
    );
    if (replay === 'conflict') {
      if (envelope.kind === 'wake') {
        throw new NodeCoreError('REPLAY_CONFLICT');
      }
      throw new NodeCoreError('REPLAY_DETECTED');
    }
    if (replay === 'duplicate') {
      if (envelope.kind === 'wake') {
        return this.#reply(envelope, 'ack', { status: 'duplicate' });
      }
      throw new NodeCoreError('REPLAY_DETECTED');
    }

    switch (envelope.kind) {
      case 'wake':
        return this.#handleWake(sender, envelope);
      case 'read':
        return this.#handleRead(sender, envelope);
      default:
        throw new NodeCoreError('UNSUPPORTED_OPERATION');
    }
  }

  async #handleWake(sender: PeerIdentity, envelope: SignedBnpEnvelope): Promise<SignedBnpEnvelope> {
    const allowed = await this.#options.authorize({
      sender,
      envelope,
      operation: 'wake',
    });
    if (!allowed) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }

    await this.#options.onWake?.(sender, envelope.body);
    return this.#reply(envelope, 'ack', { status: 'accepted' });
  }

  async #handleRead(sender: PeerIdentity, envelope: SignedBnpEnvelope): Promise<SignedBnpEnvelope> {
    if (this.#options.onRead === undefined) {
      throw new NodeCoreError('UNSUPPORTED_OPERATION');
    }

    assertOnlyKeys(envelope.body, ['resource', 'view']);
    const resource = expectString(envelope.body, 'resource');
    const view = expectString(envelope.body, 'view');
    const requiredCapability = `state.read:${view}`;
    if (!sender.capabilities.has(requiredCapability)) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }

    const allowed = await this.#options.authorize({
      sender,
      envelope,
      operation: 'read',
      resource,
      view,
    });
    if (!allowed) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }

    const state = await this.#options.onRead(sender, resource, view);
    return this.#reply(envelope, 'read_result', { resource, view, state });
  }

  async #handleCommand(
    sender: PeerIdentity,
    envelope: SignedBnpEnvelope,
    nowMs: number,
  ): Promise<SignedBnpEnvelope> {
    const journal = this.#options.commandJournal;
    if (!journal?.durable) {
      throw new NodeCoreError('DURABLE_REPLAY_REQUIRED');
    }
    const policy = this.#options.commandExecutionPolicy;
    if (policy === undefined) {
      throw new NodeCoreError('COMMAND_EXECUTION_POLICY_REQUIRED');
    }

    const envelopeDigest = replayEnvelopeDigest(envelope);
    const existing = await this.#journal(() => journal.lookup(sender.nodeId, envelope.message_id));
    if (existing !== null) {
      if (existing.envelopeDigest !== envelopeDigest) {
        throw new NodeCoreError('REPLAY_DETECTED');
      }
      this.#trace('duplicate_observed', sender.nodeId, envelope.message_id, existing.attemptId);
      return this.#handleExistingCommand(sender, envelope, existing);
    }

    try {
      validateEnvelopeTime(envelope, nowMs, this.#options.timePolicy);
    } catch {
      throw new NodeCoreError('INVALID_TIME');
    }

    const definition = this.#resolveCommandDefinition(envelope);
    const descriptor = descriptorFromDefinition(definition);
    await this.#authorizeCommand(sender, envelope, descriptor);
    this.#trace('authorized', sender.nodeId, envelope.message_id);

    const replayUntil = replayRetentionUntilMs(envelope, this.#options.timePolicy);
    const resultUntil = saturatingAdd(nowMs, policy.resultRetentionMs);
    const receive = await this.#journal(() =>
      journal.receive({
        senderNodeId: sender.nodeId,
        messageId: envelope.message_id,
        envelopeDigest,
        retainUntilMs: Math.max(replayUntil, resultUntil),
        command: descriptor,
        receivedAtMs: nowMs,
      }),
    );

    if (receive.kind === 'conflict') {
      throw new NodeCoreError('REPLAY_DETECTED');
    }
    if (receive.kind === 'duplicate') {
      this.#trace(
        'duplicate_observed',
        sender.nodeId,
        envelope.message_id,
        receive.entry.attemptId,
      );
      return this.#handleExistingCommand(sender, envelope, receive.entry);
    }

    this.#trace('received', sender.nodeId, envelope.message_id);
    return this.#startAndExecute(sender, envelope, receive.entry, definition);
  }

  async #handleExistingCommand(
    sender: PeerIdentity,
    envelope: SignedBnpEnvelope,
    entry: CommandJournalEntry,
  ): Promise<SignedBnpEnvelope> {
    await this.#authorizeCommand(sender, envelope, entry.command);
    this.#trace('authorized', sender.nodeId, envelope.message_id, entry.attemptId);

    switch (entry.state) {
      case 'terminal':
      case 'started':
      case 'indeterminate':
        return this.#replyForJournalEntry(envelope, entry);
      case 'received': {
        const definition = this.#resolveCommandDefinition(envelope);
        if (!definitionMatchesDescriptor(definition, entry.command)) {
          throw new NodeCoreError('COMMAND_DEFINITION_CHANGED');
        }
        return this.#startAndExecute(sender, envelope, entry, definition);
      }
    }
  }

  async #startAndExecute(
    sender: PeerIdentity,
    envelope: SignedBnpEnvelope,
    entry: CommandJournalEntry,
    definition: CommandDefinition,
  ): Promise<SignedBnpEnvelope> {
    const journal = this.#options.commandJournal;
    const policy = this.#options.commandExecutionPolicy;
    if (journal === undefined || policy === undefined) {
      throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
    }
    if (!definitionMatchesDescriptor(definition, entry.command)) {
      throw new NodeCoreError('COMMAND_DEFINITION_CHANGED');
    }

    // Re-check current authorization immediately before the durable STARTED gate.
    await this.#authorizeCommand(sender, envelope, entry.command);
    this.#trace('authorized', sender.nodeId, envelope.message_id, entry.attemptId);

    const attemptId = createMessageId();
    const startedAtMs = this.#now();
    try {
      validateEnvelopeTime(envelope, startedAtMs, this.#options.timePolicy);
    } catch {
      throw new NodeCoreError('INVALID_TIME');
    }

    const started = await this.#journal(() =>
      journal.start(
        sender.nodeId,
        envelope.message_id,
        entry.envelopeDigest,
        attemptId,
        startedAtMs,
      ),
    );
    if (started.kind === 'conflict') {
      throw new NodeCoreError('REPLAY_DETECTED');
    }
    if (started.kind === 'stale') {
      return this.#replyForJournalEntry(envelope, started.entry);
    }

    this.#trace('started', sender.nodeId, envelope.message_id, attemptId);

    let result: JsonObject;
    try {
      result = await definition.handler({
        senderNodeId: sender.nodeId,
        messageId: envelope.message_id,
        attemptId,
        executionKey: commandExecutionKey(sender.nodeId, envelope.message_id, entry.envelopeDigest),
      });
      this.#trace('handler_returned', sender.nodeId, envelope.message_id, attemptId);
      this.#assertBoundedCommandResult(result, policy.maxResultBytes);
    } catch {
      return this.#recordIndeterminate(sender, envelope, entry, attemptId);
    }

    const outcome: CommandTerminalOutcome = { state: 'completed', result };
    const terminalAtMs = this.#now();
    const terminalRetainUntilMs = Math.max(
      entry.retainUntilMs,
      saturatingAdd(terminalAtMs, policy.resultRetentionMs),
    );
    let completed;
    try {
      completed = await journal.complete(
        sender.nodeId,
        envelope.message_id,
        entry.envelopeDigest,
        attemptId,
        outcome,
        terminalAtMs,
        terminalRetainUntilMs,
      );
    } catch {
      const observed = await this.#journal(() =>
        journal.lookup(sender.nodeId, envelope.message_id),
      );
      if (observed !== null && observed.envelopeDigest === entry.envelopeDigest) {
        if (observed.state === 'terminal') {
          return this.#replyForJournalEntry(envelope, observed);
        }
      }
      throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
    }

    if (completed.kind === 'conflict') {
      throw new NodeCoreError('REPLAY_DETECTED');
    }
    if (completed.kind === 'stale') {
      return this.#replyForJournalEntry(envelope, completed.entry);
    }

    this.#trace('terminal_committed', sender.nodeId, envelope.message_id, attemptId);
    return this.#replyForJournalEntry(envelope, completed.entry);
  }

  async #recordIndeterminate(
    sender: PeerIdentity,
    envelope: SignedBnpEnvelope,
    entry: CommandJournalEntry,
    attemptId: string,
  ): Promise<SignedBnpEnvelope> {
    const journal = this.#options.commandJournal;
    if (journal === undefined) {
      throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
    }
    const transition = await this.#journal(() =>
      journal.markIndeterminate(
        sender.nodeId,
        envelope.message_id,
        entry.envelopeDigest,
        attemptId,
        this.#now(),
      ),
    );
    if (transition.kind === 'conflict') {
      throw new NodeCoreError('REPLAY_DETECTED');
    }
    if (transition.kind === 'stale' && transition.entry.state === 'received') {
      throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
    }
    if (transition.entry.state === 'indeterminate') {
      this.#trace('indeterminate', sender.nodeId, envelope.message_id, attemptId);
    }
    return this.#replyForJournalEntry(envelope, transition.entry);
  }

  #resolveCommandDefinition(envelope: SignedBnpEnvelope): CommandDefinition {
    let reference;
    try {
      reference = parseCommandReference(envelope.body);
    } catch {
      throw new NodeCoreError('INVALID_OPERATION_BODY');
    }
    const command = this.#options.commandRegistry.resolve(reference);
    if (command === undefined) {
      throw new NodeCoreError('UNKNOWN_COMMAND');
    }
    return command;
  }

  async #authorizeCommand(
    sender: PeerIdentity,
    envelope: SignedBnpEnvelope,
    descriptor: CommandDescriptor,
  ): Promise<void> {
    if (!sender.capabilities.has(descriptor.requiredCapability)) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }
    const allowed = await this.#options.authorize({
      sender,
      envelope,
      operation: 'command',
      command: {
        tableId: descriptor.tableId,
        tableVersion: descriptor.tableVersion,
        commandId: descriptor.commandId,
        requiredCapability: descriptor.requiredCapability,
      },
    });
    if (!allowed) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }
  }

  #replyForJournalEntry(request: SignedBnpEnvelope, entry: CommandJournalEntry): SignedBnpEnvelope {
    let response: SignedBnpEnvelope;
    switch (entry.state) {
      case 'received':
        throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
      case 'started':
        response = this.#commandReply(request, entry.command, 'accepted');
        break;
      case 'indeterminate':
        response = this.#commandReply(
          request,
          entry.command,
          'blocked',
          undefined,
          'INDETERMINATE',
        );
        break;
      case 'terminal': {
        if (entry.terminal === undefined) {
          throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
        }
        response = this.#commandReply(
          request,
          entry.command,
          entry.terminal.state,
          entry.terminal.result,
          entry.terminal.reasonCode,
        );
        break;
      }
    }
    this.#trace('response_signed', request.from, request.message_id, entry.attemptId);
    return response;
  }

  #commandReply(
    request: SignedBnpEnvelope,
    descriptor: CommandDescriptor,
    state: CommandTerminalOutcome['state'] | 'accepted',
    result?: JsonObject,
    reasonCode?: string,
  ): SignedBnpEnvelope {
    const body: JsonObject = {
      table_id: descriptor.tableId,
      table_version: descriptor.tableVersion,
      command_id: descriptor.commandId,
      execution_semantics: descriptor.executionSemantics,
      state,
    };
    if (result !== undefined) {
      body['result'] = result;
    }
    if (reasonCode !== undefined) {
      body['reason_code'] = reasonCode;
    }
    return this.#reply(request, 'command_result', body);
  }

  #assertBoundedCommandResult(result: unknown, maxBytes: number): asserts result is JsonObject {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError('command result must be a JSON object');
    }
    const canonical = canonicalizeJcs(result);
    if (Buffer.byteLength(canonical, 'utf8') > maxBytes) {
      throw new TypeError('command result exceeds configured bound');
    }
  }

  async #journal<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new NodeCoreError('COMMAND_JOURNAL_FAILURE');
    }
  }

  #trace(
    phase: CommandTracePhase,
    senderNodeId: string,
    messageId: string,
    attemptId?: string,
  ): void {
    if (this.#options.onCommandTrace === undefined) {
      return;
    }
    try {
      this.#options.onCommandTrace({
        phase,
        senderNodeId,
        messageId,
        atMs: this.#options.monotonicNow?.() ?? performance.now(),
        ...(attemptId === undefined ? {} : { attemptId }),
      });
    } catch {
      // Observability must never become an execution dependency.
    }
  }

  #reply(request: SignedBnpEnvelope, kind: BnpKind, body: JsonObject): SignedBnpEnvelope {
    const nowMs = this.#now();
    const unsigned: UnsignedBnpEnvelope = {
      bnp: '1',
      kind,
      message_id: createMessageId(),
      from: this.#options.nodeId,
      to: request.from,
      issued_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + this.#options.responseLifetimeMs).toISOString(),
      key_fingerprint: this.#options.keyFingerprint,
      body,
      in_reply_to: request.message_id,
    };
    return signEnvelope(unsigned, this.#options.privateKey);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
