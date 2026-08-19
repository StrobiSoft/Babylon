import { describe, expect, it } from 'vitest';
import {
  pendingTranslationJobSchema,
  pendingTranslationJobStateSchema,
  pendingTranslationJobStates,
} from '../src/translation/pending-translation-job.js';

const baseJob = {
  id: '00000000-0000-4000-8000-000000000201',
  requestId: '00000000-0000-4000-8000-000000000202',
  state: 'pending',
  encryptedPayload: 'ciphertext',
  sourceLanguage: null,
  targetLanguage: 'hu',
  inputMode: 'text',
  attemptCount: 0,
  lastFailureReason: null,
  nextAttemptAt: '2026-08-19T10:00:00.000Z',
  leaseOwner: null,
  leaseExpiresAt: null,
  createdAt: '2026-08-19T09:00:00.000Z',
  updatedAt: '2026-08-19T09:00:00.000Z',
  expiresAt: '2026-08-20T09:00:00.000Z',
} as const;

describe('pending translation job contract', () => {
  it('exposes only the planned lifecycle states', () => {
    expect(pendingTranslationJobStates).toEqual([
      'pending',
      'processing',
      'ready_for_delivery',
      'delivered_acknowledged',
      'expired',
    ]);

    for (const state of pendingTranslationJobStates) {
      expect(pendingTranslationJobStateSchema.parse(state)).toBe(state);
    }
    expect(pendingTranslationJobStateSchema.safeParse('delivered').success).toBe(false);
  });

  it('accepts a valid pending job record', () => {
    expect(pendingTranslationJobSchema.parse(baseJob)).toEqual(baseJob);
  });

  it('accepts a processing lease and retry metadata', () => {
    const job = {
      ...baseJob,
      state: 'processing',
      attemptCount: 2,
      lastFailureReason: 'model_unavailable',
      leaseOwner: 'worker-01',
      leaseExpiresAt: '2026-08-19T10:01:00.000Z',
    } as const;

    expect(pendingTranslationJobSchema.parse(job)).toEqual(job);
  });

  it('accepts terminal records with transient payload already removed', () => {
    for (const state of ['delivered_acknowledged', 'expired'] as const) {
      const job = {
        ...baseJob,
        state,
        encryptedPayload: null,
        nextAttemptAt: null,
      };
      expect(pendingTranslationJobSchema.parse(job)).toEqual(job);
    }
  });

  it('rejects invalid identifiers, timestamps and counters', () => {
    expect(
      pendingTranslationJobSchema.safeParse({
        ...baseJob,
        requestId: 'not-a-uuid',
      }).success,
    ).toBe(false);

    expect(
      pendingTranslationJobSchema.safeParse({
        ...baseJob,
        createdAt: 'yesterday',
      }).success,
    ).toBe(false);

    expect(
      pendingTranslationJobSchema.safeParse({
        ...baseJob,
        attemptCount: -1,
      }).success,
    ).toBe(false);
  });
});
