import { describe, expect, it } from 'vitest';
import { createDefaultLanguageAgent } from '../src/language/default-language-agent.js';
import {
  ModelEngineError,
  ModelRegistry,
  type ModelEngine,
  type ModelEngineRequest,
} from '../src/language/model-gateway.js';

const request = {
  requestId: '00000000-0000-4000-8000-000000000111',
  sourceText: 'Hello, please tell me when this will be ready.',
  targetLanguage: 'hu',
  style: 'everyday',
  inputMode: 'text',
} as const;

function enabledRegistry(): ModelRegistry {
  return new ModelRegistry([
    { role: 'primary', modelId: 'primary:test', enabled: true },
    { role: 'secondary', modelId: 'secondary:test', enabled: true },
    { role: 'reserve', modelId: 'reserve:test', enabled: true },
  ]);
}

function agent(engine: ModelEngine) {
  return createDefaultLanguageAgent(engine, {
    registry: enabledRegistry(),
    gatewayPolicy: { attemptTimeoutMs: 1_000, operationDeadlineMs: 2_000, maxAttempts: 1 },
  });
}

describe('default language agent integration', () => {
  it('passes language-neutral content unchanged without invoking a model', async () => {
    let calls = 0;
    const engine: ModelEngine = {
      generate: () => {
        calls += 1;
        return Promise.resolve({ text: 'unused' });
      },
    };

    await expect(
      agent(engine).process({ ...request, sourceText: 'https://example.com/a?b=1' }),
    ).resolves.toEqual({
      status: 'delivered_unchanged',
      deliveredText: 'https://example.com/a?b=1',
      reason: 'language_neutral',
    });
    expect(calls).toBe(0);
  });

  it('rejects unintelligible input before model execution', async () => {
    let calls = 0;
    const engine: ModelEngine = {
      generate: () => {
        calls += 1;
        return Promise.resolve({ text: 'unused' });
      },
    };

    await expect(agent(engine).process({ ...request, sourceText: 'blorx zzqv nmp' })).resolves.toEqual({
      status: 'invalid_input',
      reason: 'unintelligible_text',
      requiredAction: 'correct_and_retry',
    });
    expect(calls).toBe(0);
  });

  it('bypasses the model for same-language input through the real classifier', async () => {
    let calls = 0;
    const engine: ModelEngine = {
      generate: () => {
        calls += 1;
        return Promise.resolve({ text: 'unused' });
      },
    };

    await expect(
      agent(engine).process({
        ...request,
        sourceText: 'Szia, kérlek mondd meg, hogy mikor lesz kész.',
        targetLanguage: 'hu',
      }),
    ).resolves.toEqual({
      status: 'delivered_unchanged',
      deliveredText: 'Szia, kérlek mondd meg, hogy mikor lesz kész.',
      reason: 'same_language',
    });
    expect(calls).toBe(0);
  });

  it('delivers a valid primary translation after independent language validation', async () => {
    const calls: ModelEngineRequest[] = [];
    const engine: ModelEngine = {
      generate: (input) => {
        calls.push({ ...input });
        return Promise.resolve({ text: 'Szia, kérlek mondd meg, hogy mikor lesz kész.' });
      },
    };

    await expect(agent(engine).process(request)).resolves.toEqual({
      status: 'delivered',
      translatedText: 'Szia, kérlek mondd meg, hogy mikor lesz kész.',
      provenance: { modelRole: 'primary', modelId: 'primary:test', attemptCount: 1 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ modelId: 'primary:test', inputText: request.sourceText });
  });

  it('repairs a wrong-language primary candidate and validates the repaired result', async () => {
    const calls: ModelEngineRequest[] = [];
    const engine: ModelEngine = {
      generate: (input) => {
        calls.push({ ...input });
        return Promise.resolve({
          text:
            calls.length === 1
              ? 'Hello, this is still in English.'
              : 'Szia, ez már magyarul van.',
        });
      },
    };

    await expect(agent(engine).process(request)).resolves.toEqual({
      status: 'delivered_after_repair',
      translatedText: 'Szia, ez már magyarul van.',
      provenance: { modelRole: 'primary', modelId: 'primary:test', attemptCount: 1 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.systemInstructions).toContain('previous candidate failed');
    expect(calls[1]?.systemInstructions).toContain('Hello, this is still in English.');
  });

  it('falls back to secondary from the original source after primary and repair rejection', async () => {
    const calls: ModelEngineRequest[] = [];
    const engine: ModelEngine = {
      generate: (input) => {
        calls.push({ ...input });
        if (input.modelId === 'secondary:test') {
          return Promise.resolve({ text: 'Szia, ez a másodlagos fordítás.' });
        }
        return Promise.resolve({ text: 'Hello, still wrong.' });
      },
    };

    await expect(agent(engine).process(request)).resolves.toEqual({
      status: 'delivered_via_fallback',
      translatedText: 'Szia, ez a másodlagos fordítás.',
      provenance: { modelRole: 'secondary', modelId: 'secondary:test', attemptCount: 1 },
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ modelId: 'secondary:test', inputText: request.sourceText });
  });

  it('uses the reserve model only after primary, repair and secondary all fail validation', async () => {
    const calls: ModelEngineRequest[] = [];
    const engine: ModelEngine = {
      generate: (input) => {
        calls.push({ ...input });
        if (input.modelId === 'reserve:test') {
          return Promise.resolve({ text: 'Szia, ez a tartalék fordítás.' });
        }
        return Promise.resolve({ text: 'Hello, still wrong.' });
      },
    };

    await expect(agent(engine).process(request)).resolves.toEqual({
      status: 'delivered_via_fallback',
      translatedText: 'Szia, ez a tartalék fordítás.',
      provenance: { modelRole: 'reserve', modelId: 'reserve:test', attemptCount: 1 },
    });
    expect(calls.map((call) => call.modelId)).toEqual([
      'primary:test',
      'primary:test',
      'secondary:test',
      'reserve:test',
    ]);
  });

  it('returns a safe pending state when every candidate fails independent validation', async () => {
    const engine: ModelEngine = {
      generate: () => Promise.resolve({ text: 'Hello, still wrong.' }),
    };

    await expect(agent(engine).process(request)).resolves.toEqual({
      status: 'translation_pending',
      requestId: request.requestId,
      reason: 'technical_failure',
      presentation: 'sad',
    });
  });

  it('maps a complete model-engine outage to the public model-unavailable pending reason', async () => {
    const engine: ModelEngine = {
      generate: () => Promise.reject(new ModelEngineError('unavailable', true)),
    };

    await expect(agent(engine).process(request)).resolves.toEqual({
      status: 'translation_pending',
      requestId: request.requestId,
      reason: 'model_unavailable',
      presentation: 'sad',
    });
  });
});
