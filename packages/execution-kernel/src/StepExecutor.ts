/**
 * The step executor contract, and the outcomes it returns.
 *
 * The kernel runs plans. It does not know how to call a model, invoke a tool or evaluate anything,
 * and it must not learn: a kernel that imported a provider client would be a kernel that could not
 * be tested without a network, and could not be reused for a kind of work nobody had thought of
 * yet. So each step kind is executed by a registered {@link StepExecutor}, supplied by the layer
 * that does know — the model orchestrator, the tool runtime, the agent runtime.
 *
 * An executor returns an outcome rather than throwing. It *may* throw, and the kernel converts
 * that into a classified failure, but the returned shape is the contract: it carries the status,
 * the output, the usage to charge and the failure to record, which is everything the kernel needs
 * to build an attempt row without guessing.
 */

import { EMPTY_USAGE, failureFromError } from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  AttemptStatus,
  ExecutionApproval,
  ExecutionFailure,
  ExecutionId,
  ExecutionKind,
  ExecutionStep,
  FailureContext,
  ModelId,
  ProviderId,
  ToolId,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { CorrelationId, JsonValue, SpanId, TenantId, TraceId } from "@omnis/types";
import { deadlineIso } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import type { ExecutionScope } from "@omnis/execution-context";

/** Everything an executor is told about the step it is running. */
export interface StepEnvironment {
  readonly executionId: ExecutionId;
  /** The step being run. Also on the `step` argument; repeated here so an executor that logs the
   * environment alone still says which step it was. */
  readonly stepId: string;
  readonly correlationId: CorrelationId;
  readonly traceId: TraceId | null;
  readonly tenantId: TenantId | null;
  /** The span this step reports under, when the kernel opened one. */
  readonly parentSpanId: SpanId | null;
  /** 1-based attempt number. */
  readonly attempt: number;
  /** How many attempts this step is allowed in total. */
  readonly maxAttempts: number;
  readonly startedAt: string;
  /** Absolute deadline for this step, or `null` when only the execution bounds it. */
  readonly deadlineAt: string | null;
  /** The step's own child scope context: identity inherited, deadline bounded, cancellation linked. */
  readonly context: ExecutionContext;
  /** Milliseconds left on this step's deadline, or `null` when unbounded. */
  remainingMs(): number | null;
  /** True when the execution or this step has been asked to stop. */
  isCancelled(): boolean;
  /** Why, when {@link isCancelled} is true. */
  cancellationReason(): string | null;
  /**
   * The approval this execution was granted, or `null` when it was not.
   *
   * A step that calls a model or a tool goes through a runtime with its own approval gate.
   * Without this field an approved execution could never satisfy it: the human said yes to
   * the run, and the run had no way to say so downstream.
   */
  readonly approval: ExecutionApproval | null;
}

/** What one attempt at one step produced. */
export interface StepOutcome {
  readonly status: AttemptStatus;
  readonly output: JsonValue | null;
  readonly usage: UsageSummary;
  readonly failure: ExecutionFailure | null;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly toolId: ToolId | null;
  readonly metadata: AiCoreMetadata;
}

/** The fields of an outcome a caller may set; the rest default to "nothing happened". */
export type StepOutcomeInput = Partial<Omit<StepOutcome, "status">> & {
  readonly status: AttemptStatus;
};

/** Builds a frozen outcome, filling in the facts an executor did not report. */
export function stepOutcome(input: StepOutcomeInput): StepOutcome {
  return Object.freeze({
    status: input.status,
    output: input.output ?? null,
    usage: input.usage ?? EMPTY_USAGE,
    failure: input.failure ?? null,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    toolId: input.toolId ?? null,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

/** A succeeded outcome carrying an output. */
export function succeededOutcome(
  output: JsonValue | null = null,
  usage: UsageSummary = EMPTY_USAGE,
  metadata: AiCoreMetadata = {},
): StepOutcome {
  return stepOutcome({ status: "succeeded", output, usage, metadata });
}

/** A failed outcome carrying a classified failure. */
export function failedOutcome(
  failure: ExecutionFailure,
  usage: UsageSummary = EMPTY_USAGE,
  metadata: AiCoreMetadata = {},
): StepOutcome {
  return stepOutcome({ status: "failed", failure, usage, metadata });
}

/** A failed outcome built from whatever an executor threw. */
export function outcomeFromError(
  error: unknown,
  context: FailureContext = {},
  usage: UsageSummary = EMPTY_USAGE,
): StepOutcome {
  return failedOutcome(failureFromError(error, context), usage);
}

/** A skipped outcome: the step never ran because a dependency did not succeed. */
export function skippedOutcome(reason: string): StepOutcome {
  return stepOutcome({ status: "skipped", metadata: Object.freeze({ skippedReason: reason }) });
}

/** A cancelled outcome. */
export function cancelledOutcome(reason: string): StepOutcome {
  return stepOutcome({
    status: "cancelled",
    failure: failureFromError(new Error(reason), {}),
    metadata: Object.freeze({ cancellationReason: reason }),
  });
}

/** True when the outcome means the step did its work. */
export function isSuccessfulOutcome(outcome: StepOutcome): boolean {
  return outcome.status === "succeeded";
}

/**
 * True when another attempt is worth making.
 *
 * Three conditions, all of them necessary: the attempt failed, the failure is classified as
 * retryable, and attempts remain. A step that declares `maxAttempts: 3` is not promising three
 * tries no matter what — a non-retryable failure, a cancellation and a deadline are all final on
 * the first attempt, because retrying them spends budget to reach the same answer.
 */
export function shouldRetry(outcome: StepOutcome, attempt: number, maxAttempts: number): boolean {
  if (outcome.status !== "failed" || outcome.failure === null) {
    return false;
  }
  if (!outcome.failure.retryable) {
    return false;
  }
  return attempt < maxAttempts;
}

/**
 * How long to wait before the next attempt.
 *
 * The failure's own `retryAfterMs` wins when it carries one — that is a provider telling us when
 * to come back. Otherwise the kernel's fixed retry delay applies. There is no exponential backoff
 * here: a delay that grows with the attempt number is only safe when it is bounded, deterministic
 * and tested, and an unbounded one turns a failing provider into a run that outlives its deadline.
 */
export function retryDelayMs(
  failure: ExecutionFailure | null,
  fallbackMs: number,
  maximumMs: number,
): number {
  const requested = failure?.retryAfterMs ?? fallbackMs;
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(requested), Math.max(0, Math.trunc(maximumMs)));
}

/** Runs one kind of step. */
export interface StepExecutor {
  /** The step kind this executor handles. One executor per kind. */
  readonly kind: ExecutionKind;
  execute(step: ExecutionStep, environment: StepEnvironment): StepOutcome | Promise<StepOutcome>;
}

/** Builds an executor from a kind and a function. */
export function stepExecutor(
  kind: ExecutionKind,
  execute: (
    step: ExecutionStep,
    environment: StepEnvironment,
  ) => StepOutcome | Promise<StepOutcome>,
): StepExecutor {
  return Object.freeze({ kind, execute });
}

/** Builds the environment an executor receives, from the step's own scope. */
/** The facts about the run a step belongs to, which its own scope cannot supply. */
export interface StepEnvironmentIdentity {
  /**
   * The execution the step is part of.
   *
   * A step runs inside a child scope, and a child scope mints its own identifier. That
   * identifier names no execution anybody created, requested or recorded, so reporting it
   * would send executors, failures and telemetry after a record that does not exist. The
   * scope's own identifier stays reachable through `context` for anyone who needs it.
   */
  readonly executionId?: ExecutionId | null;
  /** The approval the execution was granted, when it was. */
  readonly approval?: ExecutionApproval | null;
}

export function stepEnvironment(
  scope: ExecutionScope,
  step: ExecutionStep,
  attempt: number,
  maxAttempts: number,
  identity: StepEnvironmentIdentity = {},
): StepEnvironment {
  const context = scope.context;
  return Object.freeze({
    executionId: identity.executionId ?? context.executionId,
    stepId: step.id,
    correlationId: context.correlationId,
    traceId: context.traceId,
    tenantId: context.tenantId,
    parentSpanId: context.parentSpanId,
    attempt,
    maxAttempts,
    startedAt: context.startedAt,
    deadlineAt: context.deadline === null ? null : deadlineIso(context.deadline),
    context,
    remainingMs: () => scope.remainingMs(),
    isCancelled: () => scope.cancelled,
    cancellationReason: () => scope.cancellationReason,
    approval: identity.approval ?? null,
  });
}
