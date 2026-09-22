/**
 * `@omnis/model-orchestrator` — one call, from a model reference to a normalized response.
 *
 * The orchestrator is the only component in AI Core that touches a provider, and it touches it
 * through the {@link ProviderAdapter} contract: no vendor SDK is imported here, and none may be.
 *
 * Public surface:
 * - {@link ModelOrchestrator} / {@link InMemoryModelOrchestrator} / {@link createModelOrchestrator}:
 *   `call` for a complete response, `stream` for an event sequence, `candidatesFor` to explain what
 *   a reference would resolve to without spending anything.
 * - {@link ModelCallRequest} and {@link ModelCallResult}: what a caller asks for and what it gets
 *   back, including the per-provider attempt trail that makes a fallback reconstructible.
 * - The invocation layer — capability inference, budget holds, timeout and retry-delay arithmetic,
 *   retry classification — exported because it is the published semantics of the adapter boundary,
 *   and a test or a future runtime should read it rather than guess it.
 * - The validation schemas and error factories, so a caller can classify a refusal without reaching
 *   into this package.
 *
 * Not exported: the per-call state and the settlement path, which are how the orchestrator keeps its
 * invariants and would be a way around them if public.
 */

export {
  createModelOrchestrator,
  InMemoryModelOrchestrator,
  MAX_CALL_CANDIDATES,
} from "./ModelOrchestrator.js";
export type { ModelOrchestrator, ModelOrchestratorOptions } from "./ModelOrchestrator.js";

export {
  callExecutionId,
  DEFAULT_INVOCATION_RETRY_DELAY_MS,
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_MAX_FALLBACK_PROVIDERS,
  DEFAULT_MAX_PROVIDER_ATTEMPTS,
  MAX_INVOCATION_RETRY_DELAY_MS,
  MAX_PROVIDER_ATTEMPTS,
  modelParameters,
  providerAttempt,
} from "./ModelCall.js";
export type {
  ModelCallApproval,
  ModelCallRequest,
  ModelCallResult,
  ModelCandidate,
  ProviderAttempt,
} from "./ModelCall.js";

export {
  buildModelRequest,
  CHARACTERS_PER_ESTIMATED_TOKEN,
  describeCallTarget,
  estimateInputTokens,
  failureFromAdapter,
  holdsForCall,
  holdsForUsage,
  impliedCapabilities,
  invocationContext,
  invocationDelayMs,
  invocationTimeoutMs,
  isProviderRetryable,
  normalizeInvocationResult,
  shouldTryNextProvider,
  toolsOf,
} from "./invocation.js";

export {
  isMessage,
  isMessageList,
  MAX_REPORTED_ATTEMPTS,
  messagesSchema,
  MODEL_CALL_REQUEST_CONTRACT,
  modelCallRequestSchema,
  modelReferenceSchema,
  PROVIDER_ATTEMPT_CONTRACT,
  providerAttemptSchema,
} from "./orchestratorValidation.js";

export {
  noModelForReference,
  noProviderAvailable,
  providerNotServable,
  streamingUnsupported,
} from "./errors.js";
