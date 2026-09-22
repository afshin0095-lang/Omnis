/**
 * Execution results, attempts and the durable execution record.
 *
 * `ExecutionResult` is a discriminated union rather than an object with an optional
 * `error` field, because "succeeded but with an error attached" is a state a consumer
 * will eventually believe. Success carries an output; every non-success carries a
 * classified {@link ExecutionFailure}. There is no fourth shape.
 *
 * `ExecutionRecord` is what an audit query reads: the request, the plan that was
 * actually run, every attempt with its own failure and usage, the governance outcomes,
 * the evaluation, and a timeline. It is assembled immutably as the execution advances
 * so a record observed mid-flight is still a coherent snapshot rather than a mutable
 * object being written to underneath the reader.
 */

import type { JsonObject, JsonValue } from "@omnis/types";
import type { AiCoreMetadata } from "./constants.js";
import type {
  BudgetId,
  ExecutionId,
  ModelId,
  PolicyId,
  ProviderId,
  ToolId,
} from "./identifiers.js";
import type {
  ExecutionKind,
  ExecutionMetadata,
  ExecutionPlan,
  ExecutionRequest,
  ExecutionStatus,
} from "./execution.js";
import { isTerminalExecutionStatus } from "./execution.js";
import type { ExecutionFailure } from "./failures.js";
import type { UsageSummary } from "./messages.js";
import { EMPTY_USAGE, addUsage } from "./messages.js";
import type { EvaluationResult } from "./evaluation.js";
import type { PolicyOutcome } from "./policy.js";
import type { ReservationState } from "./budget.js";

/** What happened to one attempt at one step. */
export const ATTEMPT_STATUSES = [
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "timed_out",
] as const;

/** One attempt status. */
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** An immutable record of one attempt at one step. */
export interface ExecutionAttempt {
  readonly stepId: string;
  readonly kind: ExecutionKind;
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly failure: ExecutionFailure | null;
  readonly usage: UsageSummary;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly toolId: ToolId | null;
  readonly metadata: AiCoreMetadata;
}

/** The final result of an execution. */
export type ExecutionResult =
  | {
      readonly status: "succeeded";
      readonly executionId: ExecutionId;
      /** JSON-safe output. `null` is a legitimate output for work that only had side effects. */
      readonly output: JsonValue | null;
      readonly usage: UsageSummary;
      readonly evaluation: EvaluationResult | null;
      readonly completedAt: string;
      readonly durationMs: number;
      readonly metadata: AiCoreMetadata;
    }
  | {
      readonly status: "failed";
      readonly executionId: ExecutionId;
      readonly failure: ExecutionFailure;
      readonly usage: UsageSummary;
      readonly evaluation: EvaluationResult | null;
      readonly completedAt: string;
      readonly durationMs: number;
      readonly metadata: AiCoreMetadata;
    }
  | {
      readonly status: "cancelled";
      readonly executionId: ExecutionId;
      readonly failure: ExecutionFailure;
      readonly usage: UsageSummary;
      readonly completedAt: string;
      readonly durationMs: number;
      readonly metadata: AiCoreMetadata;
    }
  | {
      readonly status: "timed_out";
      readonly executionId: ExecutionId;
      readonly failure: ExecutionFailure;
      readonly usage: UsageSummary;
      readonly completedAt: string;
      readonly durationMs: number;
      readonly metadata: AiCoreMetadata;
    };

/** The statuses an {@link ExecutionResult} can carry. */
export const RESULT_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

/** One result status. */
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** True when the result represents work that produced a usable output. */
export function isSuccessfulResult(
  result: ExecutionResult,
): result is Extract<ExecutionResult, { status: "succeeded" }> {
  return result.status === "succeeded";
}

/** The failure attached to a non-success result, or `null` for a success. */
export function resultFailure(result: ExecutionResult): ExecutionFailure | null {
  return result.status === "succeeded" ? null : result.failure;
}

/** Maps a result status onto the execution status it terminates in. */
export function executionStatusForResult(status: ResultStatus): ExecutionStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
  }
}

/** One lifecycle observation, in the order it happened. */
export interface ExecutionTimelineEntry {
  readonly at: string;
  readonly status: ExecutionStatus;
  /** Short, secret-safe note, e.g. `"policy denied by rule prod-deny-write"`. */
  readonly note: string | null;
  readonly stepId: string | null;
}

/** The durable, immutable record of one execution. */
export interface ExecutionRecord {
  readonly request: ExecutionRequest;
  readonly status: ExecutionStatus;
  readonly plan: ExecutionPlan | null;
  readonly attempts: readonly ExecutionAttempt[];
  readonly result: ExecutionResult | null;
  readonly governance: ExecutionMetadata;
  readonly timeline: readonly ExecutionTimelineEntry[];
  readonly evaluation: EvaluationResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** True when the record's execution can no longer change. */
export function isExecutionRecordTerminal(record: ExecutionRecord): boolean {
  return isTerminalExecutionStatus(record.status);
}

/**
 * Total usage across every attempt of a record.
 *
 * Accumulation starts from the first attempt rather than from {@link EMPTY_USAGE},
 * because `EMPTY_USAGE.costMicro` is `null` — "unpriced" — and seeding the fold with it
 * would make every total unpriced, even when all attempts reported a cost. A total is
 * unpriced only when at least one attempt was, which is what {@link addUsage} already
 * implements.
 */
export function totalRecordUsage(record: ExecutionRecord): UsageSummary {
  const [first, ...rest] = record.attempts;
  if (first === undefined) {
    return EMPTY_USAGE;
  }
  return rest.reduce<UsageSummary>((total, attempt) => addUsage(total, attempt.usage), first.usage);
}

/** Attempts for one step, in attempt order. */
export function attemptsForStep(
  record: ExecutionRecord,
  stepId: string,
): readonly ExecutionAttempt[] {
  return Object.freeze(record.attempts.filter((attempt) => attempt.stepId === stepId));
}

/** The number of attempts consumed by a record. */
export function recordAttemptCount(record: ExecutionRecord): number {
  return record.attempts.length;
}

/**
 * A JSON-safe summary of a record, shaped for event payloads and telemetry.
 *
 * Deliberately excludes message content, tool arguments and provider details: those
 * belong to the audit store, not to an event bus that many subscribers can read.
 */
export function summarizeExecutionRecord(record: ExecutionRecord): JsonObject {
  const failure = record.result === null ? null : resultFailure(record.result);
  const summary: JsonObject = {
    executionId: record.request.id,
    correlationId: record.request.correlationId,
    kind: record.request.kind,
    mode: record.request.mode,
    priority: record.request.priority,
    status: record.status,
    stepCount: record.plan === null ? 0 : record.plan.steps.length,
    attemptCount: record.attempts.length,
    durationMs: record.governance.durationMs,
    policyOutcome: record.governance.policyOutcome,
    budgetStatus: record.governance.budgetStatus,
    evaluationVerdict: record.evaluation === null ? null : record.evaluation.verdict,
    evaluationId: record.evaluation === null ? null : record.evaluation.id,
    failureClass: failure === null ? null : failure.class,
    failureCode: failure === null ? null : failure.code,
    retryable: failure === null ? null : failure.retryable,
  };
  return Object.freeze(summary);
}

/** The governance facts an execution accumulates as it passes its gates. */
export interface ExecutionOutcomeInput {
  readonly policyId: PolicyId | null;
  readonly policyOutcome: PolicyOutcome | null;
  readonly budgetId: BudgetId | null;
  readonly reservationState: ReservationState | null;
}

/**
 * Returns governance metadata with the policy and budget outcomes recorded.
 *
 * Non-destructive: the kernel advances an execution by producing a new metadata record
 * at each gate, so a snapshot taken before authorization still reads as it did then.
 * Mutating in place would retroactively rewrite what an observer saw.
 */
export function withGovernanceOutcome(
  metadata: ExecutionMetadata,
  outcome: ExecutionOutcomeInput,
): ExecutionMetadata {
  return Object.freeze({
    ...metadata,
    policyId: outcome.policyId ?? metadata.policyId,
    policyOutcome: outcome.policyOutcome ?? metadata.policyOutcome,
    budgetId: outcome.budgetId ?? metadata.budgetId,
    budgetStatus: outcome.reservationState ?? metadata.budgetStatus,
  });
}

/** Returns governance metadata with timing and attempt facts recorded. */
export function withExecutionTiming(
  metadata: ExecutionMetadata,
  timing: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
    readonly attemptCount: number;
  },
): ExecutionMetadata {
  return Object.freeze({
    ...metadata,
    startedAt: timing.startedAt,
    finishedAt: timing.finishedAt,
    durationMs: timing.durationMs,
    attemptCount: timing.attemptCount,
  });
}
