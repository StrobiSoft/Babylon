import { describe, expect, it } from 'vitest';
import type { TranslationResult } from '../src/language/contracts.js';
import type {
  MarkPendingTranslationReadyInput,
  PendingTranslationJob,
  PendingTranslationJobRepository,
  SchedulePendingTranslationRetryInput,
} from '../src/translation/pending-translation-job.js';
import {
  PendingTranslationWorker,
  type TranslationProcessor,
} from '../src/translation/pending-translation-worker.js';
import { Aes256GcmTransientPayloadCipher } from '../src/translation/transient-payload-cipher.js';
import type { Clock } from '../src/types.js';

const now = new Date('2026-08-19T16:00:00.000Z');
const clock: Clock = { now: () => new Date(now) };
const cipher = new Aes256GcmTransientPayloadCipher(Buffer.alloc(32, 5));

function makeJob(attemptCount = 1): PendingTranslationJob {
  const requestId = '00000000-0000-4000-8000-000000000501';
  return {
    id: '00000000-0000-4000-8000-000000000502',
    requestId,
    requestFingerprint: 'b'.repeat(64),
    state: 'processing',
    encryptedPayload: cipher.encrypt(
      JSON.stringify({ sourceText: 'Szia világ' }),
      requestId,
    ),
    sourceLanguage: null,
    targetLanguage: 'en',
    inputMode: 'text',
    attemptCount,
    lastFailureReason: 'model_unavailable',
    nextAttemptAt: null,
    leaseOwner: 'worker-1',
    leaseExpiresAt: '2026-08-19T16:01:00.000Z',
    createdAt: '2026-08-19T15:00:00.000Z',
    updatedAt: '2026-08-19T16:00:00.000Z',
    expiresAt: '2026-08-20T15:00:00.000Z',
  };
}

class FakeRepository implements PendingTranslationJobRepository {
  claimed: PendingTranslationJob | null = null;
  retryInput: SchedulePendingTranslationRetryInput | null = null;
  readyInput: MarkPendingTranslationReadyInput | null = null;
  expiredJobId: string | null = null;

  createOrGetByRequestId(): Promise<PendingTranslationJob> {
    throw new Error('Not used in this test.');
  }

  findByRequestId(): Promise<PendingTranslationJob | null> {
    throw new Error('Not used in this test.');
  }

  claimNext(): Promise<PendingTranslationJob | null> {
    return Promise.resolve(this.claimed);
  }

  scheduleRetry(
    input: Readonly<SchedulePendingTranslationRetryInput>,
  ): Promise<PendingTranslationJob> {
    this.retryInput = { ...input };
    return Promise.resolve({ ...(this.claimed ?? makeJob()), state: 'pending' });
  }

  markReady(input: Readonly<MarkPendingTranslationReadyInput>): Promise<PendingTranslationJob> {
    this.readyInput = { ...input };
    return Promise.resolve({ ...(this.claimed ?? makeJob()), state: 'ready_for_delivery' });
  }

  expireProcessing(jobId: string): Promise<PendingTranslationJob> {
    this.expiredJobId = jobId;
    return Promise.resolve({
      ...(this.claimed ?? makeJob()),
      state: 'expired',
      encryptedPayload: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  acknowledgeDelivery(): Promise<PendingTranslationJob> {
    throw new Error('Not used in this test.');
  }

  expireDue(): Promise<number> {
    return Promise.resolve(0);
  }

  releaseExpiredLeases(): Promise<number> {
    return Promise.resolve(0);
  }
}

function processorReturning(result: TranslationResult): TranslationProcessor {
  return { process: () => Promise.resolve(result) };
}

const policy = {
  maxAttempts: 3,
  leaseSeconds: 60,
  retryBaseSeconds: 10,
  retryMaximumSeconds: 60,
};

describe('pending translation worker', () => {
  it('returns idle when no job is due', async () => {
    const repository = new FakeRepository();
    const worker = new PendingTranslationWorker(
      repository,
      cipher,
      processorReturning({
        status: 'translation_pending',
        requestId: '00000000-0000-4000-8000-000000000501',
        reason: 'model_unavailable',
        presentation: 'sad',
      }),
      clock,
      policy,
    );

    await expect(worker.runOnce('worker-1')).resolves.toBe('idle');
  });

  it('marks a validated successful result ready for delivery', async () => {
    const repository = new FakeRepository();
    repository.claimed = makeJob();
    const worker = new PendingTranslationWorker(
      repository,
      cipher,
      processorReturning({
        status: 'delivered',
        translatedText: 'Hello world',
        provenance: { modelRole: 'primary', modelId: 'test-model', attemptCount: 1 },
      }),
      clock,
      policy,
    );

    await expect(worker.runOnce('worker-1')).resolves.toBe('ready');
    expect(repository.readyInput?.jobId).toBe(repository.claimed.id);
    const decrypted = cipher.decrypt(
      repository.readyInput?.encryptedPayload ?? '',
      `${repository.claimed.requestId}:delivery`,
    );
    expect(JSON.parse(decrypted)).toMatchObject({
      status: 'delivered',
      translatedText: 'Hello world',
    });
  });

  it('schedules bounded exponential retry for a pending result', async () => {
    const repository = new FakeRepository();
    repository.claimed = makeJob(2);
    const worker = new PendingTranslationWorker(
      repository,
      cipher,
      processorReturning({
        status: 'translation_pending',
        requestId: repository.claimed.requestId,
        reason: 'model_unavailable',
        presentation: 'sad',
      }),
      clock,
      policy,
    );

    await expect(worker.runOnce('worker-1')).resolves.toBe('retry_scheduled');
    expect(repository.retryInput).toMatchObject({
      jobId: repository.claimed.id,
      failureReason: 'model_unavailable',
      nextAttemptAt: '2026-08-19T16:00:20.000Z',
    });
  });

  it('expires processing when the attempt budget is exhausted', async () => {
    const repository = new FakeRepository();
    repository.claimed = makeJob(3);
    const worker = new PendingTranslationWorker(
      repository,
      cipher,
      processorReturning({
        status: 'translation_pending',
        requestId: repository.claimed.requestId,
        reason: 'processing_timeout',
        presentation: 'sad',
      }),
      clock,
      policy,
    );

    await expect(worker.runOnce('worker-1')).resolves.toBe('expired');
    expect(repository.expiredJobId).toBe(repository.claimed.id);
  });
});
