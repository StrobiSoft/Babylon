import { describe, expect, it } from 'vitest';
import { createDefaultLanguageAgent } from '../src/language/default-language-agent.js';
import {
  ModelRegistry,
  type ModelEngine,
  type ModelEngineRequest,
} from '../src/language/model-gateway.js';

const request = {
  requestId: '00000000-0000-4000-8000-000000000111',
  sourceText: 'Hello, how are you?',
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

describe('default language agent integration', () => {
  it('connects the real guards to primary, repair and secondary recovery', async () => {
    const calls: ModelEngineRequest[] = [];
    const engine: ModelEngine = {
      generate: (input) => {
        calls.push({ ...input });
        if (input.modelId === 'secondary:test') {
          return Promise.resolve({ text: 'Szia, hogy vagy?' });
        }
        if (calls.length === 1) {
          return Promise.resolve({ text: 'Hello, how are you?' });
        }
        return Promise.resolve({ text: 'Hello again' });
      },
    };

    const result = await createDefaultLanguageAgent(engine, {
      registry: enabledRegistry(),
      gatewayPolicy: { attemptTimeoutMs: 1_000, operationDeadlineMs: 2_000, maxAttempts: 1 },
    }).process(request);

    expect(result).toEqual({
      status: 'delivered_via_fallback',
      translatedText: 'Szia, hogy vagy?',
      provenance: { modelRole: 'secondary', modelId: 'secondary:test', attemptCount: 1 },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ modelId: 'primary:test', inputText: request.sourceText });
    expect(calls[1]?.systemInstructions).toContain('previous candidate failed');
    expect(calls[1]?.systemInstructions).toContain('Hello, how are you?');
    expect(calls[2]).toMatchObject({ modelId: 'secondary:test', inputText: request.sourceText });
  });

  it('bypasses the model for same-language input through the real classifier', async () => {
    let calls = 0;
    const engine: ModelEngine = {
      generate: () => {
        calls += 1;
        return Promise.resolve({ text: 'unused' });
      },
    };

    const result = await createDefaultLanguageAgent(engine, {
      registry: enabledRegistry(),
    }).process({
      ...request,
      sourceText: 'Szia, hogy vagy?',
      targetLanguage: 'hu',
    });

    expect(result).toEqual({
      status: 'delivered_unchanged',
      deliveredText: 'Szia, hogy vagy?',
      reason: 'same_language',
    });
    expect(calls).toBe(0);
  });
});
