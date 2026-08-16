import { z } from 'zod';

export const translationStatuses = [
  'delivered',
  'delivered_after_repair',
  'delivered_via_fallback',
  'translation_pending',
  'invalid_input',
] as const;

export const translationStatusSchema = z.enum(translationStatuses);
export type TranslationStatus = z.infer<typeof translationStatusSchema>;

export const modelRoles = ['primary', 'secondary', 'reserve'] as const;
export const modelRoleSchema = z.enum(modelRoles);
export type ModelRole = z.infer<typeof modelRoleSchema>;

const languageIdentifierSchema = z.string().trim().min(2).max(35);
const messageTextSchema = z.string().min(1).max(65_536);

export const modelGenerationRequestSchema = z
  .object({
    requestId: z.uuid(),
    sourceText: messageTextSchema,
    targetLanguage: languageIdentifierSchema,
    style: z.string().trim().min(1).max(64).optional(),
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

const pendingTranslationSchema = z
  .object({
    status: z.literal('translation_pending'),
    requestId: z.uuid(),
  })
  .strict();

const invalidInputTranslationSchema = z
  .object({
    status: z.literal('invalid_input'),
  })
  .strict();

export const translationResultSchema = z.union([
  deliveredTranslationSchema,
  pendingTranslationSchema,
  invalidInputTranslationSchema,
]);
export type TranslationResult = z.infer<typeof translationResultSchema>;
