import { z } from 'zod';
import {
  modelCandidateSchema,
  modelGenerationRequestSchema,
  modelRoleSchema,
  type ModelCandidate,
  type ModelGenerationRequest,
  type ModelRole,
} from './contracts.js';

export const plannedLocalModels = {
  primary: { modelId: 'gpt-oss:20b', enabled: true },
  secondary: { modelId: 'qwen3:8b', enabled: true },
  reserve: { modelId: 'ministral-3:8b-instruct-2512-q4_K_M', enabled: false },
} as const satisfies Record<ModelRole, { modelId: string; enabled: boolean }>;

export const modelGatewayErrorCodes = [
  'INVALID_MODEL_REQUEST',
  'MODEL_ROLE_NOT_ALLOWED',
  'MODEL_ROLE_DISABLED',
  'MODEL_ATTEMPT_TIMEOUT',
  'MODEL_ENGINE_UNAVAILABLE',
  'MODEL_ENGINE_RETRYABLE_FAILURE',
  'MODEL_ENGINE_NON_RETRYABLE_FAILURE',
  'MODEL_OPERATION_DEADLINE_EXCEEDED',
  'MODEL_CALLER_CANCELLED',
] as const;
export type ModelGatewayErrorCode = (typeof modelGatewayErrorCodes)[number];

const errorMessages: Record<ModelGatewayErrorCode, string> = {
  INVALID_MODEL_REQUEST: 'The model request is invalid.',
  MODEL_ROLE_NOT_ALLOWED: 'The requested model role is not allowed.',
  MODEL_ROLE_DISABLED: 'The requested model role is disabled.',
  MODEL_ATTEMPT_TIMEOUT: 'The model attempt timed out.',
  MODEL_ENGINE_UNAVAILABLE: 'The model engine is unavailable.',
  MODEL_ENGINE_RETRYABLE_FAILURE: 'The model engine failed temporarily.',
  MODEL_ENGINE_NON_RETRYABLE_FAILURE: 'The model engine failed.',
  MODEL_OPERATION_DEADLINE_EXCEEDED: 'The model operation deadline was exceeded.',
  MODEL_CALLER_CANCELLED: 'The model operation was cancelled.',
};

const retryableGatewayCodes = new Set<ModelGatewayErrorCode>([
  'MODEL_ATTEMPT_TIMEOUT',
  'MODEL_ENGINE_UNAVAILABLE',
  'MODEL_ENGINE_RETRYABLE_FAILURE',
]);

export interface ModelGatewayPolicy {
  attemptTimeoutMs: number;
  operationDeadlineMs: number;
  maxAttempts: number;
}

export const defaultModelGatewayPolicy: Readonly<ModelGatewayPolicy> = Object.freeze({
  attemptTimeoutMs: 30_000,
  operationDeadlineMs: 60_000,
  maxAttempts: 2,
});

export interface ModelEngineRequest {
  modelId: string;
  systemInstructions: string;
  inputText: string;
}

export interface ModelEngine {
  generate(
    request: Readonly<ModelEngineRequest>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<Readonly<{ text: string }>>;
}

export type ModelEngineFailureKind = 'unavailable' | 'failure';

export class ModelEngineError extends Error {
  constructor(
    readonly kind: ModelEngineFailureKind,
    readonly retryable: boolean,
  ) {
    super('The model engine reported a controlled failure.');
    this.name = 'ModelEngineError';
  }
}

export interface ModelRegistration {
  role: ModelRole;
  modelId: string;
  enabled: boolean;
}

type RegisteredModel = Readonly<ModelRegistration>;

const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const registrationMetadataSchema = z
  .object({
    role: modelRoleSchema,
    modelId: modelIdSchema,
    enabled: z.boolean(),
  })
  .strict();
const timeoutMillisecondsSchema = z.number().int().positive().max(2_147_483_647);
const modelGatewayPolicySchema = z
  .object({
    attemptTimeoutMs: timeoutMillisecondsSchema,
    operationDeadlineMs: timeoutMillisecondsSchema,
    maxAttempts: z.number().int().min(1).max(10),
  })
  .strict();

export class ModelRegistry {
  readonly #models = new Map<ModelRole, RegisteredModel>();

  constructor(registrations: readonly ModelRegistration[]) {
    for (const registration of registrations) {
      const parsed = registrationMetadataSchema.safeParse(registration);
      if (!parsed.success) throw new Error('Invalid model registry configuration.');
      if (this.#models.has(parsed.data.role)) {
        throw new Error('Invalid model registry configuration.');
      }
      this.#models.set(parsed.data.role, Object.freeze({ ...parsed.data }));
    }
    if (this.#models.size !== modelRoleSchema.options.length) {
      throw new Error('Invalid model registry configuration.');
    }
  }

  resolve(role: unknown): RegisteredModel {
    const parsedRole = modelRoleSchema.safeParse(role);
    if (!parsedRole.success) throw new ModelGatewayError('MODEL_ROLE_NOT_ALLOWED');
    const model = this.#models.get(parsedRole.data);
    if (!model) throw new ModelGatewayError('MODEL_ROLE_NOT_ALLOWED', parsedRole.data);
    if (!model.enabled) {
      throw new ModelGatewayError('MODEL_ROLE_DISABLED', model.role, model.modelId);
    }
    return model;
  }
}

export function createPlannedLocalModelRegistry(): ModelRegistry {
  return new ModelRegistry(
    modelRoleSchema.options.map((role) => ({ role, ...plannedLocalModels[role] })),
  );
}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    readonly modelRole: ModelRole | null = null,
    readonly modelId: string | null = null,
    readonly attemptCount = 0,
  ) {
    super(errorMessages[code]);
    this.name = 'ModelGatewayError';
  }
}

type AttemptEnd = 'timeout' | 'deadline' | 'caller';

class ModelAttemptEnded extends Error {
  constructor(readonly reason: AttemptEnd) {
    super('The model attempt ended.');
  }
}

export class ModelGateway {
  readonly #registry: ModelRegistry;
  readonly #engine: ModelEngine;
  readonly #policy: Readonly<ModelGatewayPolicy>;

  constructor(
    registry: ModelRegistry,
    engine: ModelEngine,
    policy: ModelGatewayPolicy = defaultModelGatewayPolicy,
  ) {
    const parsedPolicy = modelGatewayPolicySchema.safeParse(policy);
    if (!parsedPolicy.success || typeof engine.generate !== 'function') {
      throw new Error('Invalid model gateway configuration.');
    }
    this.#registry = registry;
    this.#engine = engine;
    this.#policy = Object.freeze({ ...parsedPolicy.data });
  }

  async generate(
    request: unknown,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ModelCandidate> {
    const parsedRequest = modelGenerationRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      const requestedRole =
        typeof request === 'object' && request !== null && 'modelRole' in request
          ? request.modelRole
          : undefined;
      if (requestedRole !== undefined && !modelRoleSchema.safeParse(requestedRole).success) {
        throw new ModelGatewayError('MODEL_ROLE_NOT_ALLOWED');
      }
      throw new ModelGatewayError('INVALID_MODEL_REQUEST');
    }

    const model = this.#registry.resolve(parsedRequest.data.modelRole);
    const deadlineAt = Date.now() + this.#policy.operationDeadlineMs;

    for (let attemptCount = 1; attemptCount <= this.#policy.maxAttempts; attemptCount += 1) {
      if (options.signal?.aborted) {
        throw new ModelGatewayError(
          'MODEL_CALLER_CANCELLED',
          model.role,
          model.modelId,
          attemptCount - 1,
        );
      }

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new ModelGatewayError(
          'MODEL_OPERATION_DEADLINE_EXCEEDED',
          model.role,
          model.modelId,
          attemptCount - 1,
        );
      }

      try {
        return await this.#runAttempt(
          model,
          parsedRequest.data,
          attemptCount,
          remainingMs,
          options.signal,
        );
      } catch (error) {
        if (!(error instanceof ModelGatewayError)) throw error;
        if (!retryableGatewayCodes.has(error.code) || attemptCount >= this.#policy.maxAttempts) {
          throw error;
        }
      }
    }

    throw new ModelGatewayError(
      'MODEL_ENGINE_NON_RETRYABLE_FAILURE',
      model.role,
      model.modelId,
      this.#policy.maxAttempts,
    );
  }

  async #runAttempt(
    model: RegisteredModel,
    request: ModelGenerationRequest,
    attemptCount: number,
    remainingMs: number,
    callerSignal?: AbortSignal,
  ): Promise<ModelCandidate> {
    const controller = new AbortController();
    const boundedByDeadline = remainingMs <= this.#policy.attemptTimeoutMs;
    const timeoutMs = Math.min(this.#policy.attemptTimeoutMs, remainingMs);
    let rejectAttempt: (error: ModelAttemptEnded) => void = () => undefined;
    const attemptEnd = new Promise<never>((_resolve, reject) => {
      rejectAttempt = reject;
    });
    const endForCaller = () => {
      rejectAttempt(new ModelAttemptEnded('caller'));
      controller.abort();
    };
    callerSignal?.addEventListener('abort', endForCaller, { once: true });
    const timer = setTimeout(() => {
      rejectAttempt(new ModelAttemptEnded(boundedByDeadline ? 'deadline' : 'timeout'));
      controller.abort();
    }, timeoutMs);

    try {
      const response = await Promise.race([
        this.#engine.generate(
          {
            modelId: model.modelId,
            systemInstructions: request.systemInstructions,
            inputText: request.inputText,
          },
          { signal: controller.signal },
        ),
        attemptEnd,
      ]);
      const candidate = modelCandidateSchema.safeParse({
        text: response.text,
        provenance: { modelRole: model.role, modelId: model.modelId, attemptCount },
      });
      if (!candidate.success) {
        throw new ModelGatewayError(
          'MODEL_ENGINE_NON_RETRYABLE_FAILURE',
          model.role,
          model.modelId,
          attemptCount,
        );
      }
      return candidate.data;
    } catch (error) {
      if (error instanceof ModelAttemptEnded) {
        const code: ModelGatewayErrorCode =
          error.reason === 'caller'
            ? 'MODEL_CALLER_CANCELLED'
            : error.reason === 'deadline'
              ? 'MODEL_OPERATION_DEADLINE_EXCEEDED'
              : 'MODEL_ATTEMPT_TIMEOUT';
        throw new ModelGatewayError(code, model.role, model.modelId, attemptCount);
      }
      if (error instanceof ModelGatewayError) throw error;
      if (error instanceof ModelEngineError) {
        const code: ModelGatewayErrorCode = !error.retryable
          ? 'MODEL_ENGINE_NON_RETRYABLE_FAILURE'
          : error.kind === 'unavailable'
            ? 'MODEL_ENGINE_UNAVAILABLE'
            : 'MODEL_ENGINE_RETRYABLE_FAILURE';
        throw new ModelGatewayError(code, model.role, model.modelId, attemptCount);
      }
      throw new ModelGatewayError(
        'MODEL_ENGINE_NON_RETRYABLE_FAILURE',
        model.role,
        model.modelId,
        attemptCount,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', endForCaller);
    }
  }
}
