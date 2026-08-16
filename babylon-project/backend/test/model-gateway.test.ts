import { describe, expect, it } from 'vitest';
import type { ModelGenerationRequest } from '../src/language/contracts.js';
import {
  ModelGateway,
  ModelGatewayError,
  ModelRegistry,
  type ModelEngine,
} from '../src/language/model-gateway.js';

const request = {
  requestId: '00000000-0000-4000-8000-000000000001',
  sourceText: 'Good morning!',
  targetLanguage: 'hu',
} as const;

function gateway(engine: ModelEngine, timeoutMs = 100): ModelGateway {
  return new ModelGateway(
    new ModelRegistry([
      { role: 'primary', modelId: 'gpt-oss:20b', enabled: true, engine },
      { role: 'reserve', modelId: 'reserve:test', enabled: false, engine },
    ]),
    timeoutMs,
  );
}

describe('fake-first model gateway', () => {
  it('returns the fake result with exact allowlisted provenance', async () => {
    let received: Readonly<ModelGenerationRequest> | undefined;
    const engine: ModelEngine = {
      generate(input) {
        received = input;
        return Promise.resolve({ text: 'Jó reggelt!' });
      },
    };

    await expect(gateway(engine).generate('primary', request)).resolves.toEqual({
      text: 'Jó reggelt!',
      provenance: { modelRole: 'primary', modelId: 'gpt-oss:20b' },
    });
    expect(received).toEqual(request);
  });

  it('rejects arbitrary roles, client model IDs, and disabled registry entries', async () => {
    const engine: ModelEngine = {
      generate: () => Promise.resolve({ text: 'unused' }),
    };
    const modelGateway = gateway(engine);

    await expect(modelGateway.generate('attacker/model', request)).rejects.toMatchObject({
      code: 'MODEL_ROLE_NOT_ALLOWED',
    });
    await expect(
      modelGateway.generate('primary', { ...request, modelId: 'attacker/model' }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_REQUEST' });
    await expect(modelGateway.generate('reserve', request)).rejects.toMatchObject({
      code: 'MODEL_ROLE_DISABLED',
      modelRole: 'reserve',
      modelId: 'reserve:test',
    });
  });

  it('aborts and normalizes an attempt that exceeds its timeout', async () => {
    let signal: AbortSignal | undefined;
    const engine: ModelEngine = {
      generate(_input, options) {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    };

    await expect(gateway(engine, 5).generate('primary', request)).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
      message: 'The model attempt timed out.',
      modelRole: 'primary',
      modelId: 'gpt-oss:20b',
    });
    expect(signal?.aborted).toBe(true);
  });

  it('normalizes engine failures without exposing or retaining message text', async () => {
    const secretMessage = 'private message that must never enter logs';
    const engine: ModelEngine = {
      generate: () => Promise.reject(new Error(`engine leaked: ${secretMessage}`)),
    };

    let failure: unknown;
    try {
      await gateway(engine).generate('primary', { ...request, sourceText: secretMessage });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelGatewayError);
    expect(failure).toMatchObject({
      code: 'MODEL_ENGINE_FAILURE',
      message: 'The model engine failed.',
      modelRole: 'primary',
      modelId: 'gpt-oss:20b',
    });
    expect(String(failure)).not.toContain(secretMessage);
    expect(failure).not.toHaveProperty('cause');
  });
});
