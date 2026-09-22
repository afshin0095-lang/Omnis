/**
 * AI Core identifiers.
 *
 * Branding is owned by `@omnis/types` — this module re-exports the AI Core subset
 * so that AI Core packages have exactly one import site for identity, and adds the
 * union used by cross-cutting code (audit records, telemetry, event payloads) that
 * has to accept "some AI Core identifier" without caring which kind.
 *
 * Re-exporting rather than re-branding matters: a second `ModelId` brand would be
 * a *different* type to the compiler, and every boundary between the platform and
 * the AI Core would need a cast. Casts at boundaries are where identity bugs hide.
 */

import type {
  AgentId,
  BudgetId,
  CausationId,
  CorrelationId,
  EvaluationId,
  ExecutionId,
  ModelId,
  PlanId,
  PolicyId,
  ProviderId,
  ReservationId,
  SpanId,
  TenantId,
  ToolId,
  TraceId,
} from "@omnis/types";

export type {
  AgentId,
  BudgetId,
  CausationId,
  CorrelationId,
  EvaluationId,
  ExecutionId,
  ModelId,
  PlanId,
  PolicyId,
  ProviderId,
  ReservationId,
  SpanId,
  TenantId,
  ToolId,
  TraceId,
} from "@omnis/types";

export {
  createAgentId,
  createBudgetId,
  createCausationId,
  createCorrelationId,
  createEvaluationId,
  createExecutionId,
  createModelId,
  createPlanId,
  createPolicyId,
  createProviderId,
  createReservationId,
  createToolId,
} from "@omnis/types";

/**
 * Every identifier the AI Core mints or propagates.
 *
 * Used by audit and telemetry surfaces that record "which AI Core entity this
 * touched" without narrowing to one registry.
 */
export type AiCoreIdentifier =
  | AgentId
  | BudgetId
  | EvaluationId
  | ExecutionId
  | ModelId
  | PlanId
  | PolicyId
  | ProviderId
  | ReservationId
  | ToolId;

/**
 * Identity triple propagated through every execution.
 *
 * `executionId` scopes one run, `correlationId` ties together everything caused by
 * one inbound request (so a whole agent/tool/model tree can be retrieved with one
 * query), and `causationId` names the *immediate* cause. Keeping all three on every
 * record is what makes a distributed trace reconstructible later without having
 * stored the call graph.
 */
export interface AiCoreIdentity {
  readonly executionId: ExecutionId;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
  readonly traceId: TraceId | null;
  readonly parentSpanId: SpanId | null;
}

/** Builds an identity from an execution and correlation identifier. */
export function createAiCoreIdentity(
  executionId: ExecutionId,
  correlationId: CorrelationId,
  causationId: CausationId | null = null,
  traceId: TraceId | null = null,
  parentSpanId: SpanId | null = null,
): AiCoreIdentity {
  return Object.freeze({ executionId, correlationId, causationId, traceId, parentSpanId });
}

/** The tenant an execution runs for, when one is known. */
export type AiCoreTenant = TenantId | null;
