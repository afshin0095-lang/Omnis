/**
 * The AI Core event definitions.
 *
 * All 22 `ai.*` types are registered with an agreed payload contract. Sprint 0
 * left some declared types undefined as a marker of designed deferral; AI Core
 * has none, because every type below has a publisher in Sprint 1 or a consumer
 * that needs the shape fixed before Sprint 2 builds against it. Registering a
 * contract nobody intends to honour would be worse than not declaring it.
 *
 * SCOPE
 * -----
 * `integration` means another domain plausibly acts on the fact: cost
 * attribution, safety review, operator tooling, analytics. `domain` means the
 * event is AI Core's own journal — useful for debugging and replay, of no
 * interest to a publisher or an audience service.
 *
 * The distinction is not cosmetic. Every `integration` event is a promise to the
 * rest of the platform that its payload will keep its meaning across versions,
 * so the bar for adding one is higher than for adding a `domain` event.
 */

import { CONTRACT_VERSION } from "@omnis/contracts";
import { defineEvent, type EventDefinition } from "./definition.js";
import { EVENT_OWNERS } from "./owners.js";
import { AI_EVENT_TYPES } from "./ai-event-types.js";
import {
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

/** Every `ai.*` definition AI Core registers, at {@link CONTRACT_VERSION}. */
export const AI_CORE_EVENT_DEFINITIONS: readonly EventDefinition[] = [
  defineEvent({
    type: AI_EVENT_TYPES.modelCallCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary:
      "A model call produced a response; records which model answered, how long it took and what it cost.",
    payloadSchema: aiModelCallCompletedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.modelCallFailed,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "Every candidate model failed, so the call produced no response.",
    payloadSchema: aiModelCallFailedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.modelFallbackUsed,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A call moved to another provider or model, and why.",
    payloadSchema: aiModelFallbackUsedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.modelRetryScheduled,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary:
      "Another attempt at the same provider was scheduled with a bounded, deterministic delay.",
    payloadSchema: aiModelRetryScheduledPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.modelStreamStarted,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary: "A streamed model response began delivering content.",
    payloadSchema: aiModelStreamStartedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.modelStreamCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A streamed model response completed; records chunk count and measured usage.",
    payloadSchema: aiModelStreamCompletedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.modelStreamFailed,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A stream stopped without completing, or a consumer abandoned it.",
    payloadSchema: aiModelStreamFailedPayloadSchema,
  }),

  defineEvent({
    type: AI_EVENT_TYPES.providerHealthRecorded,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary: "One invocation's outcome was folded into a provider's health.",
    payloadSchema: aiProviderHealthRecordedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.providerStatusChanged,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A provider moved between lifecycle states, e.g. ready to degraded.",
    payloadSchema: aiProviderStatusChangedPayloadSchema,
  }),

  defineEvent({
    type: AI_EVENT_TYPES.toolCallCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A tool ran and returned; records risk level and result size, never the result.",
    payloadSchema: aiToolCallCompletedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.toolCallFailed,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A tool invocation failed or timed out.",
    payloadSchema: aiToolCallFailedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.toolCallBlocked,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A tool call was refused before it ran, by policy, permission, approval or budget.",
    payloadSchema: aiToolCallBlockedPayloadSchema,
  }),

  defineEvent({
    type: AI_EVENT_TYPES.agentStateChanged,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "An agent instance moved between lifecycle states.",
    payloadSchema: aiAgentStateChangedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.agentStepCompleted,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary: "One step of an agent's plan succeeded, with the usage it consumed.",
    payloadSchema: aiAgentStepCompletedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.agentStepFailed,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary: "One step of an agent's plan failed or was skipped.",
    payloadSchema: aiAgentStepFailedPayloadSchema,
  }),

  defineEvent({
    type: AI_EVENT_TYPES.policyDecisionRecorded,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary:
      "A policy set was evaluated; records the outcome and constraint kinds, never constraint values.",
    payloadSchema: aiPolicyDecisionRecordedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.policyViolationDetected,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "Work contradicted a constraint and was refused or clamped.",
    payloadSchema: aiPolicyViolationDetectedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.budgetReserved,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary: "Budget was held before expensive work began.",
    payloadSchema: aiBudgetReservedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.budgetCommitted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A hold was settled against what the work actually consumed.",
    payloadSchema: aiBudgetCommittedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.budgetReleased,
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.aiCore,
    summary: "A hold was released because the work did not happen.",
    payloadSchema: aiBudgetReleasedPayloadSchema,
  }),
  defineEvent({
    type: AI_EVENT_TYPES.budgetExceeded,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A budget could not cover requested work, and the work was refused.",
    payloadSchema: aiBudgetExceededPayloadSchema,
  }),

  defineEvent({
    type: AI_EVENT_TYPES.evaluationCompleted,
    version: CONTRACT_VERSION,
    scope: "integration",
    owner: EVENT_OWNERS.aiCore,
    summary: "A deterministic evaluation produced a verdict and a score.",
    payloadSchema: aiEvaluationCompletedPayloadSchema,
  }),
];

/** Every AI Core event definition, keyed by event type for tests and documentation. */
export const AI_CORE_EVENT_DEFINITIONS_BY_TYPE: ReadonlyMap<string, EventDefinition> = new Map(
  AI_CORE_EVENT_DEFINITIONS.map((definition) => [String(definition.type), definition]),
);
