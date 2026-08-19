import { z } from 'zod';
import {
  invalidInputReasonSchema,
  messageTextSchema,
  modelCandidateSchema,
  modelRoleSchema,
  supportedLanguageSchema,
  translationPendingReasonSchema,
  translationStyleSchema,
  type InvalidInputReason,
  type ModelCandidate,
  type ModelRole,
  type SupportedLanguage,
  type TranslationPendingReason,
  type TranslationResult,
  type TranslationStyle,
} from './contracts.js';

export const inputModes = ['text', 'voice_transcript'] as const;
export const inputModeSchema = z.enum(inputModes);
export type InputMode = z.infer<typeof inputModeSchema>;

export const languageAgentRequestSchema = z
  .object({
    requestId: z.uuid(),
    sourceText: messageTextSchema,
    targetLanguage: supportedLanguageSchema,
    style: translationStyleSchema.optional(),
    inputMode: inputModeSchema,
  })
  .strict();
export type LanguageAgentRequest = z.infer<typeof languageAgentRequestSchema>;

const inputClassificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('language'), sourceLanguage: supportedLanguageSchema }).strict(),
  z.object({ kind: z.literal('neutral') }).strict(),
  z.object({ kind: z.literal('invalid'), reason: invalidInputReasonSchema }).strict(),
]);
export type InputClassification = z.infer<typeof inputClassificationSchema>;

export interface InputClassifier {
  classify(input: Readonly<{ text: string; inputMode: InputMode }>): Promise<unknown>;
}

export interface OutputLanguageValidator {
  matchesTargetLanguage(
    input: Readonly<{ text: string; targetLanguage: SupportedLanguage }>,
  ): Promise<boolean>;
}

export const generationPhases = ['translate', 'repair'] as const;
export const generationPhaseSchema = z.enum(generationPhases);
export type GenerationPhase = z.infer<typeof generationPhaseSchema>;

export interface LanguageAgentAttempt {
  phase: GenerationPhase;
  modelRole: ModelRole;
}

export interface CandidateGenerationRequest {
  requestId: string;
  phase: GenerationPhase;
  modelRole: ModelRole;
  sourceText: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  style?: TranslationStyle;
  rejectedCandidateText?: string;
}

export interface TranslationCandidateGenerator {
  generate(request: Readonly<CandidateGenerationRequest>): Promise<unknown>;
}

export interface PendingTranslationJobSink {
  enqueue(payload: LanguageAgentRequest, reason: TranslationPendingReason): Promise<void>;
}

const languageAgentPolicySchema = z
  .object({
    attempts: z
      .array(
        z
          .object({
            phase: generationPhaseSchema,
            modelRole: modelRoleSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

export interface LanguageAgentPolicy {
  attempts: readonly LanguageAgentAttempt[];
}

export class CandidateGenerationError extends Error {
  constructor(readonly reason: TranslationPendingReason) {
    super('The translation candidate could not be generated.');
    this.name = 'CandidateGenerationError';
  }
}

export class LanguageAgent {
  readonly #classifier: InputClassifier;
  readonly #generator: TranslationCandidateGenerator;
  readonly #validator: OutputLanguageValidator;
  readonly #policy: LanguageAgentPolicy;
  readonly #pendingSink: PendingTranslationJobSink | undefined;

  constructor(
    classifier: InputClassifier,
    generator: TranslationCandidateGenerator,
    validator: OutputLanguageValidator,
    policy: LanguageAgentPolicy,
    pendingSink?: PendingTranslationJobSink,
  ) {
    const parsedPolicy = languageAgentPolicySchema.safeParse(policy);
    if (!parsedPolicy.success) throw new Error('Invalid language agent policy.');
    this.#classifier = classifier;
    this.#generator = generator;
    this.#validator = validator;
    this.#policy = { attempts: Object.freeze([...parsedPolicy.data.attempts]) };
    this.#pendingSink = pendingSink;
  }

  async process(request: unknown): Promise<TranslationResult> {
    const parsedRequest = languageAgentRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new Error('Invalid language agent request.');
    const input = parsedRequest.data;

    let classification: InputClassification;
    try {
      classification = inputClassificationSchema.parse(
        await this.#classifier.classify({ text: input.sourceText, inputMode: input.inputMode }),
      );
    } catch {
      return this.#pending(input, 'technical_failure');
    }

    if (classification.kind === 'neutral') {
      return {
        status: 'delivered_unchanged',
        deliveredText: input.sourceText,
        reason: 'language_neutral',
      };
    }
    if (classification.kind === 'invalid') {
      return this.#invalid(classification.reason);
    }
    if (classification.sourceLanguage === input.targetLanguage) {
      return {
        status: 'delivered_unchanged',
        deliveredText: input.sourceText,
        reason: 'same_language',
      };
    }

    const failureReasons: TranslationPendingReason[] = [];
    let rejectedCandidateText: string | undefined;

    for (const [index, attempt] of this.#policy.attempts.entries()) {
      let candidate: ModelCandidate;
      try {
        const generationRequest: CandidateGenerationRequest = {
          requestId: input.requestId,
          phase: attempt.phase,
          modelRole: attempt.modelRole,
          sourceText: input.sourceText,
          sourceLanguage: classification.sourceLanguage,
          targetLanguage: input.targetLanguage,
          ...(input.style === undefined ? {} : { style: input.style }),
          ...(attempt.phase !== 'repair' || rejectedCandidateText === undefined
            ? {}
            : { rejectedCandidateText }),
        };
        candidate = modelCandidateSchema.parse(await this.#generator.generate(generationRequest));
        if (candidate.provenance.modelRole !== attempt.modelRole) {
          failureReasons.push('technical_failure');
          continue;
        }
      } catch (error) {
        failureReasons.push(
          error instanceof CandidateGenerationError ? error.reason : 'technical_failure',
        );
        continue;
      }

      let valid = false;
      try {
        valid = await this.#validator.matchesTargetLanguage({
          text: candidate.text,
          targetLanguage: input.targetLanguage,
        });
      } catch {
        failureReasons.push('technical_failure');
        continue;
      }
      if (!valid) {
        rejectedCandidateText = candidate.text;
        failureReasons.push('technical_failure');
        continue;
      }

      return {
        status:
          index === 0
            ? 'delivered'
            : attempt.phase === 'repair'
              ? 'delivered_after_repair'
              : 'delivered_via_fallback',
        translatedText: candidate.text,
        provenance: candidate.provenance,
      };
    }

    return this.#pending(input, this.#summarizeFailures(failureReasons));
  }

  #invalid(reason: InvalidInputReason): TranslationResult {
    return { status: 'invalid_input', reason, requiredAction: 'correct_and_retry' };
  }

  async #pending(
    input: LanguageAgentRequest,
    reason: TranslationPendingReason,
  ): Promise<TranslationResult> {
    if (this.#pendingSink !== undefined) {
      try {
        await this.#pendingSink.enqueue(input, reason);
      } catch {
        reason = 'technical_failure';
      }
    }
    return {
      status: 'translation_pending',
      requestId: input.requestId,
      reason,
      presentation: 'sad',
    };
  }

  #summarizeFailures(reasons: readonly TranslationPendingReason[]): TranslationPendingReason {
    if (reasons.length === 0) return 'technical_failure';
    const uniqueReasons = new Set(
      reasons.map((reason) => translationPendingReasonSchema.parse(reason)),
    );
    if (uniqueReasons.size !== 1) return 'technical_failure';
    for (const reason of uniqueReasons) return reason;
    return 'technical_failure';
  }
}
