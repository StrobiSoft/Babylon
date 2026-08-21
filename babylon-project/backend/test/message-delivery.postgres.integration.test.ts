import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../src/database.js';
import { DeliveryConflictError, MessageDeliveryService } from '../src/message-delivery.js';
import { runMigrations } from '../src/migrations.js';
import type { Clock } from '../src/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(databaseUrl);
const senderUserId = '10000000-0000-4000-8000-000000000001';
const recipientUserId = '10000000-0000-4000-8000-000000000002';
const requestId = '10000000-0000-4000-8000-000000000021';
const now = new Date('2026-08-21T12:00:00.000Z');
const clock: Clock = { now: () => new Date(now) };
const bindingSecret = 'postgres-integration-delivery-secret-0001';
let database: PostgresDatabase;
let service: MessageDeliveryService;

integration('PostgreSQL message delivery concurrency', () => {
  beforeAll(async () => {
    database = new PostgresDatabase(databaseUrl!);
    await runMigrations(database, fileURLToPath(new URL('../migrations', import.meta.url)));
    await database.query('TRUNCATE message_deliveries, users CASCADE');
    await database.query(
      `INSERT INTO users (id, email, status, created_at, updated_at)
       VALUES ($1, 'sender@integration.test', 'active', $3, $3),
              ($2, 'recipient@integration.test', 'active', $3, $3)`,
      [senderUserId, recipientUserId, now],
    );
    service = new MessageDeliveryService(database, clock, bindingSecret);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('serializes duplicate sends and ACKs into one content-free terminal delivery', async () => {
    const envelope = {
      requestId,
      senderUserId,
      recipientUserId,
      payload: Buffer.from('opaque integration payload'),
      payloadFormat: 'transport-v1' as const,
    };

    const accepted = await Promise.all(Array.from({ length: 8 }, () => service.accept(envelope)));
    expect(accepted.every((state) => state.state === 'pending')).toBe(true);
    const count = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM message_deliveries WHERE sender_user_id = $1 AND request_id = $2',
      [senderUserId, requestId],
    );
    expect(count.rows[0]?.count).toBe('1');

    // Hold the same row lock the service uses. A real ACK must remain blocked
    // until this transaction releases it, proving behavioral serialization.
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));
    const blocker = database.transaction(async (client) => {
      await client.query(
        'SELECT request_id FROM message_deliveries WHERE sender_user_id = $1 AND request_id = $2 FOR UPDATE',
        [senderUserId, requestId],
      );
      locked();
      await lockHeld;
    });
    await lockAcquired;
    let ackFinished = false;
    const firstAck = service.acknowledge(recipientUserId, requestId, senderUserId).then((state) => {
      ackFinished = true;
      return state;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(ackFinished).toBe(false);
    releaseLock();
    await blocker;

    const acknowledgements = await Promise.all([
      firstAck,
      ...Array.from({ length: 7 }, () =>
        service.acknowledge(recipientUserId, requestId, senderUserId),
      ),
    ]);
    expect(acknowledgements.every((state) => state.state === 'delivered')).toBe(true);

    const terminal = await database.query<{
      state: string;
      payload: Buffer | null;
      delivered_at: Date | null;
      terminal_at: Date | null;
    }>(
      `SELECT state, payload, delivered_at, terminal_at
         FROM message_deliveries WHERE sender_user_id = $1 AND request_id = $2`,
      [senderUserId, requestId],
    );
    expect(terminal.rows).toHaveLength(1);
    expect(terminal.rows[0]).toMatchObject({ state: 'delivered', payload: null });
    expect(terminal.rows[0]?.delivered_at).toEqual(now);
    expect(terminal.rows[0]?.terminal_at).toEqual(now);

    // Late duplicate operations stay idempotent, while immutable-envelope
    // conflicts remain rejected even after payload erasure.
    expect((await service.accept(envelope)).state).toBe('delivered');
    expect((await service.acknowledge(recipientUserId, requestId, senderUserId)).state).toBe(
      'delivered',
    );
    await expect(
      service.accept({ ...envelope, payload: Buffer.from('conflicting payload') }),
    ).rejects.toBeInstanceOf(DeliveryConflictError);
  });
});
