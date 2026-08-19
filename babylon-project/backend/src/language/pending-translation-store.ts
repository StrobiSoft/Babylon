import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { addSeconds, systemClock } from '../crypto.js';
import type { Clock, Database } from '../types.js';
import {
  supportedLanguageSchema,
  translationPendingReasonSchema,
  translationStyleSchema,
  type TranslationPendingReason,
} from './contracts.js';
import { inputModeSchema } from './language-agent.js';

const pendingPayloadSchema = z
  .object({
    requestId: z.uuid(),
    sourceText: z.string().min(1).max(65_536),
    targetLanguage: supportedLanguageSchema,
    style: translationStyleSchema.optional(),
    inputMode: inputModeSchema,
  })
  .strict();

export type PendingTranslationPayload = z.infer<typeof pendingPayloadSchema>;

export interface PendingTranslationJob {
  payload: PendingTranslationPayload;
  reason: TranslationPendingReason;
  attemptCount: number;
  expiresAt: Date;
}

interface PendingRow {
  request_id: string;
  encrypted_payload: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  reason: string;
  attempt_count: number;
  expires_at: Date;
}

export interface PendingTranslationStoreOptions {
  ttlSeconds?: number;
  retryDelaySeconds?: number;
  clock?: Clock;
}

export class PendingTranslationStore {
  readonly #database: Database;
  readonly #key: Buffer;
  readonly #ttlSeconds: number;
  readonly #retryDelaySeconds: number;
  readonly #clock: Clock;

  constructor(
    database: Database,
    encryptionKey: Buffer,
    options: Readonly<PendingTranslationStoreOptions> = {},
  ) {
    if (encryptionKey.length !== 32) {
      throw new Error('Pending translation encryption key must be exactly 32 bytes.');
    }
    this.#database = database;
    this.#key = Buffer.from(encryptionKey);
    this.#ttlSeconds = options.ttlSeconds ?? 3600;
    this.#retryDelaySeconds = options.retryDelaySeconds ?? 30;
    this.#clock = options.clock ?? systemClock;
    if (this.#ttlSeconds <= 0 || this.#retryDelaySeconds <= 0) {
      throw new Error('Pending translation timing values must be positive.');
    }
  }

  async enqueue(
    payload: PendingTranslationPayload,
    reason: TranslationPendingReason,
  ): Promise<void> {
    const parsedPayload = pendingPayloadSchema.parse(payload);
    const parsedReason = translationPendingReasonSchema.parse(reason);
    const now = this.#clock.now();
    const expiresAt = addSeconds(now, this.#ttlSeconds);
    const nextAttemptAt = addSeconds(now, this.#retryDelaySeconds);
    const encrypted = encryptPayload(parsedPayload, this.#key);

    await this.#database.query(
      `INSERT INTO translation_pending_jobs (
         request_id, encrypted_payload, iv, auth_tag, reason,
         attempt_count, next_attempt_at, expires_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $8)
       ON CONFLICT (request_id) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         reason = EXCLUDED.reason,
         next_attempt_at = EXCLUDED.next_attempt_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [
        parsedPayload.requestId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        parsedReason,
        nextAttemptAt,
        expiresAt,
        now,
      ],
    );
  }

  async claimDue(limit = 10): Promise<PendingTranslationJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Pending translation claim limit must be between 1 and 100.');
    }
    const now = this.#clock.now();
    const leaseUntil = addSeconds(now, this.#retryDelaySeconds);

    const rows = await this.#database.transaction(async (client) => {
      const result = await client.query<PendingRow>(
        `WITH due AS (
           SELECT request_id
           FROM translation_pending_jobs
           WHERE next_attempt_at <= $1 AND expires_at > $1
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE translation_pending_jobs AS jobs
         SET attempt_count = jobs.attempt_count + 1,
             next_attempt_at = $3,
             updated_at = $1
         FROM due
         WHERE jobs.request_id = due.request_id
         RETURNING jobs.request_id, jobs.encrypted_payload, jobs.iv, jobs.auth_tag,
                   jobs.reason, jobs.attempt_count, jobs.expires_at`,
        [now, limit, leaseUntil],
      );
      return result.rows;
    });

    return rows.map((row) => ({
      payload: decryptPayload(row, this.#key),
      reason: translationPendingReasonSchema.parse(row.reason),
      attemptCount: row.attempt_count,
      expiresAt: new Date(row.expires_at),
    }));
  }

  async reschedule(requestId: string, reason: TranslationPendingReason): Promise<void> {
    const parsedReason = translationPendingReasonSchema.parse(reason);
    const now = this.#clock.now();
    await this.#database.query(
      `UPDATE translation_pending_jobs
       SET reason = $2, next_attempt_at = $3, updated_at = $1
       WHERE request_id = $4 AND expires_at > $1`,
      [now, parsedReason, addSeconds(now, this.#retryDelaySeconds), requestId],
    );
  }

  async complete(requestId: string): Promise<void> {
    await this.#database.query('DELETE FROM translation_pending_jobs WHERE request_id = $1', [
      requestId,
    ]);
  }

  async deleteExpired(): Promise<number> {
    const result = await this.#database.query(
      'DELETE FROM translation_pending_jobs WHERE expires_at <= $1',
      [this.#clock.now()],
    );
    return result.rowCount ?? 0;
  }
}

function encryptPayload(
  payload: PendingTranslationPayload,
  key: Buffer,
): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(pendingPayloadSchema.parse(payload)), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptPayload(
  row: Pick<PendingRow, 'encrypted_payload' | 'iv' | 'auth_tag'>,
  key: Buffer,
): PendingTranslationPayload {
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAuthTag(row.auth_tag);
  const plaintext = Buffer.concat([
    decipher.update(row.encrypted_payload),
    decipher.final(),
  ]).toString('utf8');
  return pendingPayloadSchema.parse(JSON.parse(plaintext));
}
