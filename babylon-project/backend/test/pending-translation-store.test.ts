import { describe, expect, it } from 'vitest';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PendingTranslationStore } from '../src/language/pending-translation-store.js';
import type { Clock, Database } from '../src/types.js';

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
}

function result<R extends QueryResultRow>(rows: R[] = []): QueryResult<R> {
  return {
    command: 'UPDATE',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
}

class RecordingDatabase implements Database {
  readonly calls: { text: string; values: unknown[] }[] = [];
  transactionRows: QueryResultRow[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    return result<R>();
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = {
      query: async <R extends QueryResultRow = QueryResultRow>(
        text: string,
        values: unknown[] = [],
      ): Promise<QueryResult<R>> => {
        this.calls.push({ text, values });
        return result(this.transactionRows as R[]);
      },
    } as unknown as PoolClient;
    return work(client);
  }

  async close(): Promise<void> {}
}

const key = Buffer.alloc(32, 7);
const now = new Date('2026-08-19T20:00:00.000Z');

describe('PendingTranslationStore retry policy', () => {
  it('rejects invalid retry policy values', () => {
    const database = new RecordingDatabase();
    expect(
      () =>
        new PendingTranslationStore(database, key, {
          baseRetryDelaySeconds: 60,
          maxRetryDelaySeconds: 30,
        }),
    ).toThrow('Invalid pending translation retry policy.');
    expect(
      () => new PendingTranslationStore(database, key, { maxAttempts: 0 }),
    ).toThrow('Invalid pending translation retry policy.');
  });

  it('claims only jobs below the explicit maximum attempt count and applies a processing lease', async () => {
    const database = new RecordingDatabase();
    const store = new PendingTranslationStore(database, key, {
      maxAttempts: 4,
      leaseSeconds: 120,
      clock: new FixedClock(now),
    });

    await store.claimDue(8);

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]!.text).toContain('attempt_count < $3');
    expect(database.calls[0]!.values).toEqual([
      now,
      8,
      4,
      new Date('2026-08-19T20:02:00.000Z'),
    ]);
  });

  it('uses exponential retry backoff capped at the configured maximum', async () => {
    const database = new RecordingDatabase();
    const store = new PendingTranslationStore(database, key, {
      baseRetryDelaySeconds: 30,
      maxRetryDelaySeconds: 90,
      maxAttempts: 5,
      clock: new FixedClock(now),
    });

    await store.reschedule('00000000-0000-4000-8000-000000000041', 'model_unavailable', 1);
    await store.reschedule('00000000-0000-4000-8000-000000000042', 'model_unavailable', 2);
    await store.reschedule('00000000-0000-4000-8000-000000000043', 'model_unavailable', 4);

    expect(database.calls.map((call) => call.values[2])).toEqual([
      new Date('2026-08-19T20:00:30.000Z'),
      new Date('2026-08-19T20:01:00.000Z'),
      new Date('2026-08-19T20:01:30.000Z'),
    ]);
    expect(database.calls.every((call) => call.text.includes('LEAST(expires_at, $3)'))).toBe(true);
  });

  it('rejects attempt counts outside the configured bound', async () => {
    const database = new RecordingDatabase();
    const store = new PendingTranslationStore(database, key, {
      maxAttempts: 3,
      clock: new FixedClock(now),
    });

    await expect(
      store.reschedule('00000000-0000-4000-8000-000000000044', 'technical_failure', 4),
    ).rejects.toThrow('Invalid pending translation attempt count.');
    expect(database.calls).toEqual([]);
  });
});
