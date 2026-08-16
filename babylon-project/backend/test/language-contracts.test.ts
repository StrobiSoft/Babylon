import { describe, expect, it } from 'vitest';
import {
  modelGenerationRequestSchema,
  modelRoleSchema,
  translationResultSchema,
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
        provenance: { modelRole: 'secondary', modelId: 'qwen3:8b' },
      }),
    ).toEqual({
      status: 'delivered_via_fallback',
      translatedText: 'Jó reggelt!',
      provenance: { modelRole: 'secondary', modelId: 'qwen3:8b' },
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
      requestId: '00000000-0000-4000-8000-000000000001',
      sourceText: 'Good morning!',
      targetLanguage: 'hu',
    };
    expect(modelGenerationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      modelGenerationRequestSchema.safeParse({ ...request, modelId: 'arbitrary/client-model' })
        .success,
    ).toBe(false);
  });

  it('records the approved configurable candidate ordering without enabling reserve', () => {
    expect(plannedLocalModels).toEqual({
      primary: { modelId: 'gpt-oss:20b', enabled: true },
      secondary: { modelId: 'qwen3:8b', enabled: true },
      reserve: { modelId: 'ministral-3:8b-instruct-2512-q4_K_M', enabled: false },
    });
  });
});
