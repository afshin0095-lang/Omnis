/**
 * The Sprint 0 OMNIS event vocabulary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Event type names are the platform's routing keys, its ownership map and its
 * audit vocabulary. If they are invented ad hoc at each publish site, the stream
 * fills with near-duplicates (`character.created`, `character_create`,
 * `CharacterCreated`) that no consumer can subscribe to reliably.
 *
 * Declaring them here, once, means:
 * - a producer cannot publish a name nobody has agreed on;
 * - a consumer can discover the whole vocabulary by reading one file;
 * - renaming is a visible, reviewable, versioned change rather than a silent edit
 *   in a service.
 *
 * Every constant is passed through `parseEventType` at module load, so a
 * malformed name fails at import time rather than at 3am when an event cannot be
 * routed. This is deliberately stricter than a unit test: the guarantee holds
 * even if the test is deleted.
 *
 * SCOPE OF SPRINT 0
 * -----------------
 * This is the *vocabulary*, not the implementation. Declaring `analytics
 * .performance.recorded` does not mean OMNIS can measure performance yet; it
 * means the boundary is agreed so the owning domain can be built without
 * renegotiating the contract. Types whose payload definitions are not yet agreed
 * are listed in {@link EVENT_TYPES_WITHOUT_DEFINITIONS} and must be registered by
 * their owning domain before they can be published — the registry rejects
 * anything unregistered.
 *
 * NAMING CONVENTION
 * -----------------
 * `<namespace>.<subject>.<past-tense-verb>` — events are facts, so they read as
 * things that already happened. A name that reads as an instruction
 * (`content.publish`) is a command and belongs in the command vocabulary.
 */

import { parseEventType, type EventType } from "@omnis/types";

/** Platform lifecycle and health. */
export const SYSTEM_EVENT_TYPES = {
  /** A service finished booting and is ready to accept work. */
  initialized: parseEventType("system.initialized"),
  /** Configuration was loaded and validated successfully. */
  configurationLoaded: parseEventType("system.configuration.loaded"),
  /** A graceful shutdown has been requested. */
  shutdownRequested: parseEventType("system.shutdown.requested"),
  /** A dependency or subsystem dropped below its health threshold. */
  healthDegraded: parseEventType("system.health.degraded"),
} as const satisfies Record<string, EventType>;

/** Agent and model execution lifecycle, owned by AI Core. */
export const AGENT_EVENT_TYPES = {
  executionStarted: parseEventType("agent.execution.started"),
  executionCompleted: parseEventType("agent.execution.completed"),
  executionFailed: parseEventType("agent.execution.failed"),
  /** A tool invocation was requested by an agent. */
  toolInvoked: parseEventType("agent.tool.invoked"),
  /** A policy or approval gate blocked an agent action. */
  actionBlocked: parseEventType("agent.action.blocked"),
} as const satisfies Record<string, EventType>;

/** Persistent digital human state, owned by Character OS. */
export const CHARACTER_EVENT_TYPES = {
  created: parseEventType("character.created"),
  updated: parseEventType("character.updated"),
  /**
   * Something happened to a character that it should remember.
   *
   * This is the entry point of the evolution loop: experience is recorded first,
   * then observed, evaluated, reflected on and learned from. Nothing downstream
   * in that loop can function if experience is not captured as structured state
   * rather than improvised per generation.
   */
  experienceRecorded: parseEventType("character.experience.recorded"),
  /** A skill, trait or behaviour changed as a result of learning. */
  evolutionApplied: parseEventType("character.evolution.applied"),
  /** A relationship between characters, or with an audience segment, changed. */
  relationshipChanged: parseEventType("character.relationship.changed"),
} as const satisfies Record<string, EventType>;

/** Audience signals and derived intelligence. */
export const AUDIENCE_EVENT_TYPES = {
  commentReceived: parseEventType("audience.comment.received"),
  dmReceived: parseEventType("audience.dm.received"),
  /** Language, sentiment or intent was classified on an inbound signal. */
  signalClassified: parseEventType("audience.signal.classified"),
  /** A content request was recognised in an inbound signal. */
  requestDetected: parseEventType("audience.request.detected"),
  /** Similar requests were grouped and demand was counted. */
  requestClustered: parseEventType("audience.request.clustered"),
  /** An audience member moved along the loyalty lifecycle. */
  loyaltyTierChanged: parseEventType("audience.loyalty.tier.changed"),
  /** A scored content opportunity was raised for Strategy to consider. */
  opportunityCreated: parseEventType("audience.opportunity.created"),
} as const satisfies Record<string, EventType>;

/** Content production lifecycle, owned by the Content Factory. */
export const CONTENT_EVENT_TYPES = {
  ideaCreated: parseEventType("content.idea.created"),
  productionRequested: parseEventType("content.production.requested"),
  productionStarted: parseEventType("content.production.started"),
  /** A stage of the production pipeline finished. */
  stageCompleted: parseEventType("content.stage.completed"),
  productionCompleted: parseEventType("content.production.completed"),
  productionFailed: parseEventType("content.production.failed"),
  /** Quality assurance scored or approved a produced asset. */
  qualityAssessed: parseEventType("content.quality.assessed"),
} as const satisfies Record<string, EventType>;

/** Publication lifecycle, owned by Publishing. */
export const PUBLISHING_EVENT_TYPES = {
  jobCreated: parseEventType("publishing.job.created"),
  jobScheduled: parseEventType("publishing.job.scheduled"),
  /** A human approval gate was raised before publication. */
  approvalRequested: parseEventType("publishing.approval.requested"),
  jobStarted: parseEventType("publishing.job.started"),
  jobCompleted: parseEventType("publishing.job.completed"),
  jobFailed: parseEventType("publishing.job.failed"),
  /** The platform confirmed the content is publicly reachable. */
  publicationVerified: parseEventType("publishing.publication.verified"),
} as const satisfies Record<string, EventType>;

/** Measurement and growth, owned by Analytics. */
export const ANALYTICS_EVENT_TYPES = {
  performanceRecorded: parseEventType("analytics.performance.recorded"),
  /** A retention, CTR or engagement metric crossed a threshold. */
  thresholdCrossed: parseEventType("analytics.threshold.crossed"),
  /** An experiment produced a conclusion. */
  experimentConcluded: parseEventType("analytics.experiment.concluded"),
  /** A learning was derived from measured outcomes and fed back to Strategy. */
  learningRecorded: parseEventType("analytics.learning.recorded"),
} as const satisfies Record<string, EventType>;

/**
 * Every declared event type, keyed by namespace.
 *
 * This is the authoritative vocabulary. Adding a namespace is a domain-boundary
 * change and requires an ADR; adding a type within an existing namespace is
 * additive.
 */
export const EVENT_TYPE_NAMESPACES = {
  system: SYSTEM_EVENT_TYPES,
  agent: AGENT_EVENT_TYPES,
  character: CHARACTER_EVENT_TYPES,
  audience: AUDIENCE_EVENT_TYPES,
  content: CONTENT_EVENT_TYPES,
  publishing: PUBLISHING_EVENT_TYPES,
  analytics: ANALYTICS_EVENT_TYPES,
} as const;

/** Every declared event type as a flat list, for registry seeding and tests. */
export const ALL_EVENT_TYPES: readonly EventType[] = Object.values(EVENT_TYPE_NAMESPACES).flatMap(
  (namespace) => Object.values(namespace),
);

/**
 * Declared types whose payload contract is **not** yet agreed.
 *
 * These are published nowhere in Sprint 0 and cannot be registered without a
 * payload definition from their owning domain. Listing them explicitly is what
 * separates "designed and deferred" from "forgotten": a reader can see the
 * boundary is intentional, and the registry will reject any attempt to publish
 * one until the owning domain supplies a definition.
 *
 * See docs/01-architecture/EVENT_ARCHITECTURE.md for the ownership map.
 */
export const EVENT_TYPES_WITHOUT_DEFINITIONS: readonly EventType[] = [
  SYSTEM_EVENT_TYPES.shutdownRequested,
  SYSTEM_EVENT_TYPES.healthDegraded,
  AGENT_EVENT_TYPES.toolInvoked,
  AGENT_EVENT_TYPES.actionBlocked,
  CHARACTER_EVENT_TYPES.updated,
  CHARACTER_EVENT_TYPES.evolutionApplied,
  CHARACTER_EVENT_TYPES.relationshipChanged,
  AUDIENCE_EVENT_TYPES.signalClassified,
  AUDIENCE_EVENT_TYPES.requestClustered,
  AUDIENCE_EVENT_TYPES.loyaltyTierChanged,
  AUDIENCE_EVENT_TYPES.opportunityCreated,
  CONTENT_EVENT_TYPES.ideaCreated,
  CONTENT_EVENT_TYPES.stageCompleted,
  CONTENT_EVENT_TYPES.productionFailed,
  CONTENT_EVENT_TYPES.qualityAssessed,
  PUBLISHING_EVENT_TYPES.jobScheduled,
  PUBLISHING_EVENT_TYPES.approvalRequested,
  PUBLISHING_EVENT_TYPES.jobStarted,
  PUBLISHING_EVENT_TYPES.jobFailed,
  PUBLISHING_EVENT_TYPES.publicationVerified,
  ANALYTICS_EVENT_TYPES.thresholdCrossed,
  ANALYTICS_EVENT_TYPES.experimentConcluded,
  ANALYTICS_EVENT_TYPES.learningRecorded,
];
