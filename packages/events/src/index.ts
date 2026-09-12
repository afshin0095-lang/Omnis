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

export { definitionKey, defineEvent } from "./definition.js";
export type { EventDefinition } from "./definition.js";

export { createEventRegistry, EventRegistry } from "./registry.js";

export { EVENT_OWNERS, SPRINT0_EVENT_DEFINITIONS } from "./definitions.js";

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
