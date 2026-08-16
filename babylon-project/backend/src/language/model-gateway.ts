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
  'MODEL_TIMEOUT',
  'MODEL_ENGINE_FAILURE',
] as const;
export type ModelGatewayErrorCode = (typeof modelGatewayErrorCodes)[number];

const errorMessages: Record<ModelGatewayErrorCode, string> = {
  INVALID_MODEL_REQUEST: 'The model request is invalid.',
  MODEL_ROLE_NOT_ALLOWED: 'The requested model role is not allowed.',
  MODEL_ROLE_DISABLED: 'The requested model role is disabled.',
  MODEL_TIMEOUT: 'The model attempt timed out.',
  MODEL_ENGINE_FAILURE: 'The model engine failed.',
};

class ModelAttemptTimeout extends Error {}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    readonly modelRole: ModelRole | null = null,
    readonly modelId: string | null = null,
  ) {
    super(errorMessages[code]);
    this.name = 'ModelGatewayError';
  }
}

export interface ModelEngine {
  generate(
    request: Readonly<ModelGenerationRequest>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<Readonly<{ text: string }>>;
}

export interface ModelRegistration {
  role: ModelRole;
  modelId: string;
  enabled: boolean;
  engine: ModelEngine;
}

type RegisteredModel = ModelRegistration;

const registrationMetadataSchema = z
  .object({
    role: modelRoleSchema,
    modelId: z.string().trim().min(1).max(160),
    enabled: z.boolean(),
  })
  .strict();

export class ModelRegistry {
  readonly #models = new Map<ModelRole, RegisteredModel>();

  constructor(registrations: readonly ModelRegistration[]) {
    for (const registration of registrations) {
      const metadata = registrationMetadataSchema.safeParse({
        role: registration.role,
        modelId: registration.modelId,
        enabled: registration.enabled,
      });
      if (!metadata.success) throw new Error('Invalid model registry configuration.');
      if (this.#models.has(metadata.data.role)) {
        throw new Error(`Duplicate model role in registry: ${metadata.data.role}`);
      }
      this.#models.set(metadata.data.role, {
        ...metadata.data,
        engine: registration.engine,
      });
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

export class ModelGateway {
  readonly #registry: ModelRegistry;
  readonly #attemptTimeoutMs: number;

  constructor(registry: ModelRegistry, attemptTimeoutMs: number) {
    if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
      throw new Error('Model attempt timeout must be a positive integer.');
    }
    this.#registry = registry;
    this.#attemptTimeoutMs = attemptTimeoutMs;
  }

  async generate(role: unknown, request: unknown): Promise<ModelCandidate> {
    const model = this.#registry.resolve(role);
    const parsedRequest = modelGenerationRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new ModelGatewayError('INVALID_MODEL_REQUEST', model.role, model.modelId);
    }

    const controller = new AbortController();
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      rejectTimeout(new ModelAttemptTimeout());
      controller.abort();
    }, this.#attemptTimeoutMs);

    try {
      const response = await Promise.race([
        model.engine.generate(parsedRequest.data, { signal: controller.signal }),
        timeout,
      ]);
      return modelCandidateSchema.parse({
        text: response.text,
        provenance: { modelRole: model.role, modelId: model.modelId },
      });
    } catch (error) {
      if (error instanceof ModelAttemptTimeout) {
        throw new ModelGatewayError('MODEL_TIMEOUT', model.role, model.modelId);
      }
      if (error instanceof ModelGatewayError) throw error;
      throw new ModelGatewayError('MODEL_ENGINE_FAILURE', model.role, model.modelId);
    } finally {
      clearTimeout(timer);
    }
  }
}
