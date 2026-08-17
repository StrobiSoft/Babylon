import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelEngineError,
  ModelGateway,
  ModelGatewayError,
  ModelRegistry,
  createPlannedLocalModelRegistry,
  type ModelEngine,
  type ModelGatewayPolicy,
  type ModelRegistration,
} from '../src/language/model-gateway.js';

const request = {
  requestId: 'gateway-request-1',
  modelRole: 'primary',
  systemInstructions: 'Translate into the authorized recipient language.',
  inputText: 'Good morning!',
} as const;

function policy(overrides: Partial<ModelGatewayPolicy> = {}): ModelGatewayPolicy {
  return {
    attemptTimeoutMs: 1_000,
    operationDeadlineMs: 5_000,
    maxAttempts: 1,
    ...overrides,
  };
}

function gateway(engine: ModelEngine, overrides: Partial<ModelGatewayPolicy> = {}): ModelGateway {
  return new ModelGateway(createPlannedLocalModelRegistry(), engine, policy(overrides));
}

function registrations(): ModelRegistration[] {
  return [
    { role: 'primary', modelId: 'gpt-oss:20b', enabled: true },
    { role: 'secondary', modelId: 'qwen3:8b', enabled: true },
    {
      role: 'reserve',
      modelId: 'ministral-3:8b-instruct-2512-q4_K_M',
      enabled: false,
    },
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('internal model gateway', () => {
  it('resolves the primary model internally and returns exact provenance', async () => {
    const received: unknown[] = [];
    const engine: ModelEngine = {
      generate(input) {
        received.push(input);
        return Promise.resolve({ text: 'Jó reggelt!' });
      },
    };

    await expect(gateway(engine).generate(request)).resolves.toEqual({
      text: 'Jó reggelt!',
      provenance: { modelRole: 'primary', modelId: 'gpt-oss:20b', attemptCount: 1 },
    });
    expect(received).toEqual([
      {
        modelId: 'gpt-oss:20b',
        systemInstructions: request.systemInstructions,
        inputText: request.inputText,
      },
    ]);
  });

  it('rejects caller-selected model IDs and unknown request fields', async () => {
    let calls = 0;
    const modelGateway = gateway({
      generate: () => {
        calls += 1;
        return Promise.resolve({ text: 'unused' });
      },
    });

    await expect(
      modelGateway.generate({ ...request, modelId: 'attacker/model' }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_REQUEST' });
    await expect(modelGateway.generate({ ...request, extra: true })).rejects.toMatchObject({
      code: 'INVALID_MODEL_REQUEST',
    });
    expect(calls).toBe(0);
  });

  it('reports an unknown role as a controlled role error without invoking the engine', async () => {
    let calls = 0;
    await expect(
      gateway({
        generate: () => {
          calls += 1;
          return Promise.resolve({ text: 'unused' });
        },
      }).generate({ ...request, modelRole: 'attacker/model' }),
    ).rejects.toMatchObject({
      code: 'MODEL_ROLE_NOT_ALLOWED',
      modelRole: null,
      modelId: null,
      attemptCount: 0,
    });
    expect(calls).toBe(0);
  });

  it('rejects duplicate, incomplete, malformed, and invalid registries', () => {
    expect(() => new ModelRegistry([...registrations(), registrations()[0]!])).toThrow(
      'Invalid model registry configuration.',
    );
    expect(() => new ModelRegistry(registrations().slice(0, 2))).toThrow(
      'Invalid model registry configuration.',
    );
    expect(
      () => new ModelRegistry([...registrations(), { role: 'intruder' }] as ModelRegistration[]),
    ).toThrow('Invalid model registry configuration.');
    expect(
      () =>
        new ModelRegistry(
          registrations().map((entry) =>
            entry.role === 'primary' ? { ...entry, modelId: 'bad model\nsecret' } : entry,
          ),
        ),
    ).toThrow('Invalid model registry configuration.');
  });

  it('returns frozen registry snapshots rather than mutable internal entries', () => {
    const resolved = createPlannedLocalModelRegistry().resolve('primary');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => Object.assign(resolved, { modelId: 'attacker/model' })).toThrow();
  });

  it('rejects a disabled reserve role without invoking the engine', async () => {
    let calls = 0;
    const modelGateway = gateway({
      generate: () => {
        calls += 1;
        return Promise.resolve({ text: 'unused' });
      },
    });

    await expect(modelGateway.generate({ ...request, modelRole: 'reserve' })).rejects.toMatchObject(
      {
        code: 'MODEL_ROLE_DISABLED',
        modelRole: 'reserve',
        modelId: 'ministral-3:8b-instruct-2512-q4_K_M',
        attemptCount: 0,
      },
    );
    expect(calls).toBe(0);
  });

  it('aborts and reports a bounded per-attempt timeout deterministically', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const promise = gateway(
      {
        generate(_input, options) {
          signal = options.signal;
          return new Promise(() => undefined);
        },
      },
      { attemptTimeoutMs: 100, operationDeadlineMs: 1_000 },
    ).generate(request);
    const result = expect(promise).rejects.toMatchObject({
      code: 'MODEL_ATTEMPT_TIMEOUT',
      attemptCount: 1,
    });

    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it('retries explicitly retryable failures only to the configured maximum', async () => {
    let calls = 0;
    const modelGateway = gateway(
      {
        generate() {
          calls += 1;
          return Promise.reject(new ModelEngineError('failure', true));
        },
      },
      { maxAttempts: 3 },
    );

    await expect(modelGateway.generate(request)).rejects.toMatchObject({
      code: 'MODEL_ENGINE_RETRYABLE_FAILURE',
      attemptCount: 3,
    });
    expect(calls).toBe(3);
  });

  it('normalizes engine unavailability as a controlled retryable failure', async () => {
    await expect(
      gateway({
        generate: () => Promise.reject(new ModelEngineError('unavailable', true)),
      }).generate(request),
    ).rejects.toMatchObject({
      code: 'MODEL_ENGINE_UNAVAILABLE',
      attemptCount: 1,
    });
  });

  it('does not retry non-retryable or unknown engine failures', async () => {
    for (const failure of [
      new ModelEngineError('failure', false),
      new ModelEngineError('unavailable', false),
      new Error('raw secret'),
    ]) {
      let calls = 0;
      const modelGateway = gateway(
        {
          generate() {
            calls += 1;
            return Promise.reject(failure);
          },
        },
        { maxAttempts: 3 },
      );
      await expect(modelGateway.generate(request)).rejects.toMatchObject({
        code: 'MODEL_ENGINE_NON_RETRYABLE_FAILURE',
        attemptCount: 1,
      });
      expect(calls).toBe(1);
    }
  });

  it('uses the total deadline to abort the active attempt and prevents another attempt', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const promise = gateway(
      {
        generate(_input, options) {
          calls += 1;
          signal = options.signal;
          return new Promise(() => undefined);
        },
      },
      { attemptTimeoutMs: 1_000, operationDeadlineMs: 100, maxAttempts: 3 },
    ).generate(request);
    const result = expect(promise).rejects.toMatchObject({
      code: 'MODEL_OPERATION_DEADLINE_EXCEEDED',
      attemptCount: 1,
    });

    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
  });

  it('propagates caller cancellation to the active fake engine immediately', async () => {
    let signal: AbortSignal | undefined;
    const caller = new AbortController();
    const promise = gateway({
      generate(_input, options) {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    }).generate(request, { signal: caller.signal });
    const result = expect(promise).rejects.toMatchObject({
      code: 'MODEL_CALLER_CANCELLED',
      attemptCount: 1,
    });

    caller.abort();
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it('preserves the gateway cancellation code when the engine rejects on abort', async () => {
    const caller = new AbortController();
    const promise = gateway({
      generate(_input, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('engine aborted')), {
            once: true,
          });
        });
      },
    }).generate(request, { signal: caller.signal });
    const result = expect(promise).rejects.toMatchObject({
      code: 'MODEL_CALLER_CANCELLED',
      attemptCount: 1,
    });

    caller.abort();
    await result;
  });

  it('keeps trusted and untrusted text out of success provenance', async () => {
    const result = await gateway({
      generate: () => Promise.resolve({ text: 'Jó reggelt!' }),
    }).generate(request);
    const provenance = JSON.stringify(result.provenance);

    expect(provenance).not.toContain(request.systemInstructions);
    expect(provenance).not.toContain(request.inputText);
  });

  it('does not leak request text, trusted instructions, engine payloads, or stack causes', async () => {
    const enginePayload = 'private raw engine payload';
    let failure: unknown;
    try {
      await gateway({
        generate: () =>
          Promise.reject(
            new Error(`${request.systemInstructions} ${request.inputText} ${enginePayload}`),
          ),
      }).generate(request);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelGatewayError);
    expect(String(failure)).not.toContain(request.systemInstructions);
    expect(String(failure)).not.toContain(request.inputText);
    expect(String(failure)).not.toContain(enginePayload);
    expect(failure).not.toHaveProperty('cause');
  });

  it('retries the same resolved role and model and never performs implicit fallback', async () => {
    const received: { modelId: string }[] = [];
    let calls = 0;
    const result = await gateway(
      {
        generate(input) {
          calls += 1;
          received.push({ modelId: input.modelId });
          return calls < 3
            ? Promise.reject(new ModelEngineError('failure', true))
            : Promise.resolve({ text: 'Jó reggelt!' });
        },
      },
      { maxAttempts: 3 },
    ).generate(request);

    expect(received).toEqual([
      { modelId: 'gpt-oss:20b' },
      { modelId: 'gpt-oss:20b' },
      { modelId: 'gpt-oss:20b' },
    ]);
    expect(result.provenance).toEqual({
      modelRole: 'primary',
      modelId: 'gpt-oss:20b',
      attemptCount: 3,
    });
  });

  it('rejects nonsensical execution policy values', () => {
    const engine: ModelEngine = { generate: () => Promise.resolve({ text: 'unused' }) };
    expect(
      () =>
        new ModelGateway(createPlannedLocalModelRegistry(), engine, {
          attemptTimeoutMs: 0,
          operationDeadlineMs: 1_000,
          maxAttempts: 1,
        }),
    ).toThrow('Invalid model gateway configuration.');
    expect(
      () =>
        new ModelGateway(createPlannedLocalModelRegistry(), engine, {
          attemptTimeoutMs: 1_000,
          operationDeadlineMs: 1_000,
          maxAttempts: 11,
        }),
    ).toThrow('Invalid model gateway configuration.');
  });
});
