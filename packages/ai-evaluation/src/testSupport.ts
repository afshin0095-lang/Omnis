/**
 * Test doubles for this package's suites.
 *
 * Evaluation is deterministic, so fixtures are plain data: an input builder with every fact set to
 * a known-good value, and small variations of it. Nothing here sleeps, generates random values or
 * reads the wall clock, because a fixture that did would make the property under test — the same
 * facts always produce the same verdict — untestable.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import { createExecutionId, createToolId } from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import { createExecutionFailure, EMPTY_USAGE } from "@omnis/ai-core-types";
import type {
  EvaluatedToolResult,
  EvaluationInput,
  ExecutionFailure,
  ExecutionResult,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { OmnisErrorCode } from "@omnis/errors";

/** The instant fixtures happen at, in epoch milliseconds. */
export const AT_MS = 1_772_000_000_000;

/** The same instant as an ISO timestamp. */
export const AT = "2026-02-25T06:13:20.000Z";

/** A usage summary with a known cost. */
export function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return Object.freeze({
    ...EMPTY_USAGE,
    inputTokens: 400,
    outputTokens: 600,
    totalTokens: 1_000,
    costMicro: 10_000,
    requests: 1,
    ...overrides,
  });
}

/** An unpriced usage summary. */
export function unpricedUsage(totalTokens = 1_000): UsageSummary {
  return usage({ totalTokens, costMicro: null });
}

/** One tool result. */
export function toolResult(overrides: Partial<EvaluatedToolResult> = {}): EvaluatedToolResult {
  return Object.freeze({
    toolId: createToolId(),
    name: "search_documents",
    status: "succeeded",
    durationMs: 40,
    errorCode: null,
    ...overrides,
  });
}

/** Overrides for {@link evaluationInput}. */
export type EvaluationInputOverrides = Partial<{
  [K in keyof EvaluationInput]: EvaluationInput[K];
}>;

/**
 * An evaluation input where every rule would score a full mark.
 *
 * Starting from a known-good input is what makes a rule test meaningful: changing one fact and
 * watching one score move proves the rule reads that fact, which a fixture assembled per test
 * never does.
 */
export function evaluationInput(overrides: EvaluationInputOverrides = {}): EvaluationInput {
  return Object.freeze({
    executionId: createExecutionId(),
    output: { summary: "Revenue rose 12% quarter over quarter.", rows: 3 },
    expected: null,
    requestedResponseFormat: null,
    schemaName: null,
    outputMatchesRequestedFormat: false,
    modelId: null,
    providerId: null,
    usage: usage(),
    latencyMs: 1_200,
    policyOutcome: "allow",
    toolResults: Object.freeze([]),
    failure: null,
    cancelled: false,
    timedOut: false,
    ...overrides,
  });
}

/** A provider failure with a real class and a real error code. */
export function providerFailure(
  code: OmnisErrorCode = "timeout",
  message = "the provider did not respond in time",
): ExecutionFailure {
  return createExecutionFailure({
    class: "provider_failure",
    code,
    message,
    retryable: true,
    attempt: 2,
    stepId: "step-1",
    occurredAt: AT,
  });
}

/** The succeeded variant of an execution result. */
export type SucceededResult = Extract<ExecutionResult, { status: "succeeded" }>;

/** The failed variant of an execution result. */
export type FailedResult = Extract<ExecutionResult, { status: "failed" }>;

/** The cancelled variant of an execution result. */
export type CancelledResult = Extract<ExecutionResult, { status: "cancelled" }>;

/** The timed-out variant of an execution result. */
export type TimedOutResult = Extract<ExecutionResult, { status: "timed_out" }>;

/** A succeeded execution result, for the input builders. */
export function succeededResult(
  output: JsonValue = { answer: 42 },
  overrides: Partial<SucceededResult> = {},
): SucceededResult {
  return Object.freeze({
    status: "succeeded",
    executionId: createExecutionId(),
    output,
    usage: usage(),
    evaluation: null,
    completedAt: AT,
    durationMs: 1_200,
    metadata: Object.freeze({}),
    ...overrides,
  });
}

/** A failed execution result, for the input builders. */
export function failedResult(
  failure: ExecutionFailure = providerFailure(),
  overrides: Partial<FailedResult> = {},
): FailedResult {
  return Object.freeze({
    status: "failed",
    executionId: createExecutionId(),
    failure,
    usage: usage(),
    evaluation: null,
    completedAt: AT,
    durationMs: 30_000,
    metadata: Object.freeze({}),
    ...overrides,
  });
}

/** A cancelled execution result. */
export function cancelledResult(overrides: Partial<CancelledResult> = {}): CancelledResult {
  return Object.freeze({
    status: "cancelled",
    executionId: createExecutionId(),
    failure: createExecutionFailure({
      class: "cancelled",
      code: "execution_failed",
      message: "the run was cancelled",
      attempt: 1,
      occurredAt: AT,
    }),
    usage: usage(),
    completedAt: AT,
    durationMs: 250,
    metadata: Object.freeze({}),
    ...overrides,
  });
}

/** A timed-out execution result. */
export function timedOutResult(overrides: Partial<TimedOutResult> = {}): TimedOutResult {
  return Object.freeze({
    status: "timed_out",
    executionId: createExecutionId(),
    failure: createExecutionFailure({
      class: "deadline_exceeded",
      code: "timeout",
      message: "the deadline passed",
      attempt: 1,
      occurredAt: AT,
    }),
    usage: usage(),
    completedAt: AT,
    durationMs: 30_000,
    metadata: Object.freeze({}),
    ...overrides,
  });
}
