/**
 * Kernel validation and published contracts.
 *
 * Four shapes cross a boundary into or out of the kernel and are therefore schema-validated: the
 * request (from an API caller or another package), the step and the plan (from a planner), and the
 * attempt (written into an audit row and emitted in events).
 *
 * An {@link ExecutionRecord} is *not* schema-validated, and that is a decision rather than an
 * omission: the kernel is the only producer, it builds every record from parts that were each
 * validated on the way in, and a record schema would have to re-declare the request, plan, attempt,
 * result, evaluation and governance contracts it already owns elsewhere. A second declaration of a
 * contract is a contract that can drift.
 *
 * Model and tool references are checked with the type guards published by `@omnis/ai-core-types`
 * rather than re-declared as schemas here, for the same reason: the guard lives next to the union
 * it describes.
 */

import { describeSchema, identifierSchemas, jsonObjectSchema, z } from "@omnis/validation";
import { ERROR_CODE_VALUES } from "@omnis/errors";
import {
  AI_CORE_CONTRACT_VERSION,
  ATTEMPT_STATUSES,
  EXECUTION_KINDS,
  EXECUTION_MODES,
  EXECUTION_PRIORITIES,
  EXECUTION_STATUSES,
  FAILURE_CLASSES,
  MAX_PLAN_STEPS,
  MAX_RETRY_ATTEMPTS,
  MAX_STEP_DEPENDENCIES,
  isModelReference,
  isToolReference,
} from "@omnis/ai-core-types";
import type {
  ExecutionKind,
  ExecutionMode,
  ExecutionPriority,
  ExecutionStatus,
  ModelReference,
  ToolReference,
} from "@omnis/ai-core-types";

/** A non-negative integer, the shape every count and duration in these contracts has. */
const countSchema = z.number().int().min(0);

/** A duration in milliseconds, or `null` when unbounded or unmeasured. */
const durationSchema = z.number().int().min(1).nullable();

/** A model reference, or `null` when the request does not name one. */
export const modelReferenceSchema = z.custom<ModelReference | null>(
  (value) => value === null || value === undefined || isModelReference(value),
  "must be a ModelReference or null",
);

/** A tool reference, or `null` when the request does not name one. */
export const toolReferenceSchema = z.custom<ToolReference | null>(
  (value) => value === null || value === undefined || isToolReference(value),
  "must be a ToolReference or null",
);

/** What one call consumed. */
export const usageSummarySchema = z.strictObject({
  inputTokens: countSchema,
  outputTokens: countSchema,
  totalTokens: countSchema,
  cachedInputTokens: countSchema,
  reasoningTokens: countSchema,
  requests: countSchema,
  /** Integer micro-USD, or `null` when the model is unpriced. */
  costMicro: countSchema.nullable(),
});

/** One classified failure. */
export const executionFailureSchema = z.strictObject({
  class: z.enum(FAILURE_CLASSES),
  code: z.enum(ERROR_CODE_VALUES),
  message: z.string(),
  retryable: z.boolean(),
  retryAfterMs: countSchema.nullable(),
  attempt: z.number().int().min(1),
  stepId: z.string().min(1).nullable(),
  executionId: identifierSchemas.execution.nullable(),
  modelId: identifierSchemas.model.nullable(),
  providerId: identifierSchemas.provider.nullable(),
  toolId: identifierSchemas.tool.nullable(),
  details: jsonObjectSchema,
  occurredAt: z.string().datetime(),
});

/** One execution request. */
export const executionRequestSchema = z.strictObject({
  id: identifierSchemas.execution,
  kind: z.enum(EXECUTION_KINDS),
  correlationId: identifierSchemas.correlation,
  causationId: identifierSchemas.causation.nullable(),
  traceId: identifierSchemas.trace.nullable(),
  tenantId: identifierSchemas.tenant.nullable(),
  parentExecutionId: identifierSchemas.execution.nullable(),
  agentId: identifierSchemas.agent.nullable(),
  model: modelReferenceSchema,
  tool: toolReferenceSchema,
  input: jsonObjectSchema,
  mode: z.enum(EXECUTION_MODES),
  priority: z.enum(EXECUTION_PRIORITIES),
  // A request may name a policy set by identifier or by registered name; the engine resolves it.
  policyId: z.union([identifierSchemas.policy, z.string().min(1)]).nullable(),
  budgetId: identifierSchemas.budget.nullable(),
  deadlineMs: durationSchema,
  metadata: jsonObjectSchema,
  requestedAt: z.string().datetime(),
});

/** One plan step. */
export const executionStepSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(EXECUTION_KINDS),
  dependsOn: z.array(z.string().min(1)).max(MAX_STEP_DEPENDENCIES),
  timeoutMs: durationSchema,
  maxAttempts: z.number().int().min(1).max(MAX_RETRY_ATTEMPTS),
  optional: z.boolean(),
  input: jsonObjectSchema,
  modelId: identifierSchemas.model.nullable(),
  providerId: identifierSchemas.provider.nullable(),
  toolId: identifierSchemas.tool.nullable(),
  metadata: jsonObjectSchema,
});

/** One execution plan. */
export const executionPlanSchema = z.strictObject({
  id: identifierSchemas.plan,
  executionId: identifierSchemas.execution,
  steps: z.array(executionStepSchema).max(MAX_PLAN_STEPS),
  createdAt: z.string().datetime(),
});

/** One attempt at one step. */
export const executionAttemptSchema = z.strictObject({
  stepId: z.string().min(1),
  kind: z.enum(EXECUTION_KINDS),
  attempt: z.number().int().min(1).max(MAX_RETRY_ATTEMPTS),
  status: z.enum(ATTEMPT_STATUSES),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: countSchema.nullable(),
  failure: executionFailureSchema.nullable(),
  usage: usageSummarySchema,
  modelId: identifierSchemas.model.nullable(),
  providerId: identifierSchemas.provider.nullable(),
  toolId: identifierSchemas.tool.nullable(),
  metadata: jsonObjectSchema,
});

/** One lifecycle observation. */
export const executionTimelineEntrySchema = z.strictObject({
  at: z.string().datetime(),
  status: z.enum(EXECUTION_STATUSES),
  note: z.string().nullable(),
  stepId: z.string().min(1).nullable(),
});

/** The execution request contract. */
export const EXECUTION_REQUEST_CONTRACT = describeSchema(
  "ExecutionRequest",
  executionRequestSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The plan step contract. */
export const EXECUTION_STEP_CONTRACT = describeSchema(
  "ExecutionStep",
  executionStepSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The execution plan contract. */
export const EXECUTION_PLAN_CONTRACT = describeSchema(
  "ExecutionPlan",
  executionPlanSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The attempt contract. */
export const EXECUTION_ATTEMPT_CONTRACT = describeSchema(
  "ExecutionAttempt",
  executionAttemptSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The timeline entry contract. */
export const EXECUTION_TIMELINE_CONTRACT = describeSchema(
  "ExecutionTimelineEntry",
  executionTimelineEntrySchema,
  AI_CORE_CONTRACT_VERSION,
);

/** True when the value names an execution kind. */
export function isExecutionKindValue(value: string): value is ExecutionKind {
  return (EXECUTION_KINDS as readonly string[]).includes(value);
}

/** True when the value names an execution status. */
export function isExecutionStatusValue(value: string): value is ExecutionStatus {
  return (EXECUTION_STATUSES as readonly string[]).includes(value);
}

/** True when the value names an execution mode. */
export function isExecutionModeValue(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

/** True when the value names an execution priority. */
export function isExecutionPriorityValue(value: string): value is ExecutionPriority {
  return (EXECUTION_PRIORITIES as readonly string[]).includes(value);
}
