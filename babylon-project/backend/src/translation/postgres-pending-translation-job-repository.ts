import type { QueryResultRow } from 'pg';
import type { Database, Queryable } from '../types.js';
import {
  pendingTranslationJobSchema,
  type ClaimPendingTranslationJobInput,
  type CreatePendingTranslationJobInput,
  type MarkPendingTranslationReadyInput,
  type PendingTranslationJob,
  type PendingTranslationJobRepository,
  type SchedulePendingTranslationRetryInput,
} from './pending-translation-job.js';

interface PendingTranslationJobRow extends QueryResultRow {
  id: string;
  request_id: string;
  request_fingerprint: string;
  state: string;
  encrypted_payload: Buffer | null;
  source_language: string | null;
  target_language: string;
  style: string | null;
  input_mode: string;
  attempt_count: number;
  last_failure_reason: string | null;
  next_attempt_at: Date | string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
}

const selectColumns = `
  id, request_id, request_fingerprint, state, encrypted_payload,
  source_language, target_language, style, input_mode, attempt_count,
  last_failure_reason, next_attempt_at, lease_owner, lease_expires_at,
  created_at, updated_at, expires_at
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoNullable(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapRow(row: PendingTranslationJobRow): PendingTranslationJob {
  return pendingTranslationJobSchema.parse({
    id: row.id,
    requestId: row.request_id,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    encryptedPayload:
      row.encrypted_payload === null ? null : row.encrypted_payload.toString('utf8'),
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    ...(row.style === null ? {} : { style: row.style }),
    inputMode: row.input_mode,
    attemptCount: row.attempt_count,
    lastFailureReason: row.last_failure_reason,
    nextAttemptAt: toIsoNullable(row.next_attempt_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toIsoNullable(row.lease_expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
  });
}

async function requireUpdatedJob(
  queryable: Queryable,
  sql: string,
  values: unknown[],
  operation: string,
): Promise<PendingTranslationJob> {
  const result = await queryable.query<PendingTranslationJobRow>(sql, values);
  const row = result.rows[0];
  if (!row) throw new Error(`Pending translation job ${operation} rejected by lifecycle state.`);
  return mapRow(row);
}

export class PendingTranslationIdempotencyConflictError extends Error {
  constructor() {
    super('The request id is already bound to a different translation request.');
    this.name = 'PendingTranslationIdempotencyConflictError';
  }
}

export class PostgresPendingTranslationJobRepository implements PendingTranslationJobRepository {
  constructor(private readonly database: Database) {}

  async createOrGetByRequestId(
    input: Readonly<CreatePendingTranslationJobInput>,
  ): Promise<PendingTranslationJob> {
    await this.database.query(
      `INSERT INTO pending_translation_jobs (
        id, request_id, request_fingerprint, state, encrypted_payload,
        target_language, style, input_mode, attempt_count, next_attempt_at,
        created_at, updated_at, expires_at
      ) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,0,$8,$8,$8,$9)
      ON CONFLICT (request_id) DO NOTHING`,
      [
        input.id,
        input.requestId,
        input.requestFingerprint,
        Buffer.from(input.encryptedPayload, 'utf8'),
        input.targetLanguage,
        input.style ?? null,
        input.inputMode,
        input.createdAt,
        input.expiresAt,
      ],
    );

    const existing = await this.findByRequestId(input.requestId);
    if (!existing) {
      throw new Error('Pending translation job insert did not produce a readable record.');
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new PendingTranslationIdempotencyConflictError();
    }
    return existing;
  }

  async findByRequestId(requestId: string): Promise<PendingTranslationJob | null> {
    const result = await this.database.query<PendingTranslationJobRow>(
      `SELECT ${selectColumns} FROM pending_translation_jobs WHERE request_id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async claimNext(
    input: Readonly<ClaimPendingTranslationJobInput>,
  ): Promise<PendingTranslationJob | null> {
    return this.database.transaction(async (client) => {
      const result = await client.query<PendingTranslationJobRow>(
        `WITH candidate AS (
          SELECT id
          FROM pending_translation_jobs
          WHERE state = 'pending'
            AND expires_at > $1
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY COALESCE(next_attempt_at, created_at), created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE pending_translation_jobs AS job
        SET state = 'processing',
            attempt_count = attempt_count + 1,
            lease_owner = $2,
            lease_expires_at = $3,
            updated_at = $1
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING ${selectColumns}`,
        [input.now, input.workerId, input.leaseExpiresAt],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    });
  }

  scheduleRetry(
    input: Readonly<SchedulePendingTranslationRetryInput>,
  ): Promise<PendingTranslationJob> {
    return requireUpdatedJob(
      this.database,
      `UPDATE pending_translation_jobs
       SET state = 'pending',
           last_failure_reason = $2,
           next_attempt_at = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = $4
       WHERE id = $1 AND state = 'processing'
       RETURNING ${selectColumns}`,
      [input.jobId, input.failureReason, input.nextAttemptAt, input.updatedAt],
      'retry scheduling',
    );
  }

  markReady(input: Readonly<MarkPendingTranslationReadyInput>): Promise<PendingTranslationJob> {
    return requireUpdatedJob(
      this.database,
      `UPDATE pending_translation_jobs
       SET state = 'ready_for_delivery',
           encrypted_payload = $2,
           source_language = $3,
           last_failure_reason = NULL,
           next_attempt_at = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = $4
       WHERE id = $1 AND state = 'processing'
       RETURNING ${selectColumns}`,
      [
        input.jobId,
        Buffer.from(input.encryptedPayload, 'utf8'),
        input.sourceLanguage,
        input.updatedAt,
      ],
      'ready transition',
    );
  }

  acknowledgeDelivery(jobId: string, acknowledgedAt: string): Promise<PendingTranslationJob> {
    return requireUpdatedJob(
      this.database,
      `UPDATE pending_translation_jobs
       SET state = 'delivered_acknowledged',
           encrypted_payload = NULL,
           next_attempt_at = NULL,
           updated_at = $2
       WHERE id = $1 AND state = 'ready_for_delivery'
       RETURNING ${selectColumns}`,
      [jobId, acknowledgedAt],
      'delivery acknowledgement',
    );
  }

  async expireDue(now: string, limit: number): Promise<number> {
    const result = await this.database.query(
      `WITH due AS (
        SELECT id
        FROM pending_translation_jobs
        WHERE state NOT IN ('delivered_acknowledged','expired')
          AND expires_at <= $1
        ORDER BY expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE pending_translation_jobs AS job
      SET state = 'expired',
          encrypted_payload = NULL,
          next_attempt_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = $1
      FROM due
      WHERE job.id = due.id`,
      [now, limit],
    );
    return result.rowCount ?? 0;
  }

  async releaseExpiredLeases(now: string, limit: number): Promise<number> {
    const result = await this.database.query(
      `WITH stale AS (
        SELECT id
        FROM pending_translation_jobs
        WHERE state = 'processing'
          AND lease_expires_at <= $1
          AND expires_at > $1
        ORDER BY lease_expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE pending_translation_jobs AS job
      SET state = 'pending',
          next_attempt_at = $1,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = $1
      FROM stale
      WHERE job.id = stale.id`,
      [now, limit],
    );
    return result.rowCount ?? 0;
  }
}
