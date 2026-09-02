import { describe, expect, it } from 'vitest';
import {
  NotificationMacroAssembler,
  type NotificationFragment,
} from '../src/notification-macros/index.js';
import {
  createOwnerNotificationDelivery,
  InMemoryOwnerReplyReceiver,
  LocalOwnerReplyTransport,
  OwnerReplyError,
  ownerDecisionReplySchema,
  serializeOwnerDecisionReply,
  type OwnerDecision,
  type OwnerDecisionReply,
} from '../src/owner-notifications/index.js';

const ATTENTION = '01JQ7S4C8N2W6K9D3F5H0M1PXT';
const STATUS_DECISION = '01JQ7Y3M8C5N2K9D6F4H0R1BVA';
const REASON_APPROVAL = '01JQ84FM7N2C9K5D8H4R0B3VXA';
const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '20000000-0000-4000-8000-000000000002';

function fragment(group: 'attention' | 'status' | 'reason', macroId: string): NotificationFragment {
  return { kind: 'macro', group, macroId, macroVersion: '0.1.0' };
}

function notificationFixture() {
  const assembler = new NotificationMacroAssembler();
  const fragments = [
    fragment('reason', REASON_APPROVAL),
    fragment('attention', ATTENTION),
    fragment('status', STATUS_DECISION),
  ];
  fragments.forEach((value, sequence) =>
    assembler.accept({
      protocolVersion: '0.1',
      eventId: EVENT_ID,
      messageId: MESSAGE_ID,
      createdAt: '2026-09-03T00:00:00.000Z',
      sequence: { message: 21, fragment: sequence, totalFragments: fragments.length },
      replay: { attempt: 0 },
      fragment: value,
    }),
  );
  return assembler.assemble();
}

function reply(
  decision: OwnerDecision,
  sequence = 0,
  overrides: Partial<OwnerDecisionReply> = {},
): OwnerDecisionReply {
  return {
    protocol_version: '0.1',
    event_id: EVENT_ID,
    decision,
    timestamp: '2026-09-03T00:01:00.000Z',
    sequence,
    ...overrides,
  };
}

function replyErrorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerReplyError);
    return (error as OwnerReplyError).code;
  }
}

describe('owner notification test/reference slice', () => {
  it.each([
    ['APPROVE', 'approved', true],
    ['REJECT', 'rejected', true],
    ['WAIT', 'waiting', false],
  ] as const)('maps %s to the expected workflow signal', (decision, state, terminal) => {
    const receiver = new InMemoryOwnerReplyReceiver();
    receiver.openEvent(EVENT_ID);
    expect(receiver.accept(reply(decision))).toEqual({ state, terminal });
    expect(receiver.snapshot(EVENT_ID).replies).toEqual([reply(decision)]);
  });

  it('allows a higher-sequence terminal decision after WAIT without treating WAIT as approval', () => {
    const receiver = new InMemoryOwnerReplyReceiver();
    receiver.openEvent(EVENT_ID);
    expect(receiver.accept(reply('WAIT', 4))).toEqual({ state: 'waiting', terminal: false });
    expect(receiver.accept(reply('APPROVE', 5))).toEqual({ state: 'approved', terminal: true });
    expect(replyErrorCode(() => receiver.accept(reply('REJECT', 6)))).toBe('EVENT_TERMINAL');
  });

  it('rejects replayed and stale per-event sequences', () => {
    const receiver = new InMemoryOwnerReplyReceiver();
    receiver.openEvent(EVENT_ID);
    receiver.accept(reply('WAIT', 7));
    expect(replyErrorCode(() => receiver.accept(reply('WAIT', 7)))).toBe('REPLAYED_SEQUENCE');
    expect(replyErrorCode(() => receiver.accept(reply('REJECT', 6)))).toBe('REPLAYED_SEQUENCE');
  });

  it('rejects malformed event IDs, unknown decisions, extra fields, and overlong comments', () => {
    const receiver = new InMemoryOwnerReplyReceiver();
    receiver.openEvent(EVENT_ID);
    const base = reply('WAIT');
    const invalid = [
      { ...base, event_id: 'not-an-event' },
      { ...base, decision: 'MAYBE' },
      { ...base, unexpected: true },
      { ...base, comment: 'x'.repeat(281) },
    ];
    for (const value of invalid) {
      expect(ownerDecisionReplySchema.safeParse(value).success).toBe(false);
      expect(replyErrorCode(() => receiver.accept(value))).toBe('INVALID_REPLY');
    }
  });

  it('serializes replies deterministically in canonical field order', () => {
    const input = reply('APPROVE', 9, { comment: 'Only after the backup completes.' });
    const expected =
      '{"protocol_version":"0.1","event_id":"10000000-0000-4000-8000-000000000001",' +
      '"decision":"APPROVE","timestamp":"2026-09-03T00:01:00.000Z","sequence":9,' +
      '"comment":"Only after the backup completes."}';
    expect(serializeOwnerDecisionReply(input)).toBe(expected);
    expect(serializeOwnerDecisionReply(JSON.parse(expected))).toBe(expected);
  });

  it('runs a local event-to-reply fixture while keeping endpoint expansions separate', async () => {
    const delivery = createOwnerNotificationDelivery(notificationFixture());
    expect(JSON.stringify(delivery.notification)).not.toContain('Action needed.');
    expect(delivery.expansions.map((entry) => entry.text)).toEqual([
      'Action needed.',
      'A decision is required.',
      'Approval is required.',
    ]);

    const receiver = new InMemoryOwnerReplyReceiver();
    receiver.openEvent(delivery.notification.eventId);
    const transport = new LocalOwnerReplyTransport(receiver);
    await transport.send(reply('WAIT', 0));
    await transport.send(reply('REJECT', 1, { comment: 'Risk is still unresolved.' }));

    expect(receiver.snapshot(EVENT_ID)).toMatchObject({
      state: 'rejected',
      lastSequence: 1,
      replies: [{ decision: 'WAIT' }, { decision: 'REJECT' }],
    });
  });
});
