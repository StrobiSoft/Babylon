import { describe, expect, it } from 'vitest';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DeliveryConflictError, MessageDeliveryService } from '../src/message-delivery.js';
import type { Clock, Database } from '../src/types.js';

const now = new Date('2026-08-20T12:00:00.000Z');
const clock: Clock = { now: () => new Date(now) };
const row = (state = 'pending') => ({
  request_id: '00000000-0000-4000-8000-000000000021',
  sender_user_id: '00000000-0000-4000-8000-000000000001',
  recipient_user_id: '00000000-0000-4000-8000-000000000002',
  payload: state === 'pending' ? Buffer.from('opaque') : null,
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
  it('returns the existing logical send for a repeated idempotency key without inserting', async () => {
    const db = new ScriptedDatabase([[], [row()]]);
    const service = new MessageDeliveryService(db, clock);
    const accepted = await service.accept({
      requestId: row().request_id,
      senderUserId: '00000000-0000-4000-8000-000000000001',
      recipientUserId: row().recipient_user_id,
      payload: Buffer.from('retry body is deliberately ignored'),
      payloadFormat: 'transport-v1',
    });
    expect(accepted.state).toBe('pending');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]).toContain('ON CONFLICT');
  });

  it('rejects reuse of an idempotency key for another recipient', async () => {
    const db = new ScriptedDatabase([[], [row()]]);
    const service = new MessageDeliveryService(db, clock);
    await expect(
      service.accept({
        requestId: row().request_id,
        senderUserId: '00000000-0000-4000-8000-000000000001',
        recipientUserId: '00000000-0000-4000-8000-000000000003',
        payload: Buffer.from('opaque'),
        payloadFormat: 'transport-v1',
      }),
    ).rejects.toBeInstanceOf(DeliveryConflictError);
  });

  it('treats duplicate and late delivery acknowledgements as terminal idempotent events', async () => {
    const db = new ScriptedDatabase([[row('delivered')], [row('expired')]]);
    const service = new MessageDeliveryService(db, clock);
    expect(
      (
        await service.acknowledge(
          row().recipient_user_id,
          row().request_id,
          '00000000-0000-4000-8000-000000000001',
        )
      ).state,
    ).toBe('delivered');
    expect(
      (
        await service.acknowledge(
          row().recipient_user_id,
          row().request_id,
          '00000000-0000-4000-8000-000000000001',
        )
      ).state,
    ).toBe('expired');
    expect(db.calls.every((sql) => !sql.startsWith('UPDATE'))).toBe(true);
  });

  it('serializes concurrent duplicate delivery events into one logical terminal result', async () => {
    const db = new ScriptedDatabase([[row('delivered')], [row('delivered')]]);
    const service = new MessageDeliveryService(db, clock);
    const states = await Promise.all([
      service.acknowledge(
        row().recipient_user_id,
        row().request_id,
        '00000000-0000-4000-8000-000000000001',
      ),
      service.acknowledge(
        row().recipient_user_id,
        row().request_id,
        '00000000-0000-4000-8000-000000000001',
      ),
    ]);
    expect(states.map((state) => state.state)).toEqual(['delivered', 'delivered']);
  });

  it('bounds expiry and terminal deletion cleanup batches and deletes payloads on expiry', async () => {
    const db = new ScriptedDatabase([[], []]);
    const service = new MessageDeliveryService(db, clock);
    await service.cleanup(17);
    expect(db.calls[0]).toContain("state = 'expired', payload = NULL");
    expect(db.calls[0]).toContain('LIMIT $2');
    expect(db.calls[1]).toContain("state <> 'pending'");
    expect(db.calls[1]).toContain('LIMIT $2');
  });
});
