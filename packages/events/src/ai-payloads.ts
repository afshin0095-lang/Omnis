/**
 * Payload schemas for the `ai.*` event vocabulary.
 *
 * The modelling rules are the ones stated at the top of `payloads.ts`, and they
 * apply here unchanged: no optional properties (`T | null` instead), no nested
 * serialized errors, no duplication of envelope fields, no secrets and no
 * personal data beyond what the domain needs.
 *
 * WHY THESE PAYLOADS CARRY IDENTIFIERS AND NUMBERS ONLY
 * ----------------------------------------------------
 * AI Core is the one part of the platform that handles prompts, completions and
 * tool arguments — text that routinely contains other people's personal data and
 * occasionally a credential somebody pasted where they should not have. None of
 * it appears in an event. An event states that work happened, what it cost,
 * whether it was allowed and how it ended; the *content* stays in the execution
 * record, which is access-controlled, redaction-aware and retention-bounded in
 * ways a broadcast event stream is not. A payload that carried a completion
 * would turn every subscriber into a copy of the most sensitive store in the
 * system.
 *
 * WHY SOME ENUMERATIONS ARE REDECLARED HERE
 * -----------------------------------------
 * The authoritative vocabularies (`FAILURE_CLASSES`, `STOP_REASONS`,
 * `POLICY_OUTCOMES`, `AGENT_STATES`, ...) live in `@omnis/ai-core-types`. This
 * package must not import them: `@omnis/events` is a contract foundation that
 * Sprint 0 packages already depend on, and making it depend on a domain package
 * would invert that direction and put every future domain vocabulary inside the
 * foundation's dependency graph.
 *
 * The lists below are therefore restated, and each is exported so that
 * `tests/contract/ai-core-events.test.ts` can assert — mechanically, on every
 * run — that the restatement still equals the declaration. Drift is caught by a
 * failing test rather than by a consumer that quietly stops matching events.
 */

import { ERROR_CODE_VALUES } from "@omnis/errors";
import type { JsonObject } from "@omnis/types";
import {
  identifierSchemas,
  isoDateTimeSchema,
  ratioSchema,
  trimmedStringSchema,
  z,
} from "@omnis/validation";

// ---------------------------------------------------------------------------
// Shared vocabularies (restated; see the module comment)
// ---------------------------------------------------------------------------

/** Failure classifications, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_FAILURE_CLASSES = [
  "retryable",
  "non_retryable",
  "policy_blocked",
  "budget_blocked",
  "validation",
  "cancelled",
  "deadline_exceeded",
  "provider_failure",
  "tool_failure",
  "unknown",
] as const;

/** Why a model stopped generating, as `@omnis/ai-core-types` declares it. */
export const AI_EVENT_STOP_REASONS = [
  "stop",
  "length",
  "tool_calls",
  "content_policy",
  "cancelled",
  "error",
] as const;

/** Policy outcomes, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_POLICY_OUTCOMES = ["allow", "constrain", "require_approval", "deny"] as const;

/** Agent lifecycle states, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_AGENT_STATES = [
  "created",
  "ready",
  "planning",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Provider lifecycle statuses, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_PROVIDER_STATUSES = [
  "registered",
  "initializing",
  "ready",
  "degraded",
  "unavailable",
  "disabled",
] as const;

/** Provider health states, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_PROVIDER_HEALTH_STATES = [
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
] as const;

/** Budget dimensions, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_BUDGET_DIMENSIONS = [
  "tokens",
  "requests",
  "model_calls",
  "tool_executions",
  "duration_ms",
  "cost_micro_usd",
] as const;

/** Budget windows, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_BUDGET_WINDOWS = ["execution", "session", "day", "total"] as const;

/** Tool risk levels, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/** Evaluation verdicts, as `@omnis/ai-core-types` declares them. */
export const AI_EVENT_EVALUATION_VERDICTS = ["pass", "warn", "fail"] as const;

/** What refused a tool call. Not declared elsewhere: this is the event's own distinction. */
export const AI_EVENT_TOOL_BLOCKERS = [
  "policy",
  "permission",
  "approval",
  "budget",
  "validation",
] as const;

// ---------------------------------------------------------------------------
// Shared field groups
// ---------------------------------------------------------------------------

const failureClassSchema = z.enum(AI_EVENT_FAILURE_CLASSES);
const stopReasonSchema = z.enum(AI_EVENT_STOP_REASONS);
const durationMsSchema = z.number().int().nonnegative();
const tokensSchema = z.number().int().nonnegative();
/** Integer micro-USD, or `null` when the work is not priced. */
const costMicroUsdSchema = z.number().int().nullable();

/** The classification of a failure, flat, as the Sprint 0 payloads carry it. */
const failureFields = {
  /** Stable OMNIS error code. */
  errorCode: z.enum(ERROR_CODE_VALUES),
  /** Retry classification, which is what a consumer's own retry logic needs. */
  failureClass: failureClassSchema,
  /**
   * A human-readable reason, produced by the platform rather than copied from a
   * provider response.
   *
   * Provider error bodies are not forwarded: they can contain request material,
   * account identifiers and occasionally credentials, and an event is broadcast.
   */
  errorMessage: trimmedStringSchema,
  retryable: z.boolean(),
} as const;

/** What a model call consumed. */
const usageFields = {
  inputTokens: tokensSchema,
  outputTokens: tokensSchema,
  /** As the provider reported it, which is not always the sum of the two. */
  totalTokens: tokensSchema,
  costMicroUsd: costMicroUsdSchema,
} as const;

// ---------------------------------------------------------------------------
// ai.model.*
// ---------------------------------------------------------------------------

/** `ai.model.call.completed` — a model produced a response. */
export const aiModelCallCompletedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  modelId: identifierSchemas.model,
  providerId: identifierSchemas.provider,
  /** How the model was named in the request, e.g. `slug:gpt-class`. Safe to log; never content. */
  modelReference: trimmedStringSchema,
  durationMs: durationMsSchema,
  stopReason: stopReasonSchema,
  streamed: z.boolean(),
  /** Candidate switches the call needed before it was answered. */
  fallbacks: z.number().int().nonnegative(),
  ...usageFields,
});
export type AiModelCallCompletedPayload = z.infer<typeof aiModelCallCompletedPayloadSchema>;

/** `ai.model.call.failed` — no candidate could answer. */
export const aiModelCallFailedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  /** `null` when the call never resolved a model at all. */
  modelId: identifierSchemas.model.nullable(),
  providerId: identifierSchemas.provider.nullable(),
  modelReference: trimmedStringSchema,
  durationMs: durationMsSchema,
  attempts: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  ...failureFields,
});
export type AiModelCallFailedPayload = z.infer<typeof aiModelCallFailedPayloadSchema>;

/** `ai.model.fallback.used` — the call moved to another candidate. */
export const aiModelFallbackUsedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  fromModelId: identifierSchemas.model.nullable(),
  fromProviderId: identifierSchemas.provider.nullable(),
  toModelId: identifierSchemas.model,
  toProviderId: identifierSchemas.provider,
  /** Position in the candidate list the call moved to; 1 is the first fallback. */
  depth: z.number().int().nonnegative(),
  /** Why the previous candidate was passed over. Platform-generated text. */
  reason: trimmedStringSchema,
  /** True when a policy constraint, rather than a failure, caused the move. */
  policyDriven: z.boolean(),
});
export type AiModelFallbackUsedPayload = z.infer<typeof aiModelFallbackUsedPayloadSchema>;

/** `ai.model.retry.scheduled` — another attempt at the same provider was queued. */
export const aiModelRetryScheduledPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  modelId: identifierSchemas.model,
  providerId: identifierSchemas.provider,
  attempt: z.number().int().positive(),
  nextAttempt: z.number().int().positive(),
  /** Fixed, bounded and deterministic: there is no exponential backoff in OMNIS. */
  delayMs: durationMsSchema,
  errorCode: z.enum(ERROR_CODE_VALUES),
  failureClass: failureClassSchema,
});
export type AiModelRetryScheduledPayload = z.infer<typeof aiModelRetryScheduledPayloadSchema>;

/** `ai.model.stream.started` — a streamed response began. */
export const aiModelStreamStartedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  modelId: identifierSchemas.model,
  providerId: identifierSchemas.provider,
});
export type AiModelStreamStartedPayload = z.infer<typeof aiModelStreamStartedPayloadSchema>;

/** `ai.model.stream.completed` — a streamed response reached its terminal event. */
export const aiModelStreamCompletedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  modelId: identifierSchemas.model,
  providerId: identifierSchemas.provider,
  durationMs: durationMsSchema,
  stopReason: stopReasonSchema,
  /** Content chunks delivered. A count, never the content. */
  chunks: z.number().int().nonnegative(),
  ...usageFields,
});
export type AiModelStreamCompletedPayload = z.infer<typeof aiModelStreamCompletedPayloadSchema>;

/** `ai.model.stream.failed` — a stream stopped without completing. */
export const aiModelStreamFailedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  modelId: identifierSchemas.model,
  providerId: identifierSchemas.provider,
  durationMs: durationMsSchema,
  /** Chunks already delivered, which is what makes a retry unsafe. */
  chunksEmitted: z.number().int().nonnegative(),
  /** True when a consumer stopped reading rather than the provider failing. */
  abandoned: z.boolean(),
  ...failureFields,
});
export type AiModelStreamFailedPayload = z.infer<typeof aiModelStreamFailedPayloadSchema>;

// ---------------------------------------------------------------------------
// ai.provider.*
// ---------------------------------------------------------------------------

/** `ai.provider.health.recorded` — one observation folded into provider health. */
export const aiProviderHealthRecordedPayloadSchema = z.object({
  providerId: identifierSchemas.provider,
  observation: z.enum(["success", "failure"]),
  state: z.enum(AI_EVENT_PROVIDER_HEALTH_STATES),
  consecutiveSuccesses: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative().nullable(),
  observedAt: isoDateTimeSchema,
});
export type AiProviderHealthRecordedPayload = z.infer<typeof aiProviderHealthRecordedPayloadSchema>;

/** `ai.provider.status.changed` — a provider moved between lifecycle states. */
export const aiProviderStatusChangedPayloadSchema = z.object({
  providerId: identifierSchemas.provider,
  /** `null` for the first status a provider is given. */
  from: z.enum(AI_EVENT_PROVIDER_STATUSES).nullable(),
  to: z.enum(AI_EVENT_PROVIDER_STATUSES),
  reason: trimmedStringSchema.nullable(),
  changedAt: isoDateTimeSchema,
});
export type AiProviderStatusChangedPayload = z.infer<typeof aiProviderStatusChangedPayloadSchema>;

// ---------------------------------------------------------------------------
// ai.tool.*
// ---------------------------------------------------------------------------

/** `ai.tool.call.completed` — a tool ran and produced a result. */
export const aiToolCallCompletedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  toolId: identifierSchemas.tool,
  agentId: identifierSchemas.agent.nullable(),
  riskLevel: z.enum(AI_EVENT_TOOL_RISK_LEVELS),
  durationMs: durationMsSchema,
  /** Size of the result, not the result. Tool output can carry personal data. */
  outputBytes: z.number().int().nonnegative(),
  /** True when the tool returned an error result rather than throwing. */
  isErrorResult: z.boolean(),
  /** True when an approval was granted for this call. */
  approved: z.boolean(),
});
export type AiToolCallCompletedPayload = z.infer<typeof aiToolCallCompletedPayloadSchema>;

/** `ai.tool.call.failed` — a tool invocation failed. */
export const aiToolCallFailedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  toolId: identifierSchemas.tool,
  agentId: identifierSchemas.agent.nullable(),
  riskLevel: z.enum(AI_EVENT_TOOL_RISK_LEVELS),
  durationMs: durationMsSchema,
  timedOut: z.boolean(),
  ...failureFields,
});
export type AiToolCallFailedPayload = z.infer<typeof aiToolCallFailedPayloadSchema>;

/** `ai.tool.call.blocked` — a tool was refused before it ran. */
export const aiToolCallBlockedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  toolId: identifierSchemas.tool,
  agentId: identifierSchemas.agent.nullable(),
  riskLevel: z.enum(AI_EVENT_TOOL_RISK_LEVELS),
  blockedBy: z.enum(AI_EVENT_TOOL_BLOCKERS),
  policyId: identifierSchemas.policy.nullable(),
  reason: trimmedStringSchema,
});
export type AiToolCallBlockedPayload = z.infer<typeof aiToolCallBlockedPayloadSchema>;

// ---------------------------------------------------------------------------
// ai.agent.*
// ---------------------------------------------------------------------------

/** `ai.agent.state.changed` — an agent instance moved between lifecycle states. */
export const aiAgentStateChangedPayloadSchema = z.object({
  /** `null` while an agent instance exists but no execution has been opened. */
  executionId: identifierSchemas.execution.nullable(),
  agentId: identifierSchemas.agent,
  from: z.enum(AI_EVENT_AGENT_STATES),
  to: z.enum(AI_EVENT_AGENT_STATES),
  /** What the agent is blocked on when `to` is `waiting`. */
  waitingOn: z.enum(["tool_result", "approval", "model_response"]).nullable(),
  reason: trimmedStringSchema.nullable(),
  changedAt: isoDateTimeSchema,
});
export type AiAgentStateChangedPayload = z.infer<typeof aiAgentStateChangedPayloadSchema>;

/** `ai.agent.step.completed` — one step of an agent's plan succeeded. */
export const aiAgentStepCompletedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  agentId: identifierSchemas.agent,
  stepId: trimmedStringSchema,
  stepName: trimmedStringSchema,
  /** The kind of work the step was, e.g. `model` or `tool`. */
  stepKind: trimmedStringSchema,
  attempt: z.number().int().positive(),
  durationMs: durationMsSchema,
  ...usageFields,
});
export type AiAgentStepCompletedPayload = z.infer<typeof aiAgentStepCompletedPayloadSchema>;

/** `ai.agent.step.failed` — one step failed or was skipped. */
export const aiAgentStepFailedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  agentId: identifierSchemas.agent,
  stepId: trimmedStringSchema,
  stepName: trimmedStringSchema,
  stepKind: trimmedStringSchema,
  attempt: z.number().int().positive(),
  durationMs: durationMsSchema,
  /** True when a dependency did not succeed, so the step never ran. */
  skipped: z.boolean(),
  /** True when the plan was allowed to continue past this failure. */
  optional: z.boolean(),
  ...failureFields,
});
export type AiAgentStepFailedPayload = z.infer<typeof aiAgentStepFailedPayloadSchema>;

// ---------------------------------------------------------------------------
// ai.policy.* and ai.budget.*
// ---------------------------------------------------------------------------

/** `ai.policy.decision.recorded` — a policy set was evaluated. */
export const aiPolicyDecisionRecordedPayloadSchema = z.object({
  executionId: identifierSchemas.execution.nullable(),
  policyId: identifierSchemas.policy,
  /** What was gated, e.g. `model:mdl_...` or `tool:tool_...`. */
  subject: trimmedStringSchema,
  outcome: z.enum(AI_EVENT_POLICY_OUTCOMES),
  /** Constraints the decision imposes; their kinds, never their values. */
  constraintKinds: z.array(trimmedStringSchema).default([]),
  /** True when a human approval is needed before the work may proceed. */
  approvalRequired: z.boolean(),
  reason: trimmedStringSchema.nullable(),
  decidedAt: isoDateTimeSchema,
});
export type AiPolicyDecisionRecordedPayload = z.infer<typeof aiPolicyDecisionRecordedPayloadSchema>;

/** `ai.policy.violation.detected` — work contradicted a constraint. */
export const aiPolicyViolationDetectedPayloadSchema = z.object({
  executionId: identifierSchemas.execution.nullable(),
  policyId: identifierSchemas.policy,
  subject: trimmedStringSchema,
  /** Which constraint was contradicted, e.g. `denied_models`. */
  constraintKind: trimmedStringSchema,
  /** True when the work was refused; false when it was clamped to the constraint. */
  refused: z.boolean(),
  detail: trimmedStringSchema.nullable(),
  detectedAt: isoDateTimeSchema,
});
export type AiPolicyViolationDetectedPayload = z.infer<
  typeof aiPolicyViolationDetectedPayloadSchema
>;

/** `ai.budget.reserved` — a hold was taken before expensive work. */
export const aiBudgetReservedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  budgetId: identifierSchemas.budget,
  reservationId: identifierSchemas.reservation,
  window: z.enum(AI_EVENT_BUDGET_WINDOWS),
  /** Dimensions held and their amounts. Amounts are counters, not content. */
  holds: z
    .array(z.object({ dimension: z.enum(AI_EVENT_BUDGET_DIMENSIONS), amount: z.number().int() }))
    .default([]),
  costMicroUsd: costMicroUsdSchema,
  reservedAt: isoDateTimeSchema,
});
export type AiBudgetReservedPayload = z.infer<typeof aiBudgetReservedPayloadSchema>;

/** `ai.budget.committed` — a hold was settled against real consumption. */
export const aiBudgetCommittedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  budgetId: identifierSchemas.budget,
  reservationId: identifierSchemas.reservation,
  ...usageFields,
  committedAt: isoDateTimeSchema,
});
export type AiBudgetCommittedPayload = z.infer<typeof aiBudgetCommittedPayloadSchema>;

/** `ai.budget.released` — a hold was returned because the work did not happen. */
export const aiBudgetReleasedPayloadSchema = z.object({
  executionId: identifierSchemas.execution,
  budgetId: identifierSchemas.budget,
  reservationId: identifierSchemas.reservation,
  reason: trimmedStringSchema,
  releasedAt: isoDateTimeSchema,
});
export type AiBudgetReleasedPayload = z.infer<typeof aiBudgetReleasedPayloadSchema>;

/** `ai.budget.exceeded` — a budget could not cover requested work. */
export const aiBudgetExceededPayloadSchema = z.object({
  executionId: identifierSchemas.execution.nullable(),
  budgetId: identifierSchemas.budget,
  dimension: z.enum(AI_EVENT_BUDGET_DIMENSIONS),
  window: z.enum(AI_EVENT_BUDGET_WINDOWS),
  limit: z.number().int(),
  /** Already charged against the limit. */
  used: z.number().int(),
  /** What the refused work asked for. */
  requested: z.number().int(),
  refusedAt: isoDateTimeSchema,
});
export type AiBudgetExceededPayload = z.infer<typeof aiBudgetExceededPayloadSchema>;

// ---------------------------------------------------------------------------
// ai.evaluation.*
// ---------------------------------------------------------------------------

/** `ai.evaluation.completed` — a deterministic evaluation produced a result. */
export const aiEvaluationCompletedPayloadSchema = z.object({
  evaluationId: identifierSchemas.evaluation,
  executionId: identifierSchemas.execution,
  /** What was evaluated. */
  subject: z.enum(["execution", "model", "tool", "agent"]),
  verdict: z.enum(AI_EVENT_EVALUATION_VERDICTS),
  /** Weighted mean of the dimension scores, `0..1`. */
  overallScore: ratioSchema,
  dimensionsScored: z.number().int().nonnegative(),
  /** Rules that ran, and how many of them reported findings. */
  rulesApplied: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  evaluatedAt: isoDateTimeSchema,
});
export type AiEvaluationCompletedPayload = z.infer<typeof aiEvaluationCompletedPayloadSchema>;

// ---------------------------------------------------------------------------
// Compile-time contract assertion
// ---------------------------------------------------------------------------

type AssertJsonObject<TPayload extends JsonObject> = TPayload;

/**
 * Fails to compile unless every `ai.*` payload is JSON-representable.
 *
 * The same guard `payloads.ts` applies to the Sprint 0 vocabulary: an optional
 * property would widen to `T | undefined`, which disappears under
 * `JSON.stringify` and leaves a consumer unable to tell "omitted" from "none".
 */
export type AiPayloadJsonSafetyAssertion = [
  AssertJsonObject<AiModelCallCompletedPayload>,
  AssertJsonObject<AiModelCallFailedPayload>,
  AssertJsonObject<AiModelFallbackUsedPayload>,
  AssertJsonObject<AiModelRetryScheduledPayload>,
  AssertJsonObject<AiModelStreamStartedPayload>,
  AssertJsonObject<AiModelStreamCompletedPayload>,
  AssertJsonObject<AiModelStreamFailedPayload>,
  AssertJsonObject<AiProviderHealthRecordedPayload>,
  AssertJsonObject<AiProviderStatusChangedPayload>,
  AssertJsonObject<AiToolCallCompletedPayload>,
  AssertJsonObject<AiToolCallFailedPayload>,
  AssertJsonObject<AiToolCallBlockedPayload>,
  AssertJsonObject<AiAgentStateChangedPayload>,
  AssertJsonObject<AiAgentStepCompletedPayload>,
  AssertJsonObject<AiAgentStepFailedPayload>,
  AssertJsonObject<AiPolicyDecisionRecordedPayload>,
  AssertJsonObject<AiPolicyViolationDetectedPayload>,
  AssertJsonObject<AiBudgetReservedPayload>,
  AssertJsonObject<AiBudgetCommittedPayload>,
  AssertJsonObject<AiBudgetReleasedPayload>,
  AssertJsonObject<AiBudgetExceededPayload>,
  AssertJsonObject<AiEvaluationCompletedPayload>,
];
