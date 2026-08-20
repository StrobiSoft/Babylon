import type { QueryResultRow } from 'pg';
import type { Clock, Database } from './types.js';

export type DeliveryState = 'pending' | 'delivered' | 'expired' | 'failed';

interface DeliveryRow extends QueryResultRow {
  request_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  payload: Buffer | null;
  payload_format: 'transport-v1';
  state: DeliveryState;
  failure_code: string | null;
  created_at: Date;
  expires_at: Date;
  delivered_at: Date | null;
}

export class MessageDeliveryService {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly ttlSeconds = 86_400,
    private readonly tombstoneSeconds = 86_400,
  ) {
    if (ttlSeconds < 60 || ttlSeconds > 604_800 || tombstoneSeconds < 60) {
      throw new Error('Invalid message delivery retention policy.');
    }
  }

  async accept(input: {
    requestId: string;
    senderUserId: string;
    recipientUserId: string;
    payload: Buffer;
    payloadFormat: 'transport-v1';
  }) {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);
    return this.database.transaction(async (client) => {
      const inserted = await client.query<DeliveryRow>(
        `INSERT INTO message_deliveries
           (request_id, sender_user_id, recipient_user_id, payload, payload_format, state, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         ON CONFLICT (sender_user_id, request_id) DO NOTHING
         RETURNING request_id, sender_user_id, recipient_user_id, payload, payload_format, state,
                   failure_code, created_at, expires_at, delivered_at`,
        [
          input.requestId,
          input.senderUserId,
          input.recipientUserId,
          input.payload,
          input.payloadFormat,
          now,
          expiresAt,
        ],
      );
      if (inserted.rows[0]) return this.publicState(inserted.rows[0]);
      const existing = await client.query<DeliveryRow>(
        `SELECT request_id, sender_user_id, recipient_user_id, payload, payload_format, state,
                failure_code, created_at, expires_at, delivered_at
           FROM message_deliveries WHERE sender_user_id = $1 AND request_id = $2 FOR UPDATE`,
        [input.senderUserId, input.requestId],
      );
      const row = this.requiredRow(existing.rows[0]);
      if (row.recipient_user_id !== input.recipientUserId) throw new DeliveryConflictError();
      return this.publicState(row);
    });
  }

  async listPending(recipientUserId: string, limit: number) {
    await this.expireDue(limit);
    const result = await this.database.query<DeliveryRow>(
      `SELECT request_id, sender_user_id, recipient_user_id, payload, payload_format, state, failure_code,
              created_at, expires_at, delivered_at
         FROM message_deliveries
        WHERE recipient_user_id = $1 AND state = 'pending' AND expires_at > $2
        ORDER BY created_at LIMIT $3`,
      [recipientUserId, this.clock.now(), limit],
    );
    return result.rows.map((row) => ({
      ...this.publicState(row),
      senderId: row.sender_user_id,
      payload: this.requiredPayload(row).toString('base64'),
    }));
  }

  async acknowledge(recipientUserId: string, requestId: string, senderUserId: string) {
    return this.database.transaction(async (client) => {
      const found = await client.query<DeliveryRow>(
        `SELECT request_id, recipient_user_id, payload, payload_format, state, failure_code,
                created_at, expires_at, delivered_at
           FROM message_deliveries WHERE sender_user_id = $1 AND request_id = $2 FOR UPDATE`,
        [senderUserId, requestId],
      );
      const row = found.rows[0];
      if (row?.recipient_user_id !== recipientUserId) throw new DeliveryNotFoundError();
      if (row.state === 'delivered') return this.publicState(row);
      if (row.state !== 'pending') return this.publicState(row);
      const now = this.clock.now();
      if (row.expires_at <= now) {
        const expired = await client.query<DeliveryRow>(
          `UPDATE message_deliveries SET state = 'expired', payload = NULL, terminal_at = $3
           WHERE sender_user_id = $1 AND request_id = $2
           RETURNING request_id, recipient_user_id, payload, payload_format, state, failure_code,
                     created_at, expires_at, delivered_at`,
          [senderUserId, requestId, now],
        );
        return this.publicState(this.requiredRow(expired.rows[0]));
      }
      const updated = await client.query<DeliveryRow>(
        `UPDATE message_deliveries SET state = 'delivered', payload = NULL,
          delivered_at = $3, terminal_at = $3
         WHERE sender_user_id = $1 AND request_id = $2
         RETURNING request_id, recipient_user_id, payload, payload_format, state, failure_code,
                   created_at, expires_at, delivered_at`,
        [senderUserId, requestId, now],
      );
      return this.publicState(this.requiredRow(updated.rows[0]));
    });
  }

  async status(senderUserId: string, requestId: string) {
    await this.expireDue(100);
    const result = await this.database.query<DeliveryRow>(
      `SELECT request_id, recipient_user_id, payload, payload_format, state, failure_code,
              created_at, expires_at, delivered_at
         FROM message_deliveries WHERE sender_user_id = $1 AND request_id = $2`,
      [senderUserId, requestId],
    );
    if (!result.rows[0]) throw new DeliveryNotFoundError();
    return this.publicState(result.rows[0]);
  }

  async failUnrecoverable(
    senderUserId: string,
    requestId: string,
    failureCode: 'recipient_unavailable' | 'invalid_payload' | 'retry_exhausted',
  ) {
    const result = await this.database.query<DeliveryRow>(
      `UPDATE message_deliveries SET state = 'failed', payload = NULL,
              failure_code = $3, terminal_at = $4
         WHERE sender_user_id = $1 AND request_id = $2 AND state = 'pending'
       RETURNING request_id, sender_user_id, recipient_user_id, payload, payload_format, state,
                 failure_code, created_at, expires_at, delivered_at`,
      [senderUserId, requestId, failureCode, this.clock.now()],
    );
    return this.publicState(this.requiredRow(result.rows[0]));
  }

  async cleanup(limit = 100): Promise<{ expired: number; deleted: number }> {
    const expired = await this.expireDue(limit);
    const cutoff = new Date(this.clock.now().getTime() - this.tombstoneSeconds * 1000);
    const deleted = await this.database.query(
      `DELETE FROM message_deliveries WHERE ctid IN
       (SELECT ctid FROM message_deliveries WHERE state <> 'pending' AND terminal_at <= $1 LIMIT $2)`,
      [cutoff, limit],
    );
    return { expired, deleted: deleted.rowCount ?? 0 };
  }

  private async expireDue(limit: number): Promise<number> {
    const result = await this.database.query(
      `UPDATE message_deliveries SET state = 'expired', payload = NULL, terminal_at = $1
       WHERE ctid IN (SELECT ctid FROM message_deliveries
         WHERE state = 'pending' AND expires_at <= $1 ORDER BY expires_at LIMIT $2)`,
      [this.clock.now(), limit],
    );
    return result.rowCount ?? 0;
  }

  private requiredRow(row: DeliveryRow | undefined): DeliveryRow {
    if (!row) throw new Error('Delivery persistence returned no row.');
    return row;
  }

  private requiredPayload(row: DeliveryRow): Buffer {
    if (!row.payload) throw new Error('Pending delivery payload is missing.');
    return row.payload;
  }

  private publicState(row: DeliveryRow) {
    return {
      requestId: row.request_id,
      state: row.state,
      failureCode: row.failure_code,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deliveredAt: row.delivered_at,
      payloadFormat: row.payload_format,
    };
  }
}

export class DeliveryConflictError extends Error {}
export class DeliveryNotFoundError extends Error {}
