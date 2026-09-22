/**
 * The `omnis.ai.*` telemetry namespace.
 *
 * AI Core work has dimensions the platform namespace does not: which model, which provider,
 * which tool, which policy decided, which budget was charged, which attempt this was. Naming
 * them here — once — is what lets a trace of an agent run be read as one story instead of five
 * unrelated spans that happen to share a timestamp.
 *
 * TWO RULES, BOTH ENFORCED BY THE TYPES BELOW
 * -------------------------------------------
 * 1. **Identifiers go on spans, never on metrics.** {@link AI_SPAN_ATTRIBUTE_KEYS} contains
 *    ids; {@link AI_METRIC_ATTRIBUTE_KEYS} deliberately does not. A metric label per model id
 *    is a new time series per model, and per execution id it is a new series per request —
 *    which is how a metrics backend is exhausted. {@link assertAiMetricAttributes} exists so a
 *    call site that tries it fails in a test rather than in production.
 * 2. **Values are scalars, and never content.** Prompts, tool arguments, model outputs and
 *    error messages are not telemetry attributes. They belong in the audit record, where they
 *    are access-controlled and retention-bounded; a span attribute is copied into every backend
 *    the platform talks to.
 */

import type { JsonValue } from "@omnis/types";
import type { TelemetryAttributes } from "./metrics.js";

/** Attribute keys for AI Core spans. Identifiers are allowed here and only here. */
export const AI_SPAN_ATTRIBUTE_KEYS = {
  executionId: "omnis.ai.execution.id",
  executionMode: "omnis.ai.execution.mode",
  executionPriority: "omnis.ai.execution.priority",
  executionDepth: "omnis.ai.execution.depth",
  executionStatus: "omnis.ai.execution.status",
  correlationId: "omnis.ai.correlation.id",
  causationId: "omnis.ai.causation.id",
  stepId: "omnis.ai.step.id",
  agentId: "omnis.ai.agent.id",
  agentName: "omnis.ai.agent.name",
  tenantId: "omnis.ai.tenant.id",
  modelId: "omnis.ai.model.id",
  modelSlug: "omnis.ai.model.slug",
  modelKind: "omnis.ai.model.kind",
  providerId: "omnis.ai.provider.id",
  providerSlug: "omnis.ai.provider.slug",
  toolId: "omnis.ai.tool.id",
  toolName: "omnis.ai.tool.name",
  toolVersion: "omnis.ai.tool.version",
  toolKind: "omnis.ai.tool.kind",
  toolRiskLevel: "omnis.ai.tool.risk_level",
  policyId: "omnis.ai.policy.id",
  policyName: "omnis.ai.policy.name",
  policyVersion: "omnis.ai.policy.version",
  policyOutcome: "omnis.ai.policy.outcome",
  policyRuleId: "omnis.ai.policy.rule_id",
  budgetId: "omnis.ai.budget.id",
  reservationId: "omnis.ai.reservation.id",
  budgetDimension: "omnis.ai.budget.dimension",
  evaluationId: "omnis.ai.evaluation.id",
  evaluationScore: "omnis.ai.evaluation.score",
  attempt: "omnis.ai.attempt",
  status: "omnis.ai.status",
  outcome: "omnis.ai.outcome",
  failureClass: "omnis.ai.failure.class",
  failureCode: "omnis.ai.failure.code",
  retryable: "omnis.ai.retryable",
  durationMs: "omnis.ai.duration.ms",
  latencyMs: "omnis.ai.latency.ms",
  inputTokens: "omnis.ai.usage.input_tokens",
  outputTokens: "omnis.ai.usage.output_tokens",
  totalTokens: "omnis.ai.usage.total_tokens",
  cachedInputTokens: "omnis.ai.usage.cached_input_tokens",
  requests: "omnis.ai.usage.requests",
  costMicroUsd: "omnis.ai.usage.cost_micro_usd",
  streamed: "omnis.ai.streamed",
  fallbackDepth: "omnis.ai.fallback.depth",
  cancelled: "omnis.ai.cancelled",
  timedOut: "omnis.ai.timed_out",
} as const;

/** One AI Core span attribute name. */
export type AiSpanAttributeKey =
  (typeof AI_SPAN_ATTRIBUTE_KEYS)[keyof typeof AI_SPAN_ATTRIBUTE_KEYS];

/**
 * Attribute keys safe to use as AI Core **metric** labels.
 *
 * Bounded vocabulary only: kinds, levels, outcomes and statuses. No identifier appears here,
 * and adding one requires deciding what bounds its cardinality.
 */
export const AI_METRIC_ATTRIBUTE_KEYS = {
  executionMode: "omnis.ai.execution.mode",
  executionStatus: "omnis.ai.execution.status",
  modelKind: "omnis.ai.model.kind",
  toolKind: "omnis.ai.tool.kind",
  toolRiskLevel: "omnis.ai.tool.risk_level",
  policyOutcome: "omnis.ai.policy.outcome",
  budgetDimension: "omnis.ai.budget.dimension",
  status: "omnis.ai.status",
  outcome: "omnis.ai.outcome",
  failureClass: "omnis.ai.failure.class",
  retryable: "omnis.ai.retryable",
  streamed: "omnis.ai.streamed",
  cancelled: "omnis.ai.cancelled",
  timedOut: "omnis.ai.timed_out",
} as const;

/** One AI Core metric attribute name. */
export type AiMetricAttributeKey =
  (typeof AI_METRIC_ATTRIBUTE_KEYS)[keyof typeof AI_METRIC_ATTRIBUTE_KEYS];

/** Values a caller may supply, keyed by the short name rather than the wire name. */
export type AiSpanAttributeValues = Partial<
  Record<keyof typeof AI_SPAN_ATTRIBUTE_KEYS, JsonValue | null | undefined>
>;

/** Values a caller may supply for a metric. */
export type AiMetricAttributeValues = Partial<
  Record<keyof typeof AI_METRIC_ATTRIBUTE_KEYS, JsonValue | null | undefined>
>;

/**
 * Builds span attributes from named values.
 *
 * `null` and `undefined` are dropped rather than rendered: an absent model id should not
 * appear as the string `"null"` in a trace backend, where it becomes a value somebody
 * eventually groups by. Objects and arrays are rejected, because a scalar-only rule that is
 * enforced by convention is not enforced.
 */
export function aiSpanAttributes(values: AiSpanAttributeValues): TelemetryAttributes {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) {
      continue;
    }
    const key = AI_SPAN_ATTRIBUTE_KEYS[name as keyof typeof AI_SPAN_ATTRIBUTE_KEYS];
    if (key === undefined) {
      throw new RangeError(`unknown AI Core span attribute "${name}"`);
    }
    attributes[key] = scalarAttribute(key, value);
  }
  return Object.freeze(attributes);
}

/** Builds metric labels from named values, and refuses anything unbounded. */
export function aiMetricAttributes(values: AiMetricAttributeValues): TelemetryAttributes {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) {
      continue;
    }
    const key = AI_METRIC_ATTRIBUTE_KEYS[name as keyof typeof AI_METRIC_ATTRIBUTE_KEYS];
    if (key === undefined) {
      throw new RangeError(
        `"${name}" is not a bounded AI Core metric attribute; identifiers belong on spans`,
      );
    }
    attributes[key] = scalarAttribute(key, value);
  }
  return Object.freeze(attributes);
}

/**
 * Asserts a set of metric labels contains no identifier.
 *
 * Usable as a guard in a test or at a composition root over labels built elsewhere.
 */
export function assertAiMetricAttributes(attributes: TelemetryAttributes): void {
  const allowed = new Set<string>(Object.values(AI_METRIC_ATTRIBUTE_KEYS));
  for (const key of Object.keys(attributes)) {
    if (!allowed.has(key)) {
      throw new RangeError(
        `metric attribute "${key}" is not in the bounded AI Core metric vocabulary`,
      );
    }
  }
}

/** True when the key is part of the AI Core namespace. */
export function isAiAttributeKey(key: string): boolean {
  return key.startsWith("omnis.ai.");
}

/** Renders one value as a scalar attribute. */
function scalarAttribute(key: string, value: JsonValue): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    // A non-finite number cannot be indexed by a backend and would serialize as null.
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new RangeError(
        `AI Core attribute "${key}" must be a finite number, received ${String(value)}`,
      );
    }
    return value;
  }
  throw new RangeError(
    `AI Core attribute "${key}" must be a string, number or boolean; content and objects are not telemetry`,
  );
}
