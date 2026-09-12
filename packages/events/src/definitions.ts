/**
 * The Sprint 0 event definitions.
 *
 * These are the event types whose payload contracts are agreed well enough to
 * register now. Everything else in the vocabulary is declared but deliberately
 * unregistered (see `EVENT_TYPES_WITHOUT_DEFINITIONS`), and the registry will
 * refuse to publish one until its owning domain supplies a definition.
 *
 * That refusal is the point. A declared-but-undefined event type is a boundary
 * that has been *designed*; publishing one anyway would be a boundary that has
 * been guessed at, and the guess would then be frozen into a persisted stream.
 *
 * OWNERSHIP
 * ---------
 * Each definition names the service that owns the contract. Ownership follows the
 * namespace, which is how a malformed or badly-designed event gets routed to
 * someone with the authority to fix it.
 *
 * SCOPE
 * -----
 * Most of these are `integration` events, because the OMNIS feedback loop only
 * works if audience signals reach strategy, production reaches publishing, and
 * publishing reaches analytics. Two are `domain`:
 *
 * - `system.configuration.loaded` is an operational detail of one process.
 * - `character.experience.recorded` is Character OS's internal state journal.
 *   Publishing it platform-wide would expose the raw material of a character's
 *   inner life to every consumer, for no benefit — the *consequences* of
 *   experience (behaviour changes, performance) are what other domains need.
 */

import { parseTrimmedString } from "@omnis/types";
import type { EventDefinition } from "./definition.js";
import { defineEvent } from "./definition.js";
import { CONTRACT_VERSION } from "@omnis/contracts";
import {
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
  publishingJobCompletedPayloadSchema,
  publishingJobCreatedPayloadSchema,
  systemInitializedPayloadSchema,
} from "./payloads.js";
import {
  AGENT_EVENT_TYPES,
  ANALYTICS_EVENT_TYPES,
  AUDIENCE_EVENT_TYPES,
  CHARACTER_EVENT_TYPES,
  CONTENT_EVENT_TYPES,
  PUBLISHING_EVENT_TYPES,
  SYSTEM_EVENT_TYPES,
} from "./event-types.js";

/**
 * Logical service names owning each event namespace.
 *
 * These are the names that will appear in `source` and `owner` once the services
 * exist. Declaring them now means the ownership map is fixed before code is
 * written against it, rather than being negotiated afterwards.
 */
export const EVENT_OWNERS = {
  platform: parseTrimmedString("omnis.platform"),
  aiCore: parseTrimmedString("ai-core"),
  characterOs: parseTrimmedString("character-os"),
  audienceIntelligence: parseTrimmedString("audience-intelligence"),
  contentStrategy: parseTrimmedString("content-strategy"),
  contentFactory: parseTrimmedString("content-factory"),
  publishing: parseTrimmedString("publishing"),
  analytics: parseTrimmedString("analytics"),
} as const;

/**
 * Every event definition Sprint 0 registers.
 *
 * All are at {@link CONTRACT_VERSION}. An event's version is bumped only when its
 * payload contract changes, independently of the platform's release version.
 */
export const SPRINT0_EVENT_DEFINITIONS: readonly EventDefinition[] = [
  defineEvent({
    type: SYSTEM_EVENT_TYPES.initialized,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.platform,
    summary: "A service finished booting and is ready to accept work.",
    payloadSchema: systemInitializedPayloadSchema,
  }),
  defineEvent({
    type: SYSTEM_EVENT_TYPES.configurationLoaded,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.platform,
    summary: "Configuration was read and validated; records key names only, never values.",
    payloadSchema: configurationLoadedPayloadSchema,
  }),

  defineEvent({
    type: AGENT_EVENT_TYPES.executionStarted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "An agent began executing a capability.",
    payloadSchema: agentExecutionStartedPayloadSchema,
  }),
  defineEvent({
    type: AGENT_EVENT_TYPES.executionCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "An agent finished executing a capability, with duration, token and cost attribution.",
    payloadSchema: agentExecutionCompletedPayloadSchema,
  }),
  defineEvent({
    type: AGENT_EVENT_TYPES.executionFailed,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "An agent execution failed; carries the error classification, not the error object.",
    payloadSchema: agentExecutionFailedPayloadSchema,
  }),

  defineEvent({
    type: CHARACTER_EVENT_TYPES.created,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.characterOs,
    summary: "A persistent digital human was created from a character definition.",
    payloadSchema: characterCreatedPayloadSchema,
  }),
  defineEvent({
    type: CHARACTER_EVENT_TYPES.experienceRecorded,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.characterOs,
    summary: "An experience was recorded against a character, entering the evolution loop.",
    payloadSchema: characterExperienceRecordedPayloadSchema,
  }),

  defineEvent({
    type: AUDIENCE_EVENT_TYPES.commentReceived,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.audienceIntelligence,
    summary: "A public comment was ingested from a social platform.",
    payloadSchema: audienceCommentReceivedPayloadSchema,
  }),
  defineEvent({
    type: AUDIENCE_EVENT_TYPES.dmReceived,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.audienceIntelligence,
    summary: "A direct message was ingested from a social platform.",
    payloadSchema: audienceDmReceivedPayloadSchema,
  }),
  defineEvent({
    type: AUDIENCE_EVENT_TYPES.requestDetected,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.audienceIntelligence,
    summary: "A content request was recognised in an audience signal.",
    payloadSchema: audienceRequestDetectedPayloadSchema,
  }),

  defineEvent({
    type: CONTENT_EVENT_TYPES.productionRequested,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.contentFactory,
    summary: "Content production was requested for a content item.",
    payloadSchema: contentProductionRequestedPayloadSchema,
  }),
  defineEvent({
    type: CONTENT_EVENT_TYPES.productionStarted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.contentFactory,
    summary: "The production pipeline began work on a content item.",
    payloadSchema: contentProductionStartedPayloadSchema,
  }),
  defineEvent({
    type: CONTENT_EVENT_TYPES.productionCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.contentFactory,
    summary: "Production finished; the item may still require QA and approval.",
    payloadSchema: contentProductionCompletedPayloadSchema,
  }),

  defineEvent({
    type: PUBLISHING_EVENT_TYPES.jobCreated,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.publishing,
    summary: "A publishing job was created, including whether human approval is required.",
    payloadSchema: publishingJobCreatedPayloadSchema,
  }),
  defineEvent({
    type: PUBLISHING_EVENT_TYPES.jobCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.publishing,
    summary: "A platform confirmed the content is publicly reachable.",
    payloadSchema: publishingJobCompletedPayloadSchema,
  }),

  defineEvent({
    type: ANALYTICS_EVENT_TYPES.performanceRecorded,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.analytics,
    summary: "A performance sample was recorded for a content item over a stated window.",
    payloadSchema: analyticsPerformanceRecordedPayloadSchema,
  }),
];
