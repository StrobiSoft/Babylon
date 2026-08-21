import { describe, expect, it } from 'vitest';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  createDeliveryBinding,
  DeliveryConflictError,
  DeliveryRecipientUnavailableError,
  MessageDeliveryService,
} from '../src/message-delivery.js';
import type { Clock, Database } from '../src/types.js';

const now = new Date('2026-08-20T12:00:00.000Z');
const clock: Clock = { now: () => new Date(now) };
const bindingSecret = 'babylon-test-delivery-binding-secret-0001';
const senderUserId = '00000000-0000-4000-8000-000000000001';
const recipientUserId = '00000000-0000-4000-8000-000000000002';
const requestId = '00000000-0000-4000-8000-000000000021';

const input = (payload = 'opaque', recipientId = recipientUserId) => ({
  requestId,
  senderUserId,
  recipientUserId: recipientId,
  payload: Buffer.from(payload),
  payloadFormat: 'transport-v1' as const,
});

const row = (state = 'pending') => ({
  request_id: requestId,
  sender_user_id: senderUserId,
  recipient_user_id: recipientUserId,
  payload: state === 'pending' ? Buffer.from('opaque') : null,
  request_binding: createDeliveryBinding(bindingSecret, input()),
  payload_format: 'transport-v1',
  state,
  failure_code: null,
  created_at: now,
  expires_at: new Date(now.getTime() + 60_000),
  delivered_at: state === 'delivered' ? now : null,
});

function result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
  return { command: 'SELECT', rowCount, oid: 0, rows, fields: [] };
}

class ScriptedDatabase implements Database {
  constructor(readonly scripts: QueryResultRow[][]) {}
  calls: string[] = [];
  async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
    this.calls.push(text);
    return result((this.scripts.shift() ?? []) as R[]);
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return work({ query: this.query.bind(this) } as unknown as PoolClient);
  }
  close() {
    return Promise.resolve();
  }
}

describe('transient message delivery lifecycle', () => {
  it('returns the existing logical send for the same immutable idempotent envelope', async () => {
    const db = new ScriptedDatabase([[], [row()]]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);
    const accepted = await service.accept(input());
    expect(accepted.state).toBe('pending');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]).toContain('ON CONFLICT');
  });

  it('rejects reuse of an idempotency key with different payload content', async () => {
    const db = new ScriptedDatabase([[], [row()]]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);
    await expect(service.accept(input('different opaque body'))).rejects.toBeInstanceOf(
      DeliveryConflictError,
    );
  });

  it('rejects reuse of an idempotency key for another recipient', async () => {
    const db = new ScriptedDatabase([[], [row()]]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);
    await expect(
      service.accept(input('opaque', '00000000-0000-4000-8000-000000000003')),
    ).rejects.toBeInstanceOf(DeliveryConflictError);
  });

  it('maps an invalid recipient foreign key without exposing PostgreSQL details', async () => {
    const databaseError = Object.assign(new Error('private PostgreSQL detail'), {
      code: '23503',
      constraint: 'message_deliveries_recipient_user_id_fkey',
      detail: `Key (recipient_user_id)=(${recipientUserId}) is not present`,
    });
    class RejectingDatabase extends ScriptedDatabase {
      override async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
        throw databaseError;
      }
    }
    const service = new MessageDeliveryService(new RejectingDatabase([]), clock, bindingSecret);
    await expect(service.accept(input())).rejects.toEqual(new DeliveryRecipientUnavailableError());
  });

  it('treats duplicate and late delivery acknowledgements as terminal idempotent events', async () => {
    const db = new ScriptedDatabase([[row('delivered')], [row('expired')]]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);
    expect((await service.acknowledge(recipientUserId, requestId, senderUserId)).state).toBe(
      'delivered',
    );
    expect((await service.acknowledge(recipientUserId, requestId, senderUserId)).state).toBe(
      'expired',
    );
    expect(db.calls.every((sql) => !sql.startsWith('UPDATE'))).toBe(true);
  });

  it('serializes concurrent duplicate delivery events into one logical terminal result', async () => {
    const db = new ScriptedDatabase([[row('delivered')], [row('delivered')]]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);
    const states = await Promise.all([
      service.acknowledge(recipientUserId, requestId, senderUserId),
      service.acknowledge(recipientUserId, requestId, senderUserId),
    ]);
    expect(states.map((state) => state.state)).toEqual(['delivered', 'delivered']);
  });

  it('expires the requested status row even when bulk cleanup ordering would not reach it', async () => {
    const due = { ...row(), expires_at: new Date(now.getTime() - 1) };
    const expired = { ...due, state: 'expired', payload: null };
    const db = new ScriptedDatabase([[due], [expired]]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);

    const state = await service.status(senderUserId, requestId);

    expect(state.state).toBe('expired');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]).toContain('FOR UPDATE');
    expect(db.calls[1]).toContain("state = 'expired', payload = NULL");
    expect(db.calls[1]).toContain('sender_user_id = $1 AND request_id = $2');
  });

  it('bounds expiry and terminal deletion cleanup batches and deletes payloads on expiry', async () => {
    const db = new ScriptedDatabase([[], []]);
    const service = new MessageDeliveryService(db, clock, bindingSecret);
    await service.cleanup(17);
    expect(db.calls[0]).toContain("state = 'expired', payload = NULL");
    expect(db.calls[0]).toContain('LIMIT $2');
    expect(db.calls[1]).toContain("state <> 'pending'");
    expect(db.calls[1]).toContain('LIMIT $2');
  });
});
