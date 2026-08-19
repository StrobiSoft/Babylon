import type { TranslationPendingReason, TranslationResult } from './contracts.js';
import type {
  PendingTranslationJob,
  PendingTranslationPayload,
} from './pending-translation-store.js';

export interface PendingTranslationProcessor {
  process(payload: PendingTranslationPayload): Promise<TranslationResult>;
}

export interface PendingTranslationQueue {
  deleteExpired(): Promise<number>;
  claimDue(limit?: number): Promise<PendingTranslationJob[]>;
  reschedule(
    requestId: string,
    reason: TranslationPendingReason,
    attemptCount: number,
  ): Promise<void>;
  complete(requestId: string): Promise<void>;
}

export interface PendingTranslationWorkerOptions {
  batchSize?: number;
}

export interface PendingTranslationWorkerResult {
  claimed: number;
  completed: number;
  rescheduled: number;
  expiredDeleted: number;
}

export class PendingTranslationWorker {
  readonly #store: PendingTranslationQueue;
  readonly #processor: PendingTranslationProcessor;
  readonly #batchSize: number;

  constructor(
    store: PendingTranslationQueue,
    processor: PendingTranslationProcessor,
    options: Readonly<PendingTranslationWorkerOptions> = {},
  ) {
    this.#store = store;
    this.#processor = processor;
    this.#batchSize = options.batchSize ?? 10;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 100) {
      throw new Error('Pending translation worker batch size must be between 1 and 100.');
    }
  }

  async runOnce(): Promise<PendingTranslationWorkerResult> {
    const expiredDeleted = await this.#store.deleteExpired();
    const jobs = await this.#store.claimDue(this.#batchSize);
    let completed = 0;
    let rescheduled = 0;

    for (const job of jobs) {
      const outcome = await this.#processJob(job);
      if (outcome === 'completed') completed += 1;
      else rescheduled += 1;
    }

    return { claimed: jobs.length, completed, rescheduled, expiredDeleted };
  }

  async #processJob(job: PendingTranslationJob): Promise<'completed' | 'rescheduled'> {
    try {
      const result = await this.#processor.process(job.payload);
      if (result.status === 'translation_pending') {
        await this.#store.reschedule(job.payload.requestId, result.reason, job.attemptCount);
        return 'rescheduled';
      }

      await this.#store.complete(job.payload.requestId);
      return 'completed';
    } catch {
      await this.#store.reschedule(job.payload.requestId, 'technical_failure', job.attemptCount);
      return 'rescheduled';
    }
  }
}
