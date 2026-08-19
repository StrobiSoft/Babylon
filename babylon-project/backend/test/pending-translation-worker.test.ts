import { describe, expect, it } from 'vitest';
import type { TranslationPendingReason } from '../src/language/contracts.js';
import type {
  PendingTranslationJob,
  PendingTranslationPayload,
} from '../src/language/pending-translation-store.js';
import {
  PendingTranslationWorker,
  type PendingTranslationQueue,
} from '../src/language/pending-translation-worker.js';

const payload: PendingTranslationPayload = {
  requestId: '00000000-0000-4000-8000-000000000021',
  sourceText: 'Hello!',
  targetLanguage: 'hu',
  style: 'everyday',
  inputMode: 'text',
};

function job(overrides: Partial<PendingTranslationJob> = {}): PendingTranslationJob {
  return {
    payload,
    reason: 'model_unavailable',
    attemptCount: 1,
    expiresAt: new Date('2026-08-19T20:00:00.000Z'),
    ...overrides,
  };
}

function queue(jobs: PendingTranslationJob[] = [job()]): {
  store: PendingTranslationQueue;
  completed: string[];
  rescheduled: { requestId: string; reason: TranslationPendingReason }[];
  claimLimits: number[];
} {
  const completed: string[] = [];
  const rescheduled: { requestId: string; reason: TranslationPendingReason }[] = [];
  const claimLimits: number[] = [];

  return {
    completed,
    rescheduled,
    claimLimits,
    store: {
      deleteExpired: () => Promise.resolve(2),
      claimDue: (limit = 10) => {
        claimLimits.push(limit);
        return Promise.resolve(jobs);
      },
      complete: (requestId) => {
        completed.push(requestId);
        return Promise.resolve();
      },
      reschedule: (requestId, reason) => {
        rescheduled.push({ requestId, reason });
        return Promise.resolve();
      },
    },
  };
}

describe('pending translation worker', () => {
  it('completes and deletes a job after successful retry processing', async () => {
    const state = queue();
    const worker = new PendingTranslationWorker(state.store, {
      process: () =>
        Promise.resolve({
          status: 'delivered_unchanged',
          deliveredText: 'Szia!',
          reason: 'same_language',
        }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      rescheduled: 0,
      expiredDeleted: 2,
    });
    expect(state.completed).toEqual([payload.requestId]);
    expect(state.rescheduled).toEqual([]);
  });

  it('reschedules a job when translation remains pending', async () => {
    const state = queue();
    const worker = new PendingTranslationWorker(state.store, {
      process: () =>
        Promise.resolve({
          status: 'translation_pending',
          requestId: payload.requestId,
          reason: 'processing_timeout',
          presentation: 'sad',
        }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completed: 0,
      rescheduled: 1,
    });
    expect(state.completed).toEqual([]);
    expect(state.rescheduled).toEqual([
      { requestId: payload.requestId, reason: 'processing_timeout' },
    ]);
  });

  it('converts an unexpected processor failure into a controlled retry', async () => {
    const state = queue();
    const worker = new PendingTranslationWorker(state.store, {
      process: () => Promise.reject(new Error('model connection failed')),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completed: 0,
      rescheduled: 1,
    });
    expect(state.rescheduled).toEqual([
      { requestId: payload.requestId, reason: 'technical_failure' },
    ]);
  });

  it('uses the configured bounded batch size', async () => {
    const state = queue([]);
    const worker = new PendingTranslationWorker(
      state.store,
      {
        process: () => Promise.reject(new Error('unused')),
      },
      { batchSize: 25 },
    );

    await worker.runOnce();
    expect(state.claimLimits).toEqual([25]);
  });

  it('rejects invalid batch sizes instead of allowing an unbounded claim', () => {
    const state = queue([]);
    const processor = { process: () => Promise.reject(new Error('unused')) };

    expect(() => new PendingTranslationWorker(state.store, processor, { batchSize: 0 })).toThrow();
    expect(
      () => new PendingTranslationWorker(state.store, processor, { batchSize: 101 }),
    ).toThrow();
  });
});
