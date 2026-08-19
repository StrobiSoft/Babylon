import { z } from 'zod';
import {
  supportedLanguageSchema,
  translationPendingReasonSchema,
  translationStyleSchema,
} from '../language/contracts.js';
import { inputModeSchema } from '../language/language-agent.js';

export const pendingTranslationJobStates = [
  'pending',
  'processing',
  'ready_for_delivery',
  'delivered_acknowledged',
  'expired',
] as const;

export const pendingTranslationJobStateSchema = z.enum(pendingTranslationJobStates);
export type PendingTranslationJobState = z.infer<typeof pendingTranslationJobStateSchema>;

const isoTimestampSchema = z.iso.datetime({ offset: true });
const requestFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const pendingTranslationJobSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  requestFingerprint: requestFingerprintSchema,
  state: pendingTranslationJobStateSchema,
  encryptedPayload: z.string().trim().min(1).max(262_144).nullable(),
  sourceLanguage: supportedLanguageSchema.nullable(),
  targetLanguage: supportedLanguageSchema,
  style: translationStyleSchema.optional(),
  inputMode: inputModeSchema,
  attemptCount: z.number().int().nonnegative().max(100),
  lastFailureReason: translationPendingReasonSchema.nullable(),
  nextAttemptAt: isoTimestampSchema.nullable(),
  leaseOwner: z.string().trim().min(1).max(128).nullable(),
  leaseExpiresAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});

export type PendingTranslationJob = z.infer<typeof pendingTranslationJobSchema>;

export interface CreatePendingTranslationJobInput {
  id: string;
  requestId: string;
  requestFingerprint: string;
  encryptedPayload: string;
  targetLanguage: z.infer<typeof supportedLanguageSchema>;
  style?: z.infer<typeof translationStyleSchema>;
  inputMode: z.infer<typeof inputModeSchema>;
  createdAt: string;
  expiresAt: string;
}

export interface ClaimPendingTranslationJobInput {
  workerId: string;
  now: string;
  leaseExpiresAt: string;
}

export interface SchedulePendingTranslationRetryInput {
  jobId: string;
  failureReason: z.infer<typeof translationPendingReasonSchema>;
  nextAttemptAt: string;
  updatedAt: string;
}

export interface MarkPendingTranslationReadyInput {
  jobId: string;
  encryptedPayload: string;
  sourceLanguage: z.infer<typeof supportedLanguageSchema>;
  updatedAt: string;
}

export interface PendingTranslationJobRepository {
  createOrGetByRequestId(
    input: Readonly<CreatePendingTranslationJobInput>,
  ): Promise<PendingTranslationJob>;
  findByRequestId(requestId: string): Promise<PendingTranslationJob | null>;
  claimNext(
    input: Readonly<ClaimPendingTranslationJobInput>,
  ): Promise<PendingTranslationJob | null>;
  scheduleRetry(
    input: Readonly<SchedulePendingTranslationRetryInput>,
  ): Promise<PendingTranslationJob>;
  markReady(input: Readonly<MarkPendingTranslationReadyInput>): Promise<PendingTranslationJob>;
  acknowledgeDelivery(jobId: string, acknowledgedAt: string): Promise<PendingTranslationJob>;
  expireDue(now: string, limit: number): Promise<number>;
  releaseExpiredLeases(now: string, limit: number): Promise<number>;
}
