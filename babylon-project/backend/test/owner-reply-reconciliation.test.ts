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

class DeferredSink implements OwnerWorkflowSink {
  readonly signals: OwnerWorkflowSignal[] = [];
  readonly entered: Promise<void>;
  private readonly gate: Promise<void>;
  private enter: () => void = () => undefined;
  private release: () => void = () => undefined;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.enter = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  consume(signal: OwnerWorkflowSignal): Promise<void> {
    this.signals.push(signal);
    this.enter();
    return this.gate;
  }

  unblock(): void {
    this.release();
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

async function errorCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerReplyError);
    return (error as OwnerReplyError).code;
  }
}

const lookup = {
  eventId: EVENT_ID,
  returnRoute: ROUTE,
  senderId: SENDER_ID,
};

describe('owner reply route-bound reconciliation', () => {
  it('records the last non-terminal macro so a lost WAIT acknowledgement can be proven', async () => {
    const router = routerWith(new RecordingSink());
    await router.route(reply(OWNER_REPLY_WAIT_ID, 4));

    await expect(router.reconcile(lookup)).resolves.toEqual({
      state: 'waiting',
      lastSequence: 4,
      lastReplyMacroId: OWNER_REPLY_WAIT_ID,
      terminalMacroId: undefined,
    });
  });

  it('returns terminal state and the exact last accepted macro after a later decision', async () => {
    const router = routerWith(new RecordingSink());
    await router.route(reply(OWNER_REPLY_WAIT_ID, 0));
    await router.route(reply(OWNER_REPLY_OK_ID, 1));

    await expect(router.reconcile(lookup)).resolves.toEqual({
      state: 'approved',
      lastSequence: 1,
      lastReplyMacroId: OWNER_REPLY_OK_ID,
      terminalMacroId: OWNER_REPLY_OK_ID,
    });
  });

  it('requires the exact route capability and allowed sender binding', async () => {
    const router = routerWith(new RecordingSink());

    await expect(
      errorCode(() =>
        router.reconcile({
          eventId: UNKNOWN_EVENT_ID,
          returnRoute: ROUTE,
          senderId: SENDER_ID,
        }),
      ),
    ).resolves.toBe('UNKNOWN_CORRELATION');
    await expect(
      errorCode(() =>
        router.reconcile({
          eventId: EVENT_ID,
          returnRoute: 'route_WRONG00000000000000',
          senderId: SENDER_ID,
        }),
      ),
    ).resolves.toBe('ROUTE_HANDLE_MISMATCH');
    await expect(
      errorCode(() =>
        router.reconcile({
          eventId: EVENT_ID,
          returnRoute: ROUTE,
          senderId: 'install_WRONG000000000000',
        }),
      ),
    ).resolves.toBe('SENDER_MISMATCH');
  });

  it('does not report an unconsumed reply after workflow-sink failure', async () => {
    const router = routerWith(new RejectingSink());
    await expect(router.route(reply(OWNER_REPLY_WAIT_ID, 3))).rejects.toMatchObject({
      code: 'DELIVERY_FAILED',
    });

    await expect(router.reconcile(lookup)).resolves.toEqual({
      state: 'pending',
      lastSequence: undefined,
      lastReplyMacroId: undefined,
      terminalMacroId: undefined,
    });
  });

  it('waits behind an in-flight delivery before reporting route state', async () => {
    const sink = new DeferredSink();
    const router = routerWith(sink);
    const delivery = router.route(reply(OWNER_REPLY_WAIT_ID, 0));
    await sink.entered;

    let reconciliationSettled = false;
    const reconciliation = router.reconcile(lookup).then((snapshot) => {
      reconciliationSettled = true;
      return snapshot;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reconciliationSettled).toBe(false);

    sink.unblock();
    await expect(delivery).resolves.toEqual({ state: 'waiting', terminal: false });
    await expect(reconciliation).resolves.toEqual({
      state: 'waiting',
      lastSequence: 0,
      lastReplyMacroId: OWNER_REPLY_WAIT_ID,
      terminalMacroId: undefined,
    });
  });

  it('returns an explicit accepted sequence and exposes bounded reconciliation in the adapter', async () => {
    const router = routerWith(new RecordingSink());
    const adapter = new LocalPrivateOwnerReplyAdapter(router);

    await expect(adapter.submit(JSON.stringify(reply(OWNER_REPLY_WAIT_ID, 2)))).resolves.toEqual({
      accepted_sequence: 2,
      state: 'waiting',
      terminal: false,
    });
    await expect(adapter.reconcile(lookup)).resolves.toMatchObject({
      state: 'waiting',
      lastSequence: 2,
      lastReplyMacroId: OWNER_REPLY_WAIT_ID,
    });
  });
});
