/**
 * Building and checking an {@link EvaluationInput}.
 *
 * An evaluation is only as trustworthy as the facts handed to it, so this module has two jobs:
 * turn something the kernel already produced — a result, or a full record — into the flat bag of
 * measured facts the rules read, and refuse a bag that is missing or mistyping one of them.
 *
 * The checks are hand-written rather than a zod schema on purpose. The input carries an
 * arbitrary JSON output and an `ExecutionFailure` whose contract belongs to
 * `@omnis/ai-core-types`; re-declaring that contract here would be a second source of truth
 * that could drift, and drift in a validator means facts get silently dropped. What is checked
 * here is exactly what the rules read, and every problem is reported at once.
 */

import type { JsonValue } from "@omnis/types";
import {
  EMPTY_USAGE,
  POLICY_OUTCOMES,
  isJsonSafe,
  resultFailure,
  totalRecordUsage,
} from "@omnis/ai-core-types";
import type {
  EvaluatedToolResult,
  EvaluationInput,
  ExecutionRecord,
  ExecutionResult,
  ModelId,
  PolicyOutcome,
  ProviderId,
  UsageSummary,
} from "@omnis/ai-core-types";
import { invalidEvaluationInput } from "./errors.js";

/** The most tool results one evaluation reads. */
export const MAX_EVALUATED_TOOL_RESULTS = 256;

/**
 * Facts a result does not carry.
 *
 * An `ExecutionResult` knows what happened and what it cost, but not what was expected, what
 * format was requested, or which policy outcome authorized the work. Those come from the caller
 * that made the request, and an evaluation that guessed them would be grading its own assumptions.
 */
export interface EvaluationInputExtras {
  readonly expected?: JsonValue | null;
  readonly requestedResponseFormat?: string | null;
  readonly schemaName?: string | null;
  readonly outputMatchesRequestedFormat?: boolean;
  readonly modelId?: ModelId | null;
  readonly providerId?: ProviderId | null;
  readonly policyOutcome?: PolicyOutcome | null;
  readonly toolResults?: readonly EvaluatedToolResult[];
}

/** Builds an evaluation input from one execution result. */
export function evaluationInputFromResult(
  result: ExecutionResult,
  extras: EvaluationInputExtras = {},
): EvaluationInput {
  return Object.freeze({
    executionId: result.executionId,
    output: result.status === "succeeded" ? result.output : null,
    expected: extras.expected ?? null,
    requestedResponseFormat: extras.requestedResponseFormat ?? null,
    schemaName: extras.schemaName ?? null,
    outputMatchesRequestedFormat: extras.outputMatchesRequestedFormat ?? false,
    modelId: extras.modelId ?? null,
    providerId: extras.providerId ?? null,
    usage: result.usage,
    latencyMs: result.durationMs,
    policyOutcome: extras.policyOutcome ?? null,
    toolResults: Object.freeze([...(extras.toolResults ?? [])]),
    failure: resultFailure(result),
    cancelled: result.status === "cancelled",
    timedOut: result.status === "timed_out",
  });
}

/**
 * Builds an evaluation input from a durable execution record.
 *
 * Preferred over {@link evaluationInputFromResult} when the record exists: it carries the
 * governance outcome and the accumulated usage across every attempt, including the attempts that
 * failed before the final one. Cost and latency are then measured over the whole execution rather
 * than over its last try, which is what a cost rule has to grade.
 */
export function evaluationInputFromRecord(
  record: ExecutionRecord,
  extras: EvaluationInputExtras = {},
): EvaluationInput {
  const result = record.result;
  const policyOutcome = record.governance.policyOutcome;
  const model = record.request.model;
  return Object.freeze({
    executionId: record.request.id,
    output: result !== null && result.status === "succeeded" ? result.output : null,
    expected: extras.expected ?? null,
    requestedResponseFormat: extras.requestedResponseFormat ?? null,
    schemaName: extras.schemaName ?? null,
    outputMatchesRequestedFormat: extras.outputMatchesRequestedFormat ?? false,
    // Only a reference by identifier names a model; a slug or capability reference is resolved by
    // the orchestrator, which records the model it chose in the attempt.
    modelId: extras.modelId ?? (model !== null && model.kind === "id" ? model.modelId : null),
    providerId: extras.providerId ?? null,
    // Accumulated across every attempt, so a cost rule grades the whole execution and not just
    // the try that happened to succeed.
    usage: totalRecordUsage(record),
    latencyMs: record.governance.durationMs ?? (result === null ? null : result.durationMs),
    policyOutcome: extras.policyOutcome ?? (isPolicyOutcome(policyOutcome) ? policyOutcome : null),
    toolResults: Object.freeze([...(extras.toolResults ?? [])]),
    failure: result === null ? null : resultFailure(result),
    cancelled: record.status === "cancelled" || (result !== null && result.status === "cancelled"),
    timedOut: record.status === "timed_out" || (result !== null && result.status === "timed_out"),
  });
}

/** True when the value is one of the published policy outcomes. */
export function isPolicyOutcome(value: string | null): value is PolicyOutcome {
  return value !== null && (POLICY_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Asserts an evaluation input carries every fact the rules read.
 *
 * Reports all problems at once: a caller fixing one field at a time against a validator that
 * stops at the first error spends far longer than one that lists them.
 */
export function assertEvaluationInput(
  value: unknown,
  label: string = "evaluation input",
): asserts value is EvaluationInput {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null) {
    throw invalidEvaluationInput([`${label} must be an object`]);
  }
  const input = value as Record<string, unknown>;

  if (typeof input["executionId"] !== "string" || input["executionId"].length === 0) {
    issues.push("executionId must be a non-empty string");
  }
  for (const field of ["output", "expected"] as const) {
    const candidate = input[field];
    if (candidate !== null && candidate !== undefined && !isJsonSafe(candidate)) {
      issues.push(`${field} must be JSON-safe or null`);
    }
  }
  for (const field of ["requestedResponseFormat", "schemaName"] as const) {
    if (!isNullableString(input[field])) {
      issues.push(`${field} must be a string or null`);
    }
  }
  for (const field of ["outputMatchesRequestedFormat", "cancelled", "timedOut"] as const) {
    if (typeof input[field] !== "boolean") {
      issues.push(`${field} must be a boolean`);
    }
  }
  for (const field of ["modelId", "providerId"] as const) {
    if (!isNullableString(input[field])) {
      issues.push(`${field} must be an identifier string or null`);
    }
  }
  if (!isUsageSummary(input["usage"])) {
    issues.push("usage must be a UsageSummary or null");
  }
  const latency = input["latencyMs"];
  if (
    latency !== null &&
    (typeof latency !== "number" || !Number.isFinite(latency) || latency < 0)
  ) {
    issues.push("latencyMs must be a non-negative finite number or null");
  }
  const outcome = input["policyOutcome"];
  if (outcome !== null && !isPolicyOutcome(typeof outcome === "string" ? outcome : null)) {
    issues.push(`policyOutcome must be one of ${POLICY_OUTCOMES.join(", ")} or null`);
  }
  const toolResults = input["toolResults"];
  if (!Array.isArray(toolResults)) {
    issues.push("toolResults must be an array");
  } else if (toolResults.length > MAX_EVALUATED_TOOL_RESULTS) {
    issues.push(
      `toolResults declares ${String(toolResults.length)} entries, the maximum is ${String(MAX_EVALUATED_TOOL_RESULTS)}`,
    );
  } else {
    toolResults.forEach((entry, index) => {
      if (!isEvaluatedToolResult(entry)) {
        issues.push(`toolResults[${String(index)}] must be an EvaluatedToolResult`);
      }
    });
  }
  const failure = input["failure"];
  if (failure !== null && !isFailureShape(failure)) {
    issues.push("failure must be an ExecutionFailure or null");
  }

  if (issues.length > 0) {
    throw invalidEvaluationInput(issues);
  }
}

/** True when the value satisfies {@link assertEvaluationInput}. */
export function isEvaluationInput(value: unknown): value is EvaluationInput {
  try {
    assertEvaluationInput(value);
    return true;
  } catch {
    return false;
  }
}

/** A usage summary with no consumption, for callers that measured nothing. */
export function emptyUsage(): UsageSummary {
  return EMPTY_USAGE;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsageSummary(value: unknown): value is UsageSummary | null {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  const usage = value as Record<string, unknown>;
  const counts = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "requests",
  ];
  return (
    counts.every((field) => isNonNegativeNumber(usage[field])) &&
    (usage["costMicro"] === null || isNonNegativeNumber(usage["costMicro"]))
  );
}

function isEvaluatedToolResult(value: unknown): value is EvaluatedToolResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["toolId"] === "string" &&
    typeof entry["name"] === "string" &&
    (entry["status"] === "succeeded" ||
      entry["status"] === "failed" ||
      entry["status"] === "denied") &&
    isNonNegativeNumber(entry["durationMs"]) &&
    isNullableString(entry["errorCode"])
  );
}

function isFailureShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const failure = value as Record<string, unknown>;
  return (
    typeof failure["class"] === "string" &&
    typeof failure["code"] === "string" &&
    typeof failure["message"] === "string" &&
    typeof failure["retryable"] === "boolean"
  );
}
