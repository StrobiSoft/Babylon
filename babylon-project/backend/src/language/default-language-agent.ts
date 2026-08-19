import type { TranslationPendingReason } from './contracts.js';
import { ConservativeInputClassifier, ConservativeOutputLanguageValidator } from './default-guards.js';
import {
  CandidateGenerationError,
  LanguageAgent,
  type CandidateGenerationRequest,
  type LanguageAgentPolicy,
  type TranslationCandidateGenerator,
} from './language-agent.js';
import {
  ModelGateway,
  ModelGatewayError,
  createPlannedLocalModelRegistry,
  type ModelEngine,
  type ModelGatewayPolicy,
  type ModelRegistry,
} from './model-gateway.js';

const defaultLanguageAgentAttempts: LanguageAgentPolicy['attempts'] = [
  { phase: 'translate', modelRole: 'primary' },
  { phase: 'repair', modelRole: 'primary' },
  { phase: 'translate', modelRole: 'secondary' },
  { phase: 'translate', modelRole: 'reserve' },
];

export const defaultLanguageAgentPolicy: Readonly<LanguageAgentPolicy> = Object.freeze({
  attempts: Object.freeze([...defaultLanguageAgentAttempts]),
});

function languageName(language: 'en' | 'hu' | 'be'): string {
  if (language === 'en') return 'English';
  if (language === 'hu') return 'Hungarian';
  return 'Belarusian';
}

function systemInstructions(request: Readonly<CandidateGenerationRequest>): string {
  const styleInstruction = request.style === undefined ? '' : ` Use ${request.style} wording.`;
  const base = `Translate the user input from ${languageName(request.sourceLanguage)} to ${languageName(request.targetLanguage)}. Return only the translated message.${styleInstruction}`;

  if (request.phase !== 'repair') return base;

  const rejected = request.rejectedCandidateText ?? '';
  return `${base} The previous candidate failed independent target-language validation. Produce a fresh corrected translation. Do not copy or preserve wrong-language wording from the rejected candidate. Rejected candidate: ${JSON.stringify(rejected)}`;
}

function pendingReason(error: ModelGatewayError): TranslationPendingReason {
  if (error.code === 'MODEL_ENGINE_UNAVAILABLE' || error.code === 'MODEL_ROLE_DISABLED') {
    return 'model_unavailable';
  }
  if (
    error.code === 'MODEL_ATTEMPT_TIMEOUT' ||
    error.code === 'MODEL_OPERATION_DEADLINE_EXCEEDED'
  ) {
    return 'processing_timeout';
  }
  return 'technical_failure';
}

export class GatewayTranslationCandidateGenerator implements TranslationCandidateGenerator {
  readonly #gateway: ModelGateway;

  constructor(gateway: ModelGateway) {
    this.#gateway = gateway;
  }

  async generate(request: Readonly<CandidateGenerationRequest>): Promise<unknown> {
    try {
      return await this.#gateway.generate({
        requestId: request.requestId,
        modelRole: request.modelRole,
        systemInstructions: systemInstructions(request),
        inputText: request.sourceText,
      });
    } catch (error) {
      if (error instanceof ModelGatewayError) {
        throw new CandidateGenerationError(pendingReason(error));
      }
      throw error;
    }
  }
}

export interface DefaultLanguageAgentOptions {
  registry?: ModelRegistry;
  gatewayPolicy?: ModelGatewayPolicy;
  agentPolicy?: LanguageAgentPolicy;
}

export function createDefaultLanguageAgent(
  engine: ModelEngine,
  options: Readonly<DefaultLanguageAgentOptions> = {},
): LanguageAgent {
  const registry = options.registry ?? createPlannedLocalModelRegistry();
  const gateway =
    options.gatewayPolicy === undefined
      ? new ModelGateway(registry, engine)
      : new ModelGateway(registry, engine, options.gatewayPolicy);

  return new LanguageAgent(
    new ConservativeInputClassifier(),
    new GatewayTranslationCandidateGenerator(gateway),
    new ConservativeOutputLanguageValidator(),
    options.agentPolicy ?? defaultLanguageAgentPolicy,
  );
}
