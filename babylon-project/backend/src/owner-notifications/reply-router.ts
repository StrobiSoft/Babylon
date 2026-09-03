import { createHash } from 'node:crypto';
import { replyMacroCatalogById, type ReplyMacroEffect } from '../reply-macros/index.js';
import {
  opaqueHandleSchema,
  opaqueReplyMacroIdSchema,
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
  | 'ROUTE_REGISTRATION_CONFLICT'
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

export interface OwnerReplyRouteLookup {
  readonly eventId: string;
  readonly returnRoute: string;
  readonly senderId: string;
}

export interface OwnerReplyRouteSnapshot {
  readonly state: OwnerWorkflowState;
  readonly lastSequence: number | undefined;
  readonly lastReplyMacroId: string | undefined;
  readonly terminalMacroId: string | undefined;
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
  lastReplyMacroId: string | undefined;
  terminalMacroId: string | undefined;
}

export interface OwnerReplyRouterOptions {
  readonly clock?: () => Date;
  readonly audit?: (entry: OwnerReplyAuditEntry) => void | Promise<void>;
  readonly onAuditFailure?: (error: unknown) => void | Promise<void>;
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
  private readonly audit: (entry: OwnerReplyAuditEntry) => void | Promise<void>;
  private readonly onAuditFailure: (error: unknown) => void | Promise<void>;

  constructor(options: OwnerReplyRouterOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.audit = options.audit ?? (() => undefined);
    this.onAuditFailure = options.onAuditFailure ?? (() => undefined);
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
    if (existing !== undefined) {
      const existingSenders = [...new Set(existing.allowedSenderIds)].sort();
      const requestedSenders = [...new Set(registration.allowedSenderIds)].sort();
      if (
        existing.sink !== registration.sink ||
        existingSenders.length !== requestedSenders.length ||
        existingSenders.some((sender, index) => sender !== requestedSenders[index])
      ) {
        throw new OwnerReplyError(
          'ROUTE_REGISTRATION_CONFLICT',
          'event route is already registered with different bindings',
        );
      }
      return;
    }
    this.routes.set(registration.eventId, {
      ...registration,
      allowedSenderIds: [...new Set(registration.allowedSenderIds)],
      state: 'pending',
      lastSequence: undefined,
      lastReplyMacroId: undefined,
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

  /** Internal trusted snapshot for runtime persistence and tests. */
  snapshot(eventId: string): Readonly<OwnerReplyRouteSnapshot> {
    const route = this.routes.get(eventId);
    if (route === undefined) {
      throw new OwnerReplyError('UNKNOWN_CORRELATION', 'event correlation is not registered');
    }
    return this.routeSnapshot(route);
  }

  /**
   * Route-bound reconciliation for a private authenticated client transport.
   * The caller must prove the exact event, return-route capability, and allowed
   * installation handle; event ID alone is intentionally insufficient.
   *
   * Reconciliation joins the same per-event queue as reply delivery so a lost
   * acknowledgement cannot race an in-flight workflow-sink commit and produce
   * a stale "not consumed" snapshot.
   */
  async reconcile(lookup: OwnerReplyRouteLookup): Promise<Readonly<OwnerReplyRouteSnapshot>> {
    const eventResult = ownerDecisionReplySchema.shape.event_id.safeParse(lookup.eventId);
    const routeResult = opaqueHandleSchema.safeParse(lookup.returnRoute);
    const senderResult = opaqueHandleSchema.safeParse(lookup.senderId);
    if (!eventResult.success || !routeResult.success || !senderResult.success) {
      throw new OwnerReplyError('INVALID_ENVELOPE', 'invalid reconciliation lookup');
    }
    return this.serialized(lookup.eventId, () => {
      const route = this.routes.get(lookup.eventId);
      if (route === undefined) {
        throw new OwnerReplyError('UNKNOWN_CORRELATION', 'event correlation is not registered');
      }
      if (route.returnRoute !== lookup.returnRoute) {
        throw new OwnerReplyError(
          'ROUTE_HANDLE_MISMATCH',
          'return route does not match event correlation',
        );
      }
      if (!route.allowedSenderIds.includes(lookup.senderId)) {
        throw new OwnerReplyError('SENDER_MISMATCH', 'sender is not bound to route');
      }
      return this.routeSnapshot(route);
    });
  }

  private routeSnapshot(route: RouteRecord): Readonly<OwnerReplyRouteSnapshot> {
    return {
      state: route.state,
      lastSequence: route.lastSequence,
      lastReplyMacroId: route.lastReplyMacroId,
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
    route.lastReplyMacroId = macro.id;
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
    let observedAt: string;
    try {
      observedAt = this.clock().toISOString();
    } catch (error) {
      this.reportAuditFailure(error);
      return;
    }
    const value =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const protocolVersion = ownerDecisionReplySchema.shape.protocol_version.safeParse(
      value['protocol_version'],
    );
    const eventId = ownerDecisionReplySchema.shape.event_id.safeParse(value['event_id']);
    const replyMacroId = opaqueReplyMacroIdSchema.safeParse(value['reply_macro_id']);
    const sequence = ownerDecisionReplySchema.shape.sequence.safeParse(value['sequence']);
    const senderId = opaqueHandleSchema.safeParse(value['sender_id']);
    const clientTimestamp = ownerDecisionReplySchema.shape.timestamp.safeParse(value['timestamp']);
    const returnRoute = opaqueHandleSchema.safeParse(value['return_route']);
    const entry: OwnerReplyAuditEntry = {
      ...(protocolVersion.success ? { protocolVersion: protocolVersion.data } : {}),
      ...(eventId.success ? { eventId: eventId.data } : {}),
      ...(replyMacroId.success ? { replyMacroId: replyMacroId.data } : {}),
      ...(sequence.success ? { sequence: sequence.data } : {}),
      ...(senderId.success ? { senderId: senderId.data } : {}),
      ...(clientTimestamp.success ? { clientTimestamp: clientTimestamp.data } : {}),
      observedAt,
      ...(returnRoute.success ? { routeHash: sha256(returnRoute.data) } : {}),
      payloadHash,
      deliveryState,
      ...(errorCode === undefined ? {} : { errorCode }),
    };
    try {
      const result = this.audit(entry);
      if (result !== undefined) {
        void result.catch((error: unknown) => {
          this.reportAuditFailure(error);
        });
      }
    } catch (error) {
      this.reportAuditFailure(error);
    }
  }

  private reportAuditFailure(error: unknown): void {
    try {
      const result = this.onAuditFailure(error);
      if (result !== undefined) void result.catch(() => undefined);
    } catch {
      // Audit reporting is out-of-band and must not make consumed decisions ambiguous.
    }
  }

  private async serialized<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
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
