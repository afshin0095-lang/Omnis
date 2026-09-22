/**
 * `@omnis/events` — the OMNIS event contract foundation.
 *
 * Contains the event vocabulary, the definitions whose payloads Sprint 0 agrees
 * on, the registry that enforces them, and a reference in-memory bus.
 *
 * Dependencies: `@omnis/types`, `@omnis/errors`, `@omnis/contracts`,
 * `@omnis/validation`. It owns no domain logic: it describes what may be said,
 * not what should be done.
 */

export {
  AGENT_EVENT_TYPES,
  ALL_EVENT_TYPES,
  ANALYTICS_EVENT_TYPES,
  AUDIENCE_EVENT_TYPES,
  CHARACTER_EVENT_TYPES,
  CONTENT_EVENT_TYPES,
  EVENT_TYPES_WITHOUT_DEFINITIONS,
  EVENT_TYPE_NAMESPACES,
  PUBLISHING_EVENT_TYPES,
  SYSTEM_EVENT_TYPES,
} from "./event-types.js";

export {
  AI_EVENT_TYPES,
  AI_EVENT_TYPE_LIST,
  AI_EVENT_TYPES_WITHOUT_DEFINITIONS,
} from "./ai-event-types.js";

export {
  AI_EVENT_AGENT_STATES,
  AI_EVENT_BUDGET_DIMENSIONS,
  AI_EVENT_BUDGET_WINDOWS,
  AI_EVENT_EVALUATION_VERDICTS,
  AI_EVENT_FAILURE_CLASSES,
  AI_EVENT_POLICY_OUTCOMES,
  AI_EVENT_PROVIDER_HEALTH_STATES,
  AI_EVENT_PROVIDER_STATUSES,
  AI_EVENT_STOP_REASONS,
  AI_EVENT_TOOL_BLOCKERS,
  AI_EVENT_TOOL_RISK_LEVELS,
  aiAgentStateChangedPayloadSchema,
  aiAgentStepCompletedPayloadSchema,
  aiAgentStepFailedPayloadSchema,
  aiBudgetCommittedPayloadSchema,
  aiBudgetExceededPayloadSchema,
  aiBudgetReleasedPayloadSchema,
  aiBudgetReservedPayloadSchema,
  aiEvaluationCompletedPayloadSchema,
  aiModelCallCompletedPayloadSchema,
  aiModelCallFailedPayloadSchema,
  aiModelFallbackUsedPayloadSchema,
  aiModelRetryScheduledPayloadSchema,
  aiModelStreamCompletedPayloadSchema,
  aiModelStreamFailedPayloadSchema,
  aiModelStreamStartedPayloadSchema,
  aiPolicyDecisionRecordedPayloadSchema,
  aiPolicyViolationDetectedPayloadSchema,
  aiProviderHealthRecordedPayloadSchema,
  aiProviderStatusChangedPayloadSchema,
  aiToolCallBlockedPayloadSchema,
  aiToolCallCompletedPayloadSchema,
  aiToolCallFailedPayloadSchema,
} from "./ai-payloads.js";
export type {
  AiAgentStateChangedPayload,
  AiAgentStepCompletedPayload,
  AiAgentStepFailedPayload,
  AiBudgetCommittedPayload,
  AiBudgetExceededPayload,
  AiBudgetReleasedPayload,
  AiBudgetReservedPayload,
  AiEvaluationCompletedPayload,
  AiModelCallCompletedPayload,
  AiModelCallFailedPayload,
  AiModelFallbackUsedPayload,
  AiModelRetryScheduledPayload,
  AiModelStreamCompletedPayload,
  AiModelStreamFailedPayload,
  AiModelStreamStartedPayload,
  AiPolicyDecisionRecordedPayload,
  AiPolicyViolationDetectedPayload,
  AiProviderHealthRecordedPayload,
  AiProviderStatusChangedPayload,
  AiToolCallBlockedPayload,
  AiToolCallCompletedPayload,
  AiToolCallFailedPayload,
  AiPayloadJsonSafetyAssertion,
} from "./ai-payloads.js";

export { definitionKey, defineEvent } from "./definition.js";
export type { EventDefinition } from "./definition.js";

export { createEventRegistry, EventRegistry } from "./registry.js";

export { EVENT_OWNERS } from "./owners.js";
export { PLATFORM_EVENT_DEFINITIONS, SPRINT0_EVENT_DEFINITIONS } from "./definitions.js";
export { AI_CORE_EVENT_DEFINITIONS, AI_CORE_EVENT_DEFINITIONS_BY_TYPE } from "./ai-definitions.js";

export { createInMemoryEventBus, InMemoryEventBus } from "./bus.js";
export type { EventBus, EventHandler, Subscription } from "./bus.js";

export {
  agentExecutionCompletedPayloadSchema,
  agentExecutionFailedPayloadSchema,
  agentExecutionStartedPayloadSchema,
  analyticsPerformanceRecordedPayloadSchema,
  audienceCommentReceivedPayloadSchema,
  audienceDmReceivedPayloadSchema,
  audienceRequestDetectedPayloadSchema,
  characterCreatedPayloadSchema,
  characterExperienceRecordedPayloadSchema,
  configurationLoadedPayloadSchema,
  contentProductionCompletedPayloadSchema,
  contentProductionRequestedPayloadSchema,
  contentProductionStartedPayloadSchema,
  CONTENT_FORMATS,
  EXPERIENCE_KINDS,
  performanceMetricsSchema,
  publishingJobCompletedPayloadSchema,
  publishingJobCreatedPayloadSchema,
  systemInitializedPayloadSchema,
} from "./payloads.js";
export type {
  AgentExecutionCompletedPayload,
  AgentExecutionFailedPayload,
  AgentExecutionStartedPayload,
  AnalyticsPerformanceRecordedPayload,
  AudienceCommentReceivedPayload,
  AudienceDmReceivedPayload,
  AudienceRequestDetectedPayload,
  CharacterCreatedPayload,
  CharacterExperienceRecordedPayload,
  ConfigurationLoadedPayload,
  ContentFormat,
  ContentProductionCompletedPayload,
  ContentProductionRequestedPayload,
  ContentProductionStartedPayload,
  ExperienceKind,
  PayloadJsonSafetyAssertion,
  PerformanceMetrics,
  PublishingJobCompletedPayload,
  PublishingJobCreatedPayload,
  SystemInitializedPayload,
} from "./payloads.js";
