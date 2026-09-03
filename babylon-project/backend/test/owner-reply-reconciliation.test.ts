import { describe, expect, it } from 'vitest';
import {
  LocalPrivateOwnerReplyAdapter,
  OwnerReplyError,
  OwnerReplyRouter,
  type OwnerWorkflowSignal,
  type OwnerWorkflowSink,
} from '../src/owner-notifications/index.js';
import { OWNER_REPLY_OK_ID, OWNER_REPLY_WAIT_ID } from '../src/reply-macros/index.js';

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const UNKNOWN_EVENT_ID = '10000000-0000-4000-8000-000000000099';
const SENDER_ID = 'install_7V3W9X2Y6Z8A4BCD';
const ROUTE = 'route_8R4T2V6W9X3Y7ZAB';

class RecordingSink implements OwnerWorkflowSink {
  readonly signals: OwnerWorkflowSignal[] = [];

  consume(signal: OwnerWorkflowSignal): Promise<void> {
    this.signals.push(signal);
    return Promise.resolve();
  }
}

class RejectingSink implements OwnerWorkflowSink {
  consume(): Promise<void> {
    return Promise.reject(new Error('fixture rejection'));
  }
}

function reply(replyMacroId: string, sequence: number) {
  return {
    protocol_version: '0.1',
    event_id: EVENT_ID,
    reply_macro_id: replyMacroId,
    sequence,
    timestamp: '2026-09-03T00:01:00.000Z',
    sender_id: SENDER_ID,
    return_route: ROUTE,
  };
}

function routerWith(sink: OwnerWorkflowSink) {
  const router = new OwnerReplyRouter();
  router.register({
    eventId: EVENT_ID,
    returnRoute: ROUTE,
    allowedSenderIds: [SENDER_ID],
    sink,
  });
  return router;
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerReplyError);
    return (error as OwnerReplyError).code;
  }
}

describe('owner reply route-bound reconciliation', () => {
  it(
    'records the last non-terminal macro so a lost WAIT acknowledgement can be proven',
    async () => {
      const router = routerWith(new RecordingSink());
      await router.route(reply(OWNER_REPLY_WAIT_ID, 4));

      expect(
        router.reconcile({
          eventId: EVENT_ID,
          returnRoute: ROUTE,
          senderId: SENDER_ID,
        }),
      ).toEqual({
        state: 'waiting',
        lastSequence: 4,
        lastReplyMacroId: OWNER_REPLY_WAIT_ID,
        terminalMacroId: undefined,
      });
    },
  );

  it(
    'returns terminal state and the exact last accepted macro after a later decision',
    async () => {
      const router = routerWith(new RecordingSink());
      await router.route(reply(OWNER_REPLY_WAIT_ID, 0));
      await router.route(reply(OWNER_REPLY_OK_ID, 1));

      expect(
        router.reconcile({
          eventId: EVENT_ID,
          returnRoute: ROUTE,
          senderId: SENDER_ID,
        }),
      ).toEqual({
        state: 'approved',
        lastSequence: 1,
        lastReplyMacroId: OWNER_REPLY_OK_ID,
        terminalMacroId: OWNER_REPLY_OK_ID,
      });
    },
  );

  it('requires the exact route capability and allowed sender binding', () => {
    const router = routerWith(new RecordingSink());

    expect(
      errorCode(() =>
        router.reconcile({
          eventId: UNKNOWN_EVENT_ID,
          returnRoute: ROUTE,
          senderId: SENDER_ID,
        }),
      ),
    ).toBe('UNKNOWN_CORRELATION');
    expect(
      errorCode(() =>
        router.reconcile({
          eventId: EVENT_ID,
          returnRoute: 'route_WRONG00000000000000',
          senderId: SENDER_ID,
        }),
      ),
    ).toBe('ROUTE_HANDLE_MISMATCH');
    expect(
      errorCode(() =>
        router.reconcile({
          eventId: EVENT_ID,
          returnRoute: ROUTE,
          senderId: 'install_WRONG000000000000',
        }),
      ),
    ).toBe('SENDER_MISMATCH');
  });

  it('does not report an unconsumed reply after workflow-sink failure', async () => {
    const router = routerWith(new RejectingSink());
    await expect(router.route(reply(OWNER_REPLY_WAIT_ID, 3))).rejects.toMatchObject({
      code: 'DELIVERY_FAILED',
    });

    expect(
      router.reconcile({
        eventId: EVENT_ID,
        returnRoute: ROUTE,
        senderId: SENDER_ID,
      }),
    ).toEqual({
      state: 'pending',
      lastSequence: undefined,
      lastReplyMacroId: undefined,
      terminalMacroId: undefined,
    });
  });

  it('exposes the same bounded reconciliation through the local private adapter seam', async () => {
    const router = routerWith(new RecordingSink());
    const adapter = new LocalPrivateOwnerReplyAdapter(router);
    await adapter.submit(JSON.stringify(reply(OWNER_REPLY_WAIT_ID, 2)));

    expect(
      adapter.reconcile({
        eventId: EVENT_ID,
        returnRoute: ROUTE,
        senderId: SENDER_ID,
      }),
    ).toMatchObject({
      state: 'waiting',
      lastSequence: 2,
      lastReplyMacroId: OWNER_REPLY_WAIT_ID,
    });
  });
});
