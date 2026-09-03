import { createHash } from 'node:crypto';
import { replyMacroCatalogById, type ReplyMacroEffect } from '../reply-macros/index.js';
import {
  opaqueHandleSchema,
  ownerDecisionReplySchema,
  serializeOwnerDecisionReply,
  type OwnerDecisionReply,
} from './protocol.js';

export type OwnerWorkflowState = 'pending' | 'waiting' | 'approved' | 'rejected';
export type OwnerReplyErrorCode =
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_REPLY_MACRO_ID'
  | 'UNKNOWN_CORRELATION'
  | 'ROUTE_HANDLE_MISMATCH'
  | 'SENDER_MISMATCH'
  | 'REPLAYED_SEQUENCE'
  | 'EVENT_TERMINAL'
  | 'TERMINAL_DECISION_CONFLICT'
  | 'DELIVERY_FAILED';

export class OwnerReplyError extends Error {
  constructor(
    readonly code: OwnerReplyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerReplyError';
  }
}

export interface OwnerWorkflowSignal {
  readonly protocolVersion: '0.1';
  readonly eventId: string;
  readonly replyMacroId: string;
  readonly effect: ReplyMacroEffect;
  readonly terminal: boolean;
  readonly sequence: number;
  readonly timestamp: string;
  readonly senderId: string;
  readonly returnRoute: string;
  readonly payloadHash: string;
}

export interface OwnerWorkflowSink {
  consume(signal: OwnerWorkflowSignal): Promise<void>;
}

export interface OwnerReplyRouteRegistration {
  readonly eventId: string;
  readonly returnRoute: string;
  readonly allowedSenderIds: readonly string[];
  readonly sink: OwnerWorkflowSink;
}

export interface OwnerReplyAuditEntry {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly replyMacroId?: string;
  readonly sequence?: number;
  readonly senderId?: string;
  readonly clientTimestamp?: string;
  readonly observedAt: string;
  readonly routeHash?: string;
  readonly payloadHash: string;
  readonly deliveryState: 'rejected' | 'delivered' | 'delivery_failed';
  readonly errorCode?: OwnerReplyErrorCode;
}

interface RouteRecord extends OwnerReplyRouteRegistration {
  state: OwnerWorkflowState;
  lastSequence: number | undefined;
  terminalMacroId: string | undefined;
}

export interface OwnerReplyRouterOptions {
  readonly clock?: () => Date;
  readonly audit?: (entry: OwnerReplyAuditEntry) => void;
}

/**
 * Private N Agent routing core. It has no network listener and resolves only opaque route handles.
 * Route registration and durable sink implementation belong to the existing trusted deployment.
 */
export class OwnerReplyRouter {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly routeOwners = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly clock: () => Date;
  private readonly audit: (entry: OwnerReplyAuditEntry) => void;

  constructor(options: OwnerReplyRouterOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.audit = options.audit ?? (() => undefined);
  }

  register(registration: OwnerReplyRouteRegistration): void {
    const eventResult = ownerDecisionReplySchema.shape.event_id.safeParse(registration.eventId);
    const routeResult = opaqueHandleSchema.safeParse(registration.returnRoute);
    const sendersValid =
      registration.allowedSenderIds.length > 0 &&
      registration.allowedSenderIds.every((sender) => opaqueHandleSchema.safeParse(sender).success);
    if (!eventResult.success || !routeResult.success || !sendersValid) {
      throw new OwnerReplyError('INVALID_ENVELOPE', 'invalid route registration');
    }
    const routeOwner = this.routeOwners.get(registration.returnRoute);
    if (routeOwner !== undefined && routeOwner !== registration.eventId) {
      throw new OwnerReplyError('ROUTE_HANDLE_MISMATCH', 'return route is already bound');
    }
    const existing = this.routes.get(registration.eventId);
    if (existing !== undefined && existing.returnRoute !== registration.returnRoute) {
      throw new OwnerReplyError('ROUTE_HANDLE_MISMATCH', 'event is already bound to another route');
    }
    if (existing !== undefined) return;
    this.routes.set(registration.eventId, {
      ...registration,
      allowedSenderIds: [...new Set(registration.allowedSenderIds)],
      state: 'pending',
      lastSequence: undefined,
      terminalMacroId: undefined,
    });
    this.routeOwners.set(registration.returnRoute, registration.eventId);
  }

  async route(input: unknown): Promise<Readonly<{ state: OwnerWorkflowState; terminal: boolean }>> {
    const parsed = ownerDecisionReplySchema.safeParse(input);
    const payloadHash = hashUnknown(input);
    if (!parsed.success) {
      const error = new OwnerReplyError(
        'INVALID_ENVELOPE',
        parsed.error.issues[0]?.message ?? 'invalid owner reply envelope',
      );
      this.record(input, payloadHash, 'rejected', error.code);
      throw error;
    }
    const reply = parsed.data;
    return this.serialized(reply.event_id, () => this.routeParsed(reply, payloadHash));
  }

  snapshot(eventId: string): Readonly<{
    state: OwnerWorkflowState;
    lastSequence: number | undefined;
    terminalMacroId: string | undefined;
  }> {
    const route = this.routes.get(eventId);
    if (route === undefined) {
      throw new OwnerReplyError('UNKNOWN_CORRELATION', 'event correlation is not registered');
    }
    return {
      state: route.state,
      lastSequence: route.lastSequence,
      terminalMacroId: route.terminalMacroId,
    };
  }

  private async routeParsed(
    reply: OwnerDecisionReply,
    payloadHash: string,
  ): Promise<Readonly<{ state: OwnerWorkflowState; terminal: boolean }>> {
    const macro = replyMacroCatalogById.get(reply.reply_macro_id);
    if (macro === undefined || macro.deprecation.deprecated) {
      return this.reject(reply, payloadHash, 'UNKNOWN_REPLY_MACRO_ID', 'reply macro is unknown');
    }
    const route = this.routes.get(reply.event_id);
    if (route === undefined) {
      return this.reject(
        reply,
        payloadHash,
        'UNKNOWN_CORRELATION',
        'event correlation is not registered',
      );
    }
    if (route.returnRoute !== reply.return_route) {
      return this.reject(
        reply,
        payloadHash,
        'ROUTE_HANDLE_MISMATCH',
        'return route does not match event correlation',
      );
    }
    if (!route.allowedSenderIds.includes(reply.sender_id)) {
      return this.reject(reply, payloadHash, 'SENDER_MISMATCH', 'sender is not bound to route');
    }
    if (route.lastSequence !== undefined && reply.sequence <= route.lastSequence) {
      return this.reject(
        reply,
        payloadHash,
        'REPLAYED_SEQUENCE',
        'reply sequence must increase monotonically',
      );
    }
    if (route.terminalMacroId !== undefined) {
      const code =
        macro.terminal && macro.id !== route.terminalMacroId
          ? 'TERMINAL_DECISION_CONFLICT'
          : 'EVENT_TERMINAL';
      return this.reject(reply, payloadHash, code, 'event already has a terminal decision');
    }

    const signal: OwnerWorkflowSignal = {
      protocolVersion: reply.protocol_version,
      eventId: reply.event_id,
      replyMacroId: reply.reply_macro_id,
      effect: macro.effect,
      terminal: macro.terminal,
      sequence: reply.sequence,
      timestamp: reply.timestamp,
      senderId: reply.sender_id,
      returnRoute: reply.return_route,
      payloadHash,
    };
    try {
      await route.sink.consume(signal);
    } catch {
      const error = new OwnerReplyError('DELIVERY_FAILED', 'owner workflow sink rejected delivery');
      this.record(reply, payloadHash, 'delivery_failed', error.code);
      throw error;
    }
    route.lastSequence = reply.sequence;
    route.state = effectState(macro.effect);
    if (macro.terminal) route.terminalMacroId = macro.id;
    this.record(reply, payloadHash, 'delivered');
    return { state: route.state, terminal: macro.terminal };
  }

  private reject(
    reply: OwnerDecisionReply,
    payloadHash: string,
    code: OwnerReplyErrorCode,
    message: string,
  ): never {
    this.record(reply, payloadHash, 'rejected', code);
    throw new OwnerReplyError(code, message);
  }

  private record(
    input: unknown,
    payloadHash: string,
    deliveryState: OwnerReplyAuditEntry['deliveryState'],
    errorCode?: OwnerReplyErrorCode,
  ): void {
    const value =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const returnRoute =
      typeof value['return_route'] === 'string' ? value['return_route'] : undefined;
    this.audit({
      ...(typeof value['protocol_version'] === 'string'
        ? { protocolVersion: value['protocol_version'] }
        : {}),
      ...(typeof value['event_id'] === 'string' ? { eventId: value['event_id'] } : {}),
      ...(typeof value['reply_macro_id'] === 'string'
        ? { replyMacroId: value['reply_macro_id'] }
        : {}),
      ...(typeof value['sequence'] === 'number' ? { sequence: value['sequence'] } : {}),
      ...(typeof value['sender_id'] === 'string' ? { senderId: value['sender_id'] } : {}),
      ...(typeof value['timestamp'] === 'string' ? { clientTimestamp: value['timestamp'] } : {}),
      observedAt: this.clock().toISOString(),
      ...(returnRoute === undefined ? {} : { routeHash: sha256(returnRoute) }),
      payloadHash,
      deliveryState,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}

function effectState(effect: ReplyMacroEffect): OwnerWorkflowState {
  if (effect === 'wait') return 'waiting';
  return effect === 'approve' ? 'approved' : 'rejected';
}

function hashUnknown(input: unknown): string {
  try {
    return sha256(serializeOwnerDecisionReply(input));
  } catch {
    try {
      return sha256(stableStringify(input));
    } catch {
      return sha256(Object.prototype.toString.call(input));
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
