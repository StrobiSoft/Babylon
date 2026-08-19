import { z } from 'zod';
import { addSeconds } from '../crypto.js';
import {
  messageTextSchema,
  translationResultSchema,
  type TranslationResult,
} from '../language/contracts.js';
import type { LanguageAgentRequest } from '../language/language-agent.js';
import type { Clock } from '../types.js';
import type {
  PendingTranslationJob,
  PendingTranslationJobRepository,
} from './pending-translation-job.js';
import type { TransientPayloadCipher } from './transient-payload-cipher.js';

const sourcePayloadSchema = z.object({ sourceText: messageTextSchema }).strict();

export interface TranslationProcessor {
  process(request: unknown): Promise<TranslationResult>;
}

export interface PendingTranslationWorkerPolicy {
  maxAttempts: number;
  leaseSeconds: number;
  retryBaseSeconds: number;
  retryMaximumSeconds: number;
}

export type PendingTranslationWorkerResult =
  | 'idle'
  | 'ready'
  | 'retry_scheduled'
  | 'expired';

export class PendingTranslationWorker {
  readonly #repository: PendingTranslationJobRepository;
  readonly #cipher: TransientPayloadCipher;
  readonly #processor: TranslationProcessor;
  readonly #clock: Clock;
  readonly #policy: PendingTranslationWorkerPolicy;

  constructor(
    repository: PendingTranslationJobRepository,
    cipher: TransientPayloadCipher,
    processor: TranslationProcessor,
    clock: Clock,
    policy: PendingTranslationWorkerPolicy,
  ) {
    if (
      !Number.isInteger(policy.maxAttempts) ||
      policy.maxAttempts < 1 ||
      policy.maxAttempts > 100
    ) {
      throw new Error('Invalid maximum pending translation attempts.');
    }
    for (const value of [
      policy.leaseSeconds,
      policy.retryBaseSeconds,
      policy.retryMaximumSeconds,
    ]) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('Invalid pending translation timing policy.');
      }
    }
    if (policy.retryMaximumSeconds < policy.retryBaseSeconds) {
      throw new Error('Pending translation retry maximum must not be below the base delay.');
    }
    this.#repository = repository;
    this.#cipher = cipher;
    this.#processor = processor;
    this.#clock = clock;
    this.#policy = policy;
  }

  async runOnce(workerId: string): Promise<PendingTranslationWorkerResult> {
    const now = this.#clock.now();
    const nowIso = now.toISOString();
    const job = await this.#repository.claimNext({
      workerId,
      now: nowIso,
      leaseExpiresAt: addSeconds(now, this.#policy.leaseSeconds).toISOString(),
    });
    if (!job) return 'idle';

    try {
      const result = await this.#processJob(job);
      if (result.status === 'translation_pending') {
        return await this.#retryOrExpire(job, result.reason, now);
      }
      if (result.status === 'invalid_input') {
        return await this.#retryOrExpire(job, 'technical_failure', now);
      }

      const deliveryEnvelope = this.#cipher.encrypt(
        JSON.stringify(translationResultSchema.parse(result)),
        `${job.requestId}:delivery`,
      );
      await this.#repository.markReady({
        jobId: job.id,
        encryptedPayload: deliveryEnvelope,
        updatedAt: nowIso,
      });
      return 'ready';
    } catch {
      return await this.#retryOrExpire(job, 'technical_failure', now);
    }
  }

  async #processJob(job: PendingTranslationJob): Promise<TranslationResult> {
    if (job.encryptedPayload === null) {
      throw new Error('Pending translation payload is missing.');
    }
    const sourcePayload = sourcePayloadSchema.parse(
      JSON.parse(this.#cipher.decrypt(job.encryptedPayload, job.requestId)),
    );
    const request: LanguageAgentRequest = {
      requestId: job.requestId,
      sourceText: sourcePayload.sourceText,
      targetLanguage: job.targetLanguage,
      ...(job.style === undefined ? {} : { style: job.style }),
      inputMode: job.inputMode,
    };
    return translationResultSchema.parse(await this.#processor.process(request));
  }

  async #retryOrExpire(
    job: PendingTranslationJob,
    failureReason: NonNullable<PendingTranslationJob['lastFailureReason']>,
    now: Date,
  ): Promise<PendingTranslationWorkerResult> {
    const nowIso = now.toISOString();
    if (
      job.attemptCount >= this.#policy.maxAttempts ||
      now.getTime() >= Date.parse(job.expiresAt)
    ) {
      await this.#repository.expireProcessing(job.id, nowIso);
      return 'expired';
    }

    const exponent = Math.max(0, job.attemptCount - 1);
    const delay = Math.min(
      this.#policy.retryMaximumSeconds,
      this.#policy.retryBaseSeconds * 2 ** exponent,
    );
    await this.#repository.scheduleRetry({
      jobId: job.id,
      failureReason,
      nextAttemptAt: addSeconds(now, delay).toISOString(),
      updatedAt: nowIso,
    });
    return 'retry_scheduled';
  }
}
