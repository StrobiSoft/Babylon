import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NotificationMacroAssembler,
  type NotificationFragment,
} from '../src/notification-macros/index.js';
import {
  createOwnerNotificationDelivery,
  LocalOwnerReplyTransport,
  LocalPrivateOwnerReplyAdapter,
  OwnerReplyError,
  OwnerReplyRouter,
  ownerDecisionReplySchema,
  serializeOwnerDecisionReply,
  type OwnerDecisionReply,
  type OwnerReplyAuditEntry,
  type OwnerWorkflowSignal,
  type OwnerWorkflowSink,
} from '../src/owner-notifications/index.js';
import {
  OWNER_REPLY_NO_ID,
  OWNER_REPLY_OK_ID,
  OWNER_REPLY_WAIT_ID,
} from '../src/reply-macros/index.js';
import { replyMacroExpansions } from '../src/reply-macros/expansions.js';

const ATTENTION = '01JQ7S4C8N2W6K9D3F5H0M1PXT';
const STATUS_DECISION = '01JQ7Y3M8C5N2K9D6F4H0R1BVA';
const REASON_APPROVAL = '01JQ84FM7N2C9K5D8H4R0B3VXA';
const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_EVENT_ID = '10000000-0000-4000-8000-000000000099';
const MESSAGE_ID = '20000000-0000-4000-8000-000000000002';
const SENDER_ID = 'install_7V3W9X2Y6Z8A4BCD';
const ROUTE = 'route_8R4T2V6W9X3Y7ZAB';

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
  replyMacroId: string,
  sequence = 0,
  overrides: Partial<OwnerDecisionReply> = {},
): OwnerDecisionReply {
  return {
    protocol_version: '0.1',
    event_id: EVENT_ID,
    reply_macro_id: replyMacroId,
    sequence,
    timestamp: '2026-09-03T00:01:00.000Z',
    sender_id: SENDER_ID,
    return_route: ROUTE,
    ...overrides,
  };
}

class RecordingSink implements OwnerWorkflowSink {
  readonly signals: OwnerWorkflowSignal[] = [];

  consume(signal: OwnerWorkflowSignal): Promise<void> {
    this.signals.push(signal);
    return Promise.resolve();
  }
}

class FailsOnceSink extends RecordingSink {
  private failed = false;

  override consume(signal: OwnerWorkflowSignal): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error('fixture failure'));
    }
    return super.consume(signal);
  }
}

function fixtureRouter(options: { audit?: (entry: OwnerReplyAuditEntry) => void } = {}) {
  const sink = new RecordingSink();
  const router = new OwnerReplyRouter({
    clock: () => new Date('2026-09-03T00:02:00.000Z'),
    ...options,
  });
  router.register({
    eventId: EVENT_ID,
    returnRoute: ROUTE,
    allowedSenderIds: [SENDER_ID],
    sink,
  });
  return { router, sink };
}

async function replyErrorCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerReplyError);
    return (error as OwnerReplyError).code;
  }
}

describe('private owner-reply bridge', () => {
  it.each([
    [OWNER_REPLY_OK_ID, 'approved', true, 'approve'],
    [OWNER_REPLY_NO_ID, 'rejected', true, 'reject'],
    [OWNER_REPLY_WAIT_ID, 'waiting', false, 'wait'],
  ] as const)(
    'routes opaque reply macro %s to its workflow effect',
    async (id, state, terminal, effect) => {
      const { router, sink } = fixtureRouter();
      await expect(router.route(reply(id))).resolves.toEqual({ state, terminal });
      expect(sink.signals).toHaveLength(1);
      expect(sink.signals[0]).toMatchObject({
        eventId: EVENT_ID,
        replyMacroId: id,
        effect,
        terminal,
        returnRoute: ROUTE,
      });
      expect(JSON.stringify(sink.signals[0])).not.toContain('OK / mehet');
    },
  );

  it('keeps WAIT non-terminal and permits a later terminal decision', async () => {
    const { router, sink } = fixtureRouter();
    await expect(router.route(reply(OWNER_REPLY_WAIT_ID, 4))).resolves.toEqual({
      state: 'waiting',
      terminal: false,
    });
    expect(router.snapshot(EVENT_ID).terminalMacroId).toBeUndefined();
    await expect(router.route(reply(OWNER_REPLY_OK_ID, 5))).resolves.toEqual({
      state: 'approved',
      terminal: true,
    });
    expect(sink.signals.map((signal) => signal.effect)).toEqual(['wait', 'approve']);
  });

  it('rejects replayed and stale per-event sequences before terminal checks', async () => {
    const { router } = fixtureRouter();
    await router.route(reply(OWNER_REPLY_WAIT_ID, 7));
    await expect(replyErrorCode(() => router.route(reply(OWNER_REPLY_WAIT_ID, 7)))).resolves.toBe(
      'REPLAYED_SEQUENCE',
    );
    await expect(replyErrorCode(() => router.route(reply(OWNER_REPLY_NO_ID, 6)))).resolves.toBe(
      'REPLAYED_SEQUENCE',
    );
  });

  it('rejects unknown IDs and malformed versions deterministically', async () => {
    const { router } = fixtureRouter();
    await expect(
      replyErrorCode(() => router.route(reply('01K4JBV5R9F2S8X4Y0Z3A7BCDE'))),
    ).resolves.toBe('UNKNOWN_REPLY_MACRO_ID');
    await expect(
      replyErrorCode(() =>
        router.route({ ...reply(OWNER_REPLY_WAIT_ID), protocol_version: '0.2' }),
      ),
    ).resolves.toBe('INVALID_ENVELOPE');
    expect(
      ownerDecisionReplySchema.safeParse({ ...reply(OWNER_REPLY_WAIT_ID), decision: 'WAIT' })
        .success,
    ).toBe(false);
  });

  it('rejects malformed private-adapter JSON through the same audited router path', async () => {
    const audit: OwnerReplyAuditEntry[] = [];
    const { router } = fixtureRouter({ audit: (entry) => audit.push(entry) });
    const adapter = new LocalPrivateOwnerReplyAdapter(router);
    await expect(replyErrorCode(() => adapter.submit('{not-json'))).resolves.toBe(
      'INVALID_ENVELOPE',
    );
    expect(audit).toMatchObject([{ deliveryState: 'rejected', errorCode: 'INVALID_ENVELOPE' }]);
  });

  it('rejects wrong correlation, route handle, and sender binding', async () => {
    const { router } = fixtureRouter();
    await expect(
      replyErrorCode(() =>
        router.route(reply(OWNER_REPLY_WAIT_ID, 0, { event_id: OTHER_EVENT_ID })),
      ),
    ).resolves.toBe('UNKNOWN_CORRELATION');
    await expect(
      replyErrorCode(() =>
        router.route(reply(OWNER_REPLY_WAIT_ID, 0, { return_route: 'route_WRONG00000000000000' })),
      ),
    ).resolves.toBe('ROUTE_HANDLE_MISMATCH');
    await expect(
      replyErrorCode(() =>
        router.route(reply(OWNER_REPLY_WAIT_ID, 0, { sender_id: 'install_WRONG000000000000' })),
      ),
    ).resolves.toBe('SENDER_MISMATCH');
  });

  it('rejects a duplicate incompatible terminal decision explicitly', async () => {
    const { router, sink } = fixtureRouter();
    await router.route(reply(OWNER_REPLY_OK_ID, 1));
    await expect(replyErrorCode(() => router.route(reply(OWNER_REPLY_NO_ID, 2)))).resolves.toBe(
      'TERMINAL_DECISION_CONFLICT',
    );
    expect(sink.signals).toHaveLength(1);
  });

  it('does not consume a sequence when owner-sink delivery fails', async () => {
    const sink = new FailsOnceSink();
    const router = new OwnerReplyRouter();
    router.register({
      eventId: EVENT_ID,
      returnRoute: ROUTE,
      allowedSenderIds: [SENDER_ID],
      sink,
    });
    await expect(replyErrorCode(() => router.route(reply(OWNER_REPLY_WAIT_ID, 3)))).resolves.toBe(
      'DELIVERY_FAILED',
    );
    expect(router.snapshot(EVENT_ID)).toMatchObject({ state: 'pending', lastSequence: undefined });
    await expect(router.route(reply(OWNER_REPLY_WAIT_ID, 3))).resolves.toEqual({
      state: 'waiting',
      terminal: false,
    });
  });

  it('serializes replies deterministically in canonical IDs-only field order', () => {
    const expected =
      '{"protocol_version":"0.1","event_id":"10000000-0000-4000-8000-000000000001",' +
      `"reply_macro_id":"${OWNER_REPLY_WAIT_ID}","sequence":9,` +
      '"timestamp":"2026-09-03T00:01:00.000Z","sender_id":"install_7V3W9X2Y6Z8A4BCD",' +
      '"return_route":"route_8R4T2V6W9X3Y7ZAB"}';
    expect(serializeOwnerDecisionReply(reply(OWNER_REPLY_WAIT_ID, 9))).toBe(expected);
    expect(serializeOwnerDecisionReply(JSON.parse(expected))).toBe(expected);
    expect(expected).not.toMatch(/APPROVE|REJECT|WAIT/);
  });

  it('keeps the client schema and macro-pack artifact aligned with the router catalog', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../docs/schemas/owner-decision-reply-v0.1.schema.json', import.meta.url),
        'utf8',
      ),
    ) as { properties: { reply_macro_id: { enum: string[] } } };
    const pack = JSON.parse(
      readFileSync(
        new URL('../../docs/artifacts/owner-reply-macro-pack-v0.1.json', import.meta.url),
        'utf8',
      ),
    ) as { macros: { id: string; terminal: boolean }[] };
    const canonicalIds = [OWNER_REPLY_OK_ID, OWNER_REPLY_NO_ID, OWNER_REPLY_WAIT_ID];
    expect(schema.properties.reply_macro_id.enum).toEqual(canonicalIds);
    expect(pack.macros.map((macro) => macro.id)).toEqual(canonicalIds);
    expect(pack.macros.map((macro) => macro.terminal)).toEqual([true, true, false]);
  });

  it('logs IDs, sequence, timestamps, delivery state, and hashes without expansion text', async () => {
    const audit: OwnerReplyAuditEntry[] = [];
    const { router } = fixtureRouter({ audit: (entry) => audit.push(entry) });
    await router.route(reply(OWNER_REPLY_WAIT_ID, 0));
    await replyErrorCode(() => router.route(reply(OWNER_REPLY_WAIT_ID, 0)));
    expect(audit).toMatchObject([
      {
        replyMacroId: OWNER_REPLY_WAIT_ID,
        sequence: 0,
        clientTimestamp: '2026-09-03T00:01:00.000Z',
        observedAt: '2026-09-03T00:02:00.000Z',
        deliveryState: 'delivered',
      },
      { deliveryState: 'rejected', errorCode: 'REPLAYED_SEQUENCE' },
    ]);
    expect(audit[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(audit[0]?.routeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(audit)).not.toContain('Kérlek, várj');
  });

  it('runs client reply -> private adapter -> N Agent router -> opaque owner sink', async () => {
    const delivery = createOwnerNotificationDelivery(notificationFixture(), ROUTE);
    expect(delivery.reply_context).toEqual({ return_route: ROUTE });
    expect(JSON.stringify(delivery.notification)).not.toContain('Action needed.');
    expect(delivery.expansions.map((entry) => entry.text)).toEqual([
      'Action needed.',
      'A decision is required.',
      'Approval is required.',
    ]);

    const { router, sink } = fixtureRouter();
    const transport = new LocalOwnerReplyTransport(new LocalPrivateOwnerReplyAdapter(router));
    await transport.send(reply(OWNER_REPLY_WAIT_ID, 0));
    await transport.send(reply(OWNER_REPLY_NO_ID, 1));
    expect(sink.signals.map((signal) => [signal.replyMacroId, signal.effect])).toEqual([
      [OWNER_REPLY_WAIT_ID, 'wait'],
      [OWNER_REPLY_NO_ID, 'reject'],
    ]);
  });

  it('keeps transport output independent from trusted endpoint expansion text', () => {
    const wire = serializeOwnerDecisionReply(reply(OWNER_REPLY_OK_ID));
    const localized = replyMacroExpansions.map((entry) => ({
      ...entry,
      label: `xx:${entry.label}`,
    }));
    expect(localized[0]?.label).not.toBe(replyMacroExpansions[0]?.label);
    expect(serializeOwnerDecisionReply(reply(OWNER_REPLY_OK_ID))).toBe(wire);
    for (const expansion of replyMacroExpansions) expect(wire).not.toContain(expansion.label);
  });
});
