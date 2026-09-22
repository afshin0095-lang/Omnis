/**
 * The AI Core event vocabulary: the `ai.*` namespace.
 *
 * WHY A NEW NAMESPACE RATHER THAN MORE `agent.*`
 * ----------------------------------------------
 * Sprint 0 declared `agent.*` for the five facts the platform could already
 * name: an execution started, completed, failed, invoked a tool, or was blocked.
 * Those stay where they are — they are published, versioned and consumed.
 *
 * AI Core needs a vocabulary for the machinery *underneath* an execution: which
 * model answered, which provider was fallen back to, what a policy decided, what
 * a budget held and charged, what an evaluation concluded. Stretching `agent.*`
 * to cover them would put provider health and budget ledger facts under a name
 * that says "agent", and a consumer subscribing to `agent.*` would start
 * receiving events about money. Namespace follows ownership and subject, so the
 * subject here is AI Core: `ai.*`.
 *
 * OUTCOMES, NOT INTENTIONS
 * ------------------------
 * There is no `ai.model.call.requested` and no `ai.tool.call.requested`. A
 * request is already a fact in the execution record, with its identifier, its
 * policy outcome and its reservation; publishing it again would create a second
 * source of truth that a consumer must reconcile against the first. Every type
 * below reports something that *finished* or *changed*.
 *
 * NAMING
 * ------
 * `<namespace>.<subject>.<past-tense-verb>`, as everywhere else in the
 * vocabulary. Each constant is passed through `parseEventType` at module load,
 * so a malformed name fails at import time rather than at routing time.
 */

import { parseEventType, type EventType } from "@omnis/types";

/** AI Core's event vocabulary: 22 facts about model, provider, tool, agent, policy, budget and evaluation work. */
export const AI_EVENT_TYPES = {
  // --- model layer ---------------------------------------------------------
  /** A model call produced a response. */
  modelCallCompleted: parseEventType("ai.model.call.completed"),
  /** A model call ran out of candidates without producing a response. */
  modelCallFailed: parseEventType("ai.model.call.failed"),
  /** The orchestrator moved to another provider or model mid-call. */
  modelFallbackUsed: parseEventType("ai.model.fallback.used"),
  /** Another attempt at the same provider was scheduled, with a delay. */
  modelRetryScheduled: parseEventType("ai.model.retry.scheduled"),
  /** A streamed model response began delivering content. */
  modelStreamStarted: parseEventType("ai.model.stream.started"),
  /** A streamed model response reached its terminal event. */
  modelStreamCompleted: parseEventType("ai.model.stream.completed"),
  /** A streamed model response stopped without completing. */
  modelStreamFailed: parseEventType("ai.model.stream.failed"),

  // --- provider layer ------------------------------------------------------
  /** One invocation's outcome was folded into a provider's health. */
  providerHealthRecorded: parseEventType("ai.provider.health.recorded"),
  /** A provider moved between lifecycle states. */
  providerStatusChanged: parseEventType("ai.provider.status.changed"),

  // --- tool layer ----------------------------------------------------------
  /** A tool invocation finished and produced a result. */
  toolCallCompleted: parseEventType("ai.tool.call.completed"),
  /** A tool invocation failed. */
  toolCallFailed: parseEventType("ai.tool.call.failed"),
  /** A tool invocation was refused before it ran, by policy, permission or budget. */
  toolCallBlocked: parseEventType("ai.tool.call.blocked"),

  // --- agent layer ---------------------------------------------------------
  /** An agent instance moved between lifecycle states. */
  agentStateChanged: parseEventType("ai.agent.state.changed"),
  /** One step of an agent's plan succeeded. */
  agentStepCompleted: parseEventType("ai.agent.step.completed"),
  /** One step of an agent's plan failed or was skipped. */
  agentStepFailed: parseEventType("ai.agent.step.failed"),

  // --- governance ----------------------------------------------------------
  /** A policy set was evaluated and its outcome recorded. */
  policyDecisionRecorded: parseEventType("ai.policy.decision.recorded"),
  /** Work was found to contradict a constraint, and was stopped or clamped. */
  policyViolationDetected: parseEventType("ai.policy.violation.detected"),
  /** Budget was held before expensive work began. */
  budgetReserved: parseEventType("ai.budget.reserved"),
  /** A hold was settled against what the work actually consumed. */
  budgetCommitted: parseEventType("ai.budget.committed"),
  /** A hold was released because the work did not happen. */
  budgetReleased: parseEventType("ai.budget.released"),
  /** A budget could not cover requested work, and the work was refused. */
  budgetExceeded: parseEventType("ai.budget.exceeded"),

  // --- evaluation ----------------------------------------------------------
  /** A deterministic evaluation produced a result. */
  evaluationCompleted: parseEventType("ai.evaluation.completed"),
} as const satisfies Record<string, EventType>;

/** Every declared `ai.*` event type, in declaration order. */
export const AI_EVENT_TYPE_LIST: readonly EventType[] = Object.freeze(
  Object.values(AI_EVENT_TYPES),
);

/**
 * Every `ai.*` type has an agreed payload contract.
 *
 * Sprint 0 left a list of declared-but-undefined types as a marker of designed
 * deferral. AI Core has no such list, and that is a deliberate difference: an
 * event type nobody can publish is a boundary nobody can build against, and
 * Sprint 1 builds against all of these. The array is kept — empty — so that a
 * future deferral has an obvious, reviewable place to be recorded rather than
 * being expressed by quietly omitting a definition.
 */
export const AI_EVENT_TYPES_WITHOUT_DEFINITIONS: readonly EventType[] = Object.freeze([]);
