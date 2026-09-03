import { describe, expect, it } from 'vitest';
import { EventSerializingPrivateOwnerReplyAdapter } from '../src/owner-notifications/event-serializing-private-adapter.js';
import {
  LocalPrivateOwnerReplyAdapter,
  OwnerReplyRouter,
  type OwnerWorkflowSink,
} from '../src/owner-notifications/index.js';
import { OWNER_REPLY_WAIT_ID } from '../src/reply-macros/index.js';

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const SENDER_ID = 'install_7V3W9X2Y6Z8A4BCD';
const ROUTE = 'route_8R4T2V6W9X3Y7ZAB';

class ControlledSink implements OwnerWorkflowSink {
  private resolveStarted: (() => void) | undefined;
  private resolveConsumption: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  consume(): Promise<void> {
    this.resolveStarted?.();
    return new Promise<void>((resolve) => {
      this.resolveConsumption = resolve;
    });
  }

  release(): void {
    this.resolveConsumption?.();
  }
}

function serializedWaitReply(sequence: number): string {
  return JSON.stringify({
    protocol_version: '0.1',
    event_id: EVENT_ID,
    reply_macro_id: OWNER_REPLY_WAIT_ID,
    sequence,
    timestamp: '2026-09-03T00:01:00.000Z',
    sender_id: SENDER_ID,
    return_route: ROUTE,
  });
}

describe('private owner-reply adapter ordering', () => {
  it('makes reconciliation wait until an in-flight reply is consumed', async () => {
    const sink = new ControlledSink();
    const router = new OwnerReplyRouter();
    router.register({
      eventId: EVENT_ID,
      returnRoute: ROUTE,
      allowedSenderIds: [SENDER_ID],
      sink,
    });
    const adapter = new EventSerializingPrivateOwnerReplyAdapter(
      new LocalPrivateOwnerReplyAdapter(router),
    );

    const submission = adapter.submit(serializedWaitReply(8));
    await sink.started;

    let reconciliationSettled = false;
    const reconciliation = adapter
      .reconcile({
        eventId: EVENT_ID,
        returnRoute: ROUTE,
        senderId: SENDER_ID,
      })
      .then((snapshot) => {
        reconciliationSettled = true;
        return snapshot;
      });

    await Promise.resolve();
    expect(reconciliationSettled).toBe(false);

    sink.release();
    await expect(submission).resolves.toEqual({ state: 'waiting', terminal: false });
    await expect(reconciliation).resolves.toMatchObject({
      state: 'waiting',
      lastSequence: 8,
      lastReplyMacroId: OWNER_REPLY_WAIT_ID,
    });
  });
});
