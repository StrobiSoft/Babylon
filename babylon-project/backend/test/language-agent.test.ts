import { describe, expect, it } from 'vitest';
import type { ModelCandidate } from '../src/language/contracts.js';
import {
  CandidateGenerationError,
  LanguageAgent,
  languageAgentRequestSchema,
  type CandidateGenerationRequest,
  type InputClassification,
  type LanguageAgentPolicy,
} from '../src/language/language-agent.js';

const request = {
  requestId: '00000000-0000-4000-8000-000000000001',
  sourceText: 'Hello!',
  targetLanguage: 'hu',
  style: 'everyday',
  inputMode: 'text',
} as const;

const policy: LanguageAgentPolicy = {
  attempts: [
    { phase: 'translate', modelRole: 'primary' },
    { phase: 'repair', modelRole: 'primary' },
    { phase: 'translate', modelRole: 'secondary' },
    { phase: 'translate', modelRole: 'reserve' },
  ],
};

function candidate(text: string, modelRole: 'primary' | 'secondary' | 'reserve'): ModelCandidate {
  return { text, provenance: { modelRole, modelId: `${modelRole}:test` } };
}

function agent(options: {
  classification?: InputClassification;
  generate?: (input: Readonly<CandidateGenerationRequest>) => Promise<unknown>;
  validate?: (text: string) => Promise<boolean>;
}): LanguageAgent {
  return new LanguageAgent(
    {
      classify: () =>
        Promise.resolve(options.classification ?? { kind: 'language', sourceLanguage: 'en' }),
    },
    {
      generate: options.generate ?? (() => Promise.resolve(candidate('Szia!', 'primary'))),
    },
    {
      matchesTargetLanguage: ({ text }) => options.validate?.(text) ?? Promise.resolve(true),
    },
    policy,
  );
}

describe('language agent', () => {
  it('rejects a sender-selected source language and unsupported target language', () => {
    expect(languageAgentRequestSchema.safeParse({ ...request, sourceLanguage: 'en' }).success).toBe(
      false,
    );
    expect(languageAgentRequestSchema.safeParse({ ...request, targetLanguage: 'de' }).success).toBe(
      false,
    );
  });

  it('delivers language-neutral content unchanged without invoking a model', async () => {
    let modelCalls = 0;
    const result = await agent({
      classification: { kind: 'neutral' },
      generate: () => {
        modelCalls += 1;
        return Promise.resolve(candidate('unused', 'primary'));
      },
    }).process({ ...request, sourceText: 'https://example.com' });

    expect(result).toEqual({
      status: 'delivered_unchanged',
      deliveredText: 'https://example.com',
      reason: 'language_neutral',
    });
    expect(modelCalls).toBe(0);
  });

  it('delivers same-language text unchanged without invoking a model', async () => {
    let modelCalls = 0;
    const result = await agent({
      classification: { kind: 'language', sourceLanguage: 'hu' },
      generate: () => {
        modelCalls += 1;
        return Promise.resolve(candidate('unused', 'primary'));
      },
    }).process(request);

    expect(result).toEqual({
      status: 'delivered_unchanged',
      deliveredText: 'Hello!',
      reason: 'same_language',
    });
    expect(modelCalls).toBe(0);
  });

  it('requires correction and retry for unintelligible input', async () => {
    await expect(
      agent({
        classification: { kind: 'invalid', reason: 'unintelligible_text' },
      }).process(request),
    ).resolves.toEqual({
      status: 'invalid_input',
      reason: 'unintelligible_text',
      requiredAction: 'correct_and_retry',
    });
  });

  it('delivers only a candidate that independently matches the target language', async () => {
    const generated: CandidateGenerationRequest[] = [];
    const result = await agent({
      generate: (input) => {
        generated.push({ ...input });
        return Promise.resolve(
          generated.length === 1
            ? candidate('Wrong language', 'primary')
            : candidate('Javított fordítás', 'primary'),
        );
      },
      validate: (text) => Promise.resolve(text === 'Javított fordítás'),
    }).process(request);

    expect(result).toEqual({
      status: 'delivered_after_repair',
      translatedText: 'Javított fordítás',
      provenance: { modelRole: 'primary', modelId: 'primary:test' },
    });
    expect(generated[1]).toMatchObject({
      phase: 'repair',
      sourceText: 'Hello!',
      rejectedCandidateText: 'Wrong language',
    });
  });

  it('regenerates fallback from the original source and records its provenance', async () => {
    const generated: CandidateGenerationRequest[] = [];
    const result = await agent({
      generate: (input) => {
        generated.push({ ...input });
        if (input.modelRole === 'secondary') {
          return Promise.resolve(candidate('Másodlagos fordítás', 'secondary'));
        }
        return Promise.reject(new CandidateGenerationError('model_unavailable'));
      },
    }).process(request);

    expect(result).toMatchObject({
      status: 'delivered_via_fallback',
      provenance: { modelRole: 'secondary', modelId: 'secondary:test' },
    });
    expect(generated[2]).toMatchObject({
      phase: 'translate',
      sourceText: 'Hello!',
      modelRole: 'secondary',
    });
    expect(generated[2]).not.toHaveProperty('rejectedCandidateText');
  });

  it('reports a truthful network reason with a sad presentation hint', async () => {
    const result = await agent({
      generate: () => Promise.reject(new CandidateGenerationError('poor_network_coverage')),
    }).process(request);

    expect(result).toEqual({
      status: 'translation_pending',
      requestId: request.requestId,
      reason: 'poor_network_coverage',
      presentation: 'sad',
    });
  });

  it('generalizes mixed failures without exposing internal details', async () => {
    let call = 0;
    const result = await agent({
      generate: () => {
        call += 1;
        return Promise.reject(
          new CandidateGenerationError(call === 1 ? 'model_unavailable' : 'processing_timeout'),
        );
      },
    }).process(request);

    expect(result).toEqual({
      status: 'translation_pending',
      requestId: request.requestId,
      reason: 'technical_failure',
      presentation: 'sad',
    });
  });

  it('rejects a candidate whose provenance does not match the requested role', async () => {
    const result = await agent({
      generate: (input) =>
        Promise.resolve(
          candidate('hamis eredet', input.modelRole === 'primary' ? 'secondary' : 'primary'),
        ),
    }).process(request);

    expect(result).toMatchObject({
      status: 'translation_pending',
      reason: 'technical_failure',
    });
  });
});
