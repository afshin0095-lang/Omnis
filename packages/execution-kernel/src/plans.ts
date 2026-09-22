/**
 * Plan construction.
 *
 * A plan is data, and the kernel accepts one from a caller, from a planner it was given, or builds
 * the trivial one-step plan implied by a request. All three paths end here, which is why every plan
 * the kernel runs has been structurally validated: duplicate step identifiers, dangling
 * dependencies, self-dependencies, cycles and fan-in beyond the contract limit are all rejected
 * before the first step executes, rather than discovered as a hung run.
 *
 * Validation reports every issue at once. A planner that has to fix one problem per round trip
 * will eventually ship a plan it never saw fully rejected.
 */

import { createPlanId } from "@omnis/types";
import type { ExecutionId, JsonObject, PlanId } from "@omnis/types";
import {
  assertJsonSafe,
  MAX_PLAN_STEPS,
  MAX_RETRY_ATTEMPTS,
  MAX_STEP_DEPENDENCIES,
  describeModelReference,
  topologicalStepOrder,
  validateExecutionPlan,
} from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  ExecutionKind,
  ExecutionPlan,
  ExecutionRequest,
  ExecutionStep,
  ModelId,
  PlanIssue,
  ProviderId,
  ToolId,
} from "@omnis/ai-core-types";
import type { Clock } from "@omnis/execution-context";
import { systemClock, toIso } from "@omnis/execution-context";
import { invalidPlanError } from "@omnis/ai-core-types";
import { planRejected } from "./errors.js";

/** The most steps a plan the kernel will run may declare. */
export { MAX_PLAN_STEPS, MAX_RETRY_ATTEMPTS, MAX_STEP_DEPENDENCIES };

/** A step as supplied by a planner. */
export interface ExecutionStepInput {
  readonly id?: string;
  readonly name?: string;
  readonly kind?: ExecutionKind;
  readonly dependsOn?: readonly string[];
  readonly timeoutMs?: number | null;
  readonly maxAttempts?: number;
  readonly optional?: boolean;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly modelId?: ModelId | null;
  readonly providerId?: ProviderId | null;
  readonly toolId?: ToolId | null;
  readonly metadata?: AiCoreMetadata;
}

/** A plan as supplied by a planner. */
export interface ExecutionPlanInput {
  readonly executionId: ExecutionId;
  readonly steps: readonly ExecutionStepInput[];
  readonly id?: PlanId;
  readonly createdAt?: string;
}

/**
 * Builds one frozen step.
 *
 * Attempts are clamped to at least one and at most {@link MAX_RETRY_ATTEMPTS}: an unbounded retry
 * count in a plan is an unbounded cost, and a step that is not allowed a first attempt is a step
 * that can never run.
 */
export function executionStep(input: ExecutionStepInput = {}): ExecutionStep {
  const id = input.id ?? "step-1";
  if (id.length === 0) {
    throw invalidPlanError("step identifier must not be empty");
  }
  const maxAttempts = input.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts)) {
    throw invalidPlanError(
      `step "${id}" declares a non-integer maxAttempts of ${String(maxAttempts)}`,
    );
  }
  const timeoutMs = input.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw invalidPlanError(
      `step "${id}" declares a non-positive timeoutMs of ${String(timeoutMs)}`,
    );
  }
  const dependsOn = Object.freeze([...(input.dependsOn ?? [])]);
  if (dependsOn.length > MAX_STEP_DEPENDENCIES) {
    throw invalidPlanError(
      `step "${id}" declares ${String(dependsOn.length)} dependencies, the maximum is ${String(MAX_STEP_DEPENDENCIES)}`,
    );
  }
  // A step's input and metadata are declared JSON-safe by their types, so they are checked here
  // rather than cast: a plan carrying a function or a circular structure would serialize into
  // something other than what the planner meant, in an audit row nobody can re-run.
  const stepInput: Record<string, unknown> = { ...(input.input ?? {}) };
  assertJsonSafe(stepInput, `step "${id}" input`);
  const stepMetadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  assertJsonSafe(stepMetadata, `step "${id}" metadata`);

  return Object.freeze({
    id,
    name: input.name ?? id,
    kind: input.kind ?? "model",
    dependsOn,
    timeoutMs,
    maxAttempts: Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, maxAttempts)),
    optional: input.optional ?? false,
    input: Object.freeze(stepInput) as Readonly<JsonObject>,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    toolId: input.toolId ?? null,
    metadata: Object.freeze(stepMetadata) as Readonly<JsonObject>,
  });
}

/** Builds one frozen plan, rejecting it when it is not structurally sound. */
export function executionPlan(
  input: ExecutionPlanInput,
  clock: Clock = systemClock,
): ExecutionPlan {
  const plan: ExecutionPlan = Object.freeze({
    id: input.id ?? createPlanId(),
    executionId: input.executionId,
    steps: Object.freeze(input.steps.map((step) => (isStep(step) ? step : executionStep(step)))),
    createdAt: input.createdAt ?? toIso(clock()),
  });
  assertValidPlan(plan);
  return plan;
}

/** Throws {@link planRejected} listing every structural problem in a plan. */
export function assertValidPlan(plan: ExecutionPlan): void {
  const issues = validateExecutionPlan(plan);
  if (issues.length > 0) {
    throw planRejected(issues, plan.executionId);
  }
}

/** The issues in a plan, without throwing. */
export function planIssues(plan: ExecutionPlan): readonly PlanIssue[] {
  return validateExecutionPlan(plan);
}

/**
 * The one-step plan a request implies.
 *
 * A request names a kind and, for that kind, the thing to run: an agent identifier, a model
 * reference or a tool reference. The step carries whichever of those the request supplied, so an
 * executor registered for the kind receives everything it needs and nothing it has to guess.
 */
export function singleStepPlan(
  request: ExecutionRequest,
  clock: Clock = systemClock,
): ExecutionPlan {
  return executionPlan(
    {
      executionId: request.id,
      steps: [stepInputFromRequest(request)],
    },
    clock,
  );
}

/** The step a request implies, as input rather than as a built step. */
export function stepInputFromRequest(request: ExecutionRequest): ExecutionStepInput {
  const model = request.model;
  return {
    id: `${request.kind}-step`,
    name: describeStepName(request),
    kind: request.kind,
    dependsOn: [],
    timeoutMs: request.deadlineMs,
    maxAttempts: 1,
    optional: false,
    input: request.input,
    modelId: model !== null && model.kind === "id" ? model.modelId : null,
    providerId:
      model !== null && model.kind !== "id" && model.providerId !== null ? model.providerId : null,
    toolId: request.tool !== null && request.tool.kind === "id" ? request.tool.toolId : null,
    metadata: Object.freeze({
      ...request.metadata,
      modelReference: model === null ? null : describeModelReference(model),
      toolReference:
        request.tool === null
          ? null
          : request.tool.kind === "id"
            ? request.tool.toolId
            : request.tool.name,
    }),
  };
}

/** A human-readable step name derived from the request. */
export function describeStepName(request: ExecutionRequest): string {
  const model = request.model;
  if (model !== null) {
    return `${request.kind}:${describeModelReference(model)}`;
  }
  if (request.tool !== null) {
    return `${request.kind}:${request.tool.kind === "id" ? request.tool.toolId : request.tool.name}`;
  }
  if (request.agentId !== null) {
    return `${request.kind}:${request.agentId}`;
  }
  return request.kind;
}

/** The steps of a plan in the order the kernel runs them. */
export function runOrder(plan: ExecutionPlan): readonly ExecutionStep[] {
  return topologicalStepOrder(plan);
}

function isStep(value: ExecutionStepInput | ExecutionStep): value is ExecutionStep {
  const candidate = value as Partial<ExecutionStep>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.kind === "string" &&
    Array.isArray(candidate.dependsOn) &&
    typeof candidate.maxAttempts === "number" &&
    typeof candidate.optional === "boolean" &&
    candidate.input !== undefined &&
    "modelId" in candidate &&
    "providerId" in candidate &&
    "toolId" in candidate &&
    candidate.metadata !== undefined &&
    "timeoutMs" in candidate
  );
}
