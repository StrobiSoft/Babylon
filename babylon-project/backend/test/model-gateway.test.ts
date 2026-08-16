import { describe, expect, it } from 'vitest';
import type { ModelGenerationRequest } from '../src/language/contracts.js';
import {
  ModelGateway,
  ModelGatewayError,
  ModelOperationError,
  ModelRegistry,
  type ModelEngine,
  type ModelGatewayPolicy,
} from '../src/language/model-gateway.js';

const request = {
  requestId: '00000000-0000-4000-8000-000000000001',
  sourceText: 'Good morning!',
  targetLanguage: 'hu',
} as const;

function policy(overrides: Partial<ModelGatewayPolicy> = {}): ModelGatewayPolicy {
  return {
    attemptTimeoutMs: 100,
    operationDeadlineMs: 1_000,
    attemptRoles: ['primary'],
    ...overrides,
  };
}

function gateway(engine: ModelEngine, overrides: Partial<ModelGatewayPolicy> = {}): ModelGateway {
  return new ModelGateway(
    new ModelRegistry([
      { role: 'primary', modelId: 'gpt-oss:20b', enabled: true, engine },
      { role: 'reserve', modelId: 'reserve:test', enabled: false, engine },
    ]),
    policy(overrides),
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

    await expect(
      gateway(engine, { attemptTimeoutMs: 5 }).generate('primary', request),
    ).rejects.toMatchObject({
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

  it('uses the explicit finite role sequence and stops on the first success', async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const primary: ModelEngine = {
      generate() {
        primaryCalls += 1;
        return Promise.reject(new Error('controlled fake failure'));
      },
    };
    const secondary: ModelEngine = {
      generate() {
        secondaryCalls += 1;
        return Promise.resolve({ text: 'Másodlagos eredmény' });
      },
    };
    const modelGateway = new ModelGateway(
      new ModelRegistry([
        { role: 'primary', modelId: 'primary:test', enabled: true, engine: primary },
        { role: 'secondary', modelId: 'secondary:test', enabled: true, engine: secondary },
      ]),
      policy({ attemptRoles: ['primary', 'primary', 'secondary', 'reserve'] }),
    );

    await expect(modelGateway.generateWithRetry(request)).resolves.toEqual({
      text: 'Másodlagos eredmény',
      provenance: { modelRole: 'secondary', modelId: 'secondary:test' },
    });
    expect(primaryCalls).toBe(2);
    expect(secondaryCalls).toBe(1);
  });

  it('exhausts only the configured attempts and records a disabled reserve safely', async () => {
    let calls = 0;
    const failing: ModelEngine = {
      generate() {
        calls += 1;
        return Promise.reject(new Error('upstream detail must remain internal'));
      },
    };
    const modelGateway = new ModelGateway(
      new ModelRegistry([
        { role: 'primary', modelId: 'primary:test', enabled: true, engine: failing },
        { role: 'secondary', modelId: 'secondary:test', enabled: true, engine: failing },
        { role: 'reserve', modelId: 'reserve:test', enabled: false, engine: failing },
      ]),
      policy({ attemptRoles: ['primary', 'primary', 'secondary', 'reserve'] }),
    );

    let failure: unknown;
    try {
      await modelGateway.generateWithRetry(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelOperationError);
    expect(failure).toMatchObject({
      code: 'MODEL_ATTEMPTS_EXHAUSTED',
      attempts: [
        { attemptNumber: 1, modelRole: 'primary', code: 'MODEL_ENGINE_FAILURE' },
        { attemptNumber: 2, modelRole: 'primary', code: 'MODEL_ENGINE_FAILURE' },
        { attemptNumber: 3, modelRole: 'secondary', code: 'MODEL_ENGINE_FAILURE' },
        { attemptNumber: 4, modelRole: 'reserve', code: 'MODEL_ROLE_DISABLED' },
      ],
    });
    expect(String(failure)).not.toContain('upstream detail');
    expect(calls).toBe(3);
  });

  it('records an unconfigured reserve as a controlled exhausted attempt', async () => {
    const failing: ModelEngine = {
      generate: () => Promise.reject(new Error('primary unavailable')),
    };
    const modelGateway = new ModelGateway(
      new ModelRegistry([
        { role: 'primary', modelId: 'primary:test', enabled: true, engine: failing },
      ]),
      policy({ attemptRoles: ['primary', 'reserve'] }),
    );

    await expect(modelGateway.generateWithRetry(request)).rejects.toMatchObject({
      code: 'MODEL_ATTEMPTS_EXHAUSTED',
      attempts: [
        {
          attemptNumber: 1,
          modelRole: 'primary',
          modelId: 'primary:test',
          code: 'MODEL_ENGINE_FAILURE',
        },
        {
          attemptNumber: 2,
          modelRole: 'reserve',
          modelId: null,
          code: 'MODEL_ROLE_NOT_ALLOWED',
        },
      ],
    });
  });

  it('caps the active attempt by the total operation deadline', async () => {
    let primarySignal: AbortSignal | undefined;
    let secondaryCalls = 0;
    const primary: ModelEngine = {
      generate(_input, options) {
        primarySignal = options.signal;
        return new Promise(() => undefined);
      },
    };
    const secondary: ModelEngine = {
      generate() {
        secondaryCalls += 1;
        return Promise.resolve({ text: 'must not run' });
      },
    };
    const modelGateway = new ModelGateway(
      new ModelRegistry([
        { role: 'primary', modelId: 'primary:test', enabled: true, engine: primary },
        { role: 'secondary', modelId: 'secondary:test', enabled: true, engine: secondary },
      ]),
      policy({
        attemptTimeoutMs: 100,
        operationDeadlineMs: 5,
        attemptRoles: ['primary', 'secondary'],
      }),
    );

    await expect(modelGateway.generateWithRetry(request)).rejects.toMatchObject({
      code: 'MODEL_OPERATION_DEADLINE_EXCEEDED',
      attempts: [{ attemptNumber: 1, modelRole: 'primary', code: 'MODEL_TIMEOUT' }],
    });
    expect(primarySignal?.aborted).toBe(true);
    expect(secondaryCalls).toBe(0);
  });
});
