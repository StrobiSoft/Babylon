import { z } from 'zod';

export const translationStatuses = [
  'delivered',
  'delivered_after_repair',
  'delivered_via_fallback',
  'delivered_unchanged',
  'translation_pending',
  'invalid_input',
] as const;

export const translationStatusSchema = z.enum(translationStatuses);
export type TranslationStatus = z.infer<typeof translationStatusSchema>;

export const modelRoles = ['primary', 'secondary', 'reserve'] as const;
export const modelRoleSchema = z.enum(modelRoles);
export type ModelRole = z.infer<typeof modelRoleSchema>;

export const supportedLanguages = ['en', 'hu', 'be'] as const;
export const supportedLanguageSchema = z.enum(supportedLanguages);
export type SupportedLanguage = z.infer<typeof supportedLanguageSchema>;

export const translationStyles = ['formal', 'everyday', 'casual'] as const;
export const translationStyleSchema = z.enum(translationStyles);
export type TranslationStyle = z.infer<typeof translationStyleSchema>;

export const unchangedDeliveryReasons = ['same_language', 'language_neutral'] as const;
export const unchangedDeliveryReasonSchema = z.enum(unchangedDeliveryReasons);
export type UnchangedDeliveryReason = z.infer<typeof unchangedDeliveryReasonSchema>;

export const translationPendingReasons = [
  'poor_network_coverage',
  'model_unavailable',
  'processing_timeout',
  'technical_failure',
  'other',
] as const;
export const translationPendingReasonSchema = z.enum(translationPendingReasons);
export type TranslationPendingReason = z.infer<typeof translationPendingReasonSchema>;

export const invalidInputReasons = ['unintelligible_text', 'unintelligible_voice_input'] as const;
export const invalidInputReasonSchema = z.enum(invalidInputReasons);
export type InvalidInputReason = z.infer<typeof invalidInputReasonSchema>;

export const messageTextSchema = z.string().min(1).max(65_536);

export const modelGenerationRequestSchema = z
  .object({
    requestId: z.uuid(),
    sourceText: messageTextSchema,
    targetLanguage: supportedLanguageSchema,
    style: translationStyleSchema.optional(),
  })
  .strict();
export type ModelGenerationRequest = z.infer<typeof modelGenerationRequestSchema>;

export const translationProvenanceSchema = z
  .object({
    modelRole: modelRoleSchema,
    modelId: z.string().trim().min(1).max(160),
  })
  .strict();
export type TranslationProvenance = z.infer<typeof translationProvenanceSchema>;

export const modelCandidateSchema = z
  .object({
    text: messageTextSchema,
    provenance: translationProvenanceSchema,
  })
  .strict();
export type ModelCandidate = z.infer<typeof modelCandidateSchema>;

const deliveredTranslationSchema = z
  .object({
    status: z.enum(['delivered', 'delivered_after_repair', 'delivered_via_fallback']),
    translatedText: messageTextSchema,
    provenance: translationProvenanceSchema,
  })
  .strict();

const deliveredUnchangedSchema = z
  .object({
    status: z.literal('delivered_unchanged'),
    deliveredText: messageTextSchema,
    reason: unchangedDeliveryReasonSchema,
  })
  .strict();

const pendingTranslationSchema = z
  .object({
    status: z.literal('translation_pending'),
    requestId: z.uuid(),
    reason: translationPendingReasonSchema,
    presentation: z.literal('sad'),
  })
  .strict();

const invalidInputTranslationSchema = z
  .object({
    status: z.literal('invalid_input'),
    reason: invalidInputReasonSchema,
    requiredAction: z.literal('correct_and_retry'),
  })
  .strict();

export const translationResultSchema = z.union([
  deliveredTranslationSchema,
  deliveredUnchangedSchema,
  pendingTranslationSchema,
  invalidInputTranslationSchema,
]);
export type TranslationResult = z.infer<typeof translationResultSchema>;
