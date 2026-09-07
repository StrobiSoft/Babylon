import { createPublicKey, type KeyObject } from 'node:crypto';

import { CommandRegistry, parseCommandReference } from './commands.js';
import { fingerprintPublicKey, signEnvelope, verifyEnvelopeSignature } from './crypto.js';
import {
  assertSignedEnvelope,
  createMessageId,
  type TimePolicy,
  validateEnvelopeTime,
} from './envelope.js';
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
  | 'BAD_SIGNATURE'
  | 'INVALID_TIME'
  | 'REPLAY_DETECTED'
  | 'DURABLE_REPLAY_REQUIRED'
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

export interface PeerIdentity {
  nodeId: string;
  status: NodeLifecycleStatus;
  publicKeys: ReadonlyMap<string, KeyObject>;
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

export interface NodeCoreOptions {
  nodeId: string;
  privateKey: KeyObject;
  keyFingerprint: string;
  replayStore: ReplayStore;
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
  now?: () => number;
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

    if (envelope.to !== this.#options.nodeId) {
      throw new NodeCoreError('WRONG_RECIPIENT');
    }

    const sender = await this.#options.resolvePeer(envelope.from);
    if (sender?.nodeId !== envelope.from) {
      throw new NodeCoreError('UNKNOWN_NODE');
    }
    if (!activeLifecycle(sender.status)) {
      throw new NodeCoreError('NODE_NOT_ACTIVE');
    }

    const publicKey = sender.publicKeys.get(envelope.key_fingerprint);
    if (publicKey === undefined) {
      throw new NodeCoreError('UNKNOWN_KEY');
    }
    let signatureValid = false;
    try {
      signatureValid = verifyEnvelopeSignature(envelope, publicKey);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new NodeCoreError('BAD_SIGNATURE');
    }

    const nowMs = this.#now();
    try {
      validateEnvelopeTime(envelope, nowMs, this.#options.timePolicy);
    } catch {
      throw new NodeCoreError('INVALID_TIME');
    }

    if (envelope.kind === 'command' && !this.#options.replayStore.durable) {
      throw new NodeCoreError('DURABLE_REPLAY_REQUIRED');
    }

    const replay = await this.#options.replayStore.claim(
      sender.nodeId,
      envelope.message_id,
      Date.parse(envelope.expires_at),
      nowMs,
    );
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
      case 'command':
        return this.#handleCommand(sender, envelope);
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
  ): Promise<SignedBnpEnvelope> {
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
    if (!sender.capabilities.has(command.requiredCapability)) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }

    const allowed = await this.#options.authorize({
      sender,
      envelope,
      operation: 'command',
      command: {
        tableId: command.table_id,
        tableVersion: command.table_version,
        commandId: command.command_id,
        requiredCapability: command.requiredCapability,
      },
    });
    if (!allowed) {
      throw new NodeCoreError('CAPABILITY_DENIED');
    }

    const result = await command.handler({
      senderNodeId: sender.nodeId,
      messageId: envelope.message_id,
    });

    return this.#reply(envelope, 'command_result', {
      table_id: command.table_id,
      table_version: command.table_version,
      command_id: command.command_id,
      execution_semantics: command.executionSemantics,
      state: 'completed',
      result,
    });
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
