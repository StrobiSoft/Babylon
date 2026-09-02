import {
  ownerDecisionReplySchema,
  serializeOwnerDecisionReply,
  type OwnerDecisionReply,
  type OwnerReplyTransport,
} from './protocol.js';

export type OwnerWorkflowState = 'pending' | 'waiting' | 'approved' | 'rejected';
export type OwnerReplyErrorCode =
  | 'INVALID_REPLY'
  | 'UNKNOWN_EVENT'
  | 'REPLAYED_SEQUENCE'
  | 'EVENT_TERMINAL';

export class OwnerReplyError extends Error {
  constructor(
    readonly code: OwnerReplyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerReplyError';
  }
}

interface EventRecord {
  state: OwnerWorkflowState;
  lastSequence: number | undefined;
  replies: OwnerDecisionReply[];
}

/** In-memory test receiver only. It is intentionally not registered on the Babylon server. */
export class InMemoryOwnerReplyReceiver {
  private readonly events = new Map<string, EventRecord>();

  openEvent(eventId: string): void {
    const result = ownerDecisionReplySchema.shape.event_id.safeParse(eventId);
    if (!result.success) throw new OwnerReplyError('INVALID_REPLY', 'invalid event ID');
    if (!this.events.has(eventId)) {
      this.events.set(eventId, { state: 'pending', lastSequence: undefined, replies: [] });
    }
  }

  accept(input: unknown): Readonly<{ state: OwnerWorkflowState; terminal: boolean }> {
    const parsed = ownerDecisionReplySchema.safeParse(input);
    if (!parsed.success) {
      throw new OwnerReplyError(
        'INVALID_REPLY',
        parsed.error.issues[0]?.message ?? 'invalid owner reply',
      );
    }
    const reply = parsed.data;
    const record = this.events.get(reply.event_id);
    if (record === undefined) throw new OwnerReplyError('UNKNOWN_EVENT', 'event is not open');
    if (record.lastSequence !== undefined && reply.sequence <= record.lastSequence) {
      throw new OwnerReplyError(
        'REPLAYED_SEQUENCE',
        'reply sequence must be greater than the last accepted sequence',
      );
    }
    if (record.state === 'approved' || record.state === 'rejected') {
      throw new OwnerReplyError('EVENT_TERMINAL', 'event already has a terminal decision');
    }

    record.lastSequence = reply.sequence;
    record.replies.push(reply);
    record.state =
      reply.decision === 'WAIT'
        ? 'waiting'
        : reply.decision === 'APPROVE'
          ? 'approved'
          : 'rejected';
    return {
      state: record.state,
      terminal: record.state === 'approved' || record.state === 'rejected',
    };
  }

  snapshot(eventId: string): Readonly<{
    state: OwnerWorkflowState;
    lastSequence: number | undefined;
    replies: readonly OwnerDecisionReply[];
  }> {
    const record = this.events.get(eventId);
    if (record === undefined) throw new OwnerReplyError('UNKNOWN_EVENT', 'event is not open');
    return {
      state: record.state,
      lastSequence: record.lastSequence,
      replies: [...record.replies],
    };
  }
}

export class LocalOwnerReplyTransport implements OwnerReplyTransport {
  constructor(private readonly receiver: InMemoryOwnerReplyReceiver) {}

  send(reply: OwnerDecisionReply): Promise<void> {
    const wireReply: unknown = JSON.parse(serializeOwnerDecisionReply(reply));
    this.receiver.accept(wireReply);
    return Promise.resolve();
  }
}
