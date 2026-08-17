import { describe, expect, it } from 'vitest';
import {
  modelGenerationRequestSchema,
  modelRoleSchema,
  supportedLanguages,
  translationPendingReasons,
  translationResultSchema,
  translationStyles,
  translationStatusSchema,
  translationStatuses,
} from '../src/language/contracts.js';
import { plannedLocalModels } from '../src/language/model-gateway.js';

describe('language system contracts', () => {
  it('accepts only the documented delivery statuses and model roles', () => {
    for (const status of translationStatuses) {
      expect(translationStatusSchema.parse(status)).toBe(status);
    }
    expect(translationStatusSchema.safeParse('silently_dropped').success).toBe(false);
    expect(modelRoleSchema.safeParse('primary').success).toBe(true);
    expect(modelRoleSchema.safeParse('client-selected-model').success).toBe(false);
  });

  it('requires exact role and model identifier provenance for delivered translations', () => {
    expect(
      translationResultSchema.parse({
        status: 'delivered_via_fallback',
        translatedText: 'Jó reggelt!',
        provenance: { modelRole: 'secondary', modelId: 'qwen3:8b', attemptCount: 1 },
      }),
    ).toEqual({
      status: 'delivered_via_fallback',
      translatedText: 'Jó reggelt!',
      provenance: { modelRole: 'secondary', modelId: 'qwen3:8b', attemptCount: 1 },
    });
    expect(
      translationResultSchema.safeParse({
        status: 'delivered',
        translatedText: 'Jó reggelt!',
        provenance: { modelRole: 'primary' },
      }).success,
    ).toBe(false);
  });

  it('keeps model identifiers out of generation requests', () => {
    const request = {
      requestId: 'request-1',
      modelRole: 'primary',
      systemInstructions: 'Translate into Hungarian.',
      inputText: 'Good morning!',
    };
    expect(modelGenerationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      modelGenerationRequestSchema.safeParse({ ...request, modelId: 'arbitrary/client-model' })
        .success,
    ).toBe(false);
  });

  it('fixes the initial languages and active wording styles', () => {
    expect(supportedLanguages).toEqual(['en', 'hu', 'be']);
    expect(translationStyles).toEqual(['formal', 'everyday', 'casual']);
  });

  it('keeps truthful non-translation and pending reasons machine-readable', () => {
    expect(translationPendingReasons).toEqual([
      'poor_network_coverage',
      'model_unavailable',
      'processing_timeout',
      'technical_failure',
      'other',
    ]);
    expect(
      translationResultSchema.parse({
        status: 'delivered_unchanged',
        deliveredText: 'https://example.com',
        reason: 'language_neutral',
      }),
    ).toMatchObject({ reason: 'language_neutral' });
    expect(
      translationResultSchema.parse({
        status: 'translation_pending',
        requestId: '00000000-0000-4000-8000-000000000001',
        reason: 'poor_network_coverage',
        presentation: 'sad',
      }),
    ).toMatchObject({ reason: 'poor_network_coverage', presentation: 'sad' });
  });

  it('records the approved configurable candidate ordering without enabling reserve', () => {
    expect(plannedLocalModels).toEqual({
      primary: { modelId: 'gpt-oss:20b', enabled: true },
      secondary: { modelId: 'qwen3:8b', enabled: true },
      reserve: { modelId: 'ministral-3:8b-instruct-2512-q4_K_M', enabled: false },
    });
  });
});
