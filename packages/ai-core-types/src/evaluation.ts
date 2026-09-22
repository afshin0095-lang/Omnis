/**
 * Evaluation contracts.
 *
 * Sprint 1 evaluation is **deterministic rules only**. There is no LLM-as-judge here,
 * and that is a deliberate limitation rather than an unfinished feature: a judge model
 * is non-reproducible, costs money, can be prompted-injected by the very output it is
 * scoring, and cannot be unit-tested. Rules over measured facts — did the output parse,
 * did it satisfy the schema, was policy honored, how long did it take, what did it
 * cost — are testable, free, and cannot be talked into a passing grade.
 *
 * The shapes below are therefore all *data*: a rule spec says what to measure and what
 * threshold to apply; the engine in `@omnis/ai-evaluation` implements the measurement.
 */

import type { JsonValue } from "@omnis/types";
import { MAX_EVALUATION_RULES, type AiCoreMetadata } from "./constants.js";
import type { EvaluationId, ExecutionId, ModelId, ProviderId, ToolId } from "./identifiers.js";
import type { UsageSummary } from "./messages.js";
import type { ExecutionFailure } from "./failures.js";
import type { PolicyOutcome } from "./policy.js";

/** What an evaluation measures. */
export const EVALUATION_DIMENSIONS = [
  "correctness",
  "policy_compliance",
  "schema_validity",
  "quality",
  "latency",
  "cost",
  "tool_correctness",
] as const;

/** One evaluation dimension. */
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

/** True when the value names an evaluation dimension. */
export function isEvaluationDimension(value: string): value is EvaluationDimension {
  return (EVALUATION_DIMENSIONS as readonly string[]).includes(value);
}

/** The overall judgement an evaluation reaches. */
export const EVALUATION_VERDICTS = ["pass", "warn", "fail"] as const;

/** One evaluation verdict. */
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

/** Numeric rank of a verdict. Higher is worse. */
export const EVALUATION_VERDICT_RANK: Readonly<Record<EvaluationVerdict, number>> = Object.freeze({
  pass: 0,
  warn: 1,
  fail: 2,
});

/** The worst of the given verdicts, or `pass` when there are none. */
export function worstVerdict(verdicts: readonly EvaluationVerdict[]): EvaluationVerdict {
  let worst: EvaluationVerdict = "pass";
  for (const verdict of verdicts) {
    if (EVALUATION_VERDICT_RANK[verdict] > EVALUATION_VERDICT_RANK[worst]) {
      worst = verdict;
    }
  }
  return worst;
}

/** Severity of one finding. */
export const FINDING_SEVERITIES = ["info", "warning", "error"] as const;

/** One finding severity. */
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** A single observation produced by a rule. */
export interface EvaluationFinding {
  /** Stable, machine-readable finding code, e.g. `"schema_mismatch"`. */
  readonly code: string;
  readonly message: string;
  readonly severity: FindingSeverity;
  readonly dimension: EvaluationDimension;
  /** JSON-safe supporting data. Never the full model output, which may be large or sensitive. */
  readonly detail: AiCoreMetadata;
}

/** One dimension's score. */
export interface EvaluationScore {
  readonly dimension: EvaluationDimension;
  /** Normalized to `0..1` inclusive, where `1` is best. */
  readonly score: number;
  readonly verdict: EvaluationVerdict;
  /** Weight in the overall score. Non-negative; scores are normalized by total weight. */
  readonly weight: number;
  readonly findings: readonly EvaluationFinding[];
}

/** Clamps a raw measurement into the `0..1` score range. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Derives a verdict from a score and its thresholds.
 *
 * Two thresholds rather than one so that "acceptable but worth looking at" is
 * expressible: a single pass/fail line turns every marginal result into either a false
 * alarm or a missed regression.
 */
export function verdictForScore(
  score: number,
  passThreshold: number,
  warnThreshold: number,
): EvaluationVerdict {
  if (score >= passThreshold) {
    return "pass";
  }
  return score >= warnThreshold ? "warn" : "fail";
}

/** Weighted mean of dimension scores, or `0` when there are none. */
export function weightedOverallScore(scores: readonly EvaluationScore[]): number {
  let totalWeight = 0;
  let weighted = 0;
  for (const score of scores) {
    if (score.weight <= 0) {
      continue;
    }
    totalWeight += score.weight;
    weighted += clampScore(score.score) * score.weight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

/** A rule the engine knows how to apply. Data only — the implementation lives in `@omnis/ai-evaluation`. */
export interface EvaluationRuleSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly dimension: EvaluationDimension;
  readonly weight: number;
  /** Score at or above which the dimension passes. */
  readonly passThreshold: number;
  /** Score at or above which the dimension warns instead of failing. */
  readonly warnThreshold: number;
  /** Rule-specific, JSON-safe parameters, e.g. `{ "maxLatencyMs": 4000 }`. */
  readonly parameters: AiCoreMetadata;
  readonly enabled: boolean;
}

/** Asserts a rule spec's thresholds and weight are coherent. */
export function assertEvaluationRuleSpec(rule: EvaluationRuleSpec): void {
  if (rule.passThreshold < rule.warnThreshold) {
    throw new RangeError(
      `evaluation rule "${rule.id}" has passThreshold ${String(rule.passThreshold)} below warnThreshold ${String(rule.warnThreshold)}`,
    );
  }
  if (rule.weight < 0 || !Number.isFinite(rule.weight)) {
    throw new RangeError(
      `evaluation rule "${rule.id}" weight must be a non-negative finite number`,
    );
  }
  if (
    clampScore(rule.passThreshold) !== rule.passThreshold ||
    clampScore(rule.warnThreshold) !== rule.warnThreshold
  ) {
    throw new RangeError(`evaluation rule "${rule.id}" thresholds must lie within 0..1`);
  }
}

/** Asserts a rule list is within the declared limit. */
export function assertEvaluationRuleCount(rules: readonly EvaluationRuleSpec[]): void {
  if (rules.length > MAX_EVALUATION_RULES) {
    throw new RangeError(
      `evaluation declares ${String(rules.length)} rules, the maximum is ${MAX_EVALUATION_RULES}`,
    );
  }
}

/** One tool result as seen by the `tool_correctness` dimension. */
export interface EvaluatedToolResult {
  readonly toolId: ToolId;
  readonly name: string;
  readonly status: "succeeded" | "failed" | "denied";
  readonly durationMs: number;
  readonly errorCode: string | null;
}

/** Everything an evaluator is allowed to look at. Measured facts, no model access. */
export interface EvaluationInput {
  readonly executionId: ExecutionId;
  /** The execution's final output, or `null` when it produced none. */
  readonly output: JsonValue | null;
  /** What the caller expected, when the caller declared an expectation. */
  readonly expected: JsonValue | null;
  /** The response format the caller requested, e.g. `"json_schema"`. */
  readonly requestedResponseFormat: string | null;
  /** The schema name the structured output was supposed to satisfy. */
  readonly schemaName: string | null;
  /** True when the output parsed as the requested structure. */
  readonly outputMatchesRequestedFormat: boolean;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly usage: UsageSummary | null;
  readonly latencyMs: number | null;
  readonly policyOutcome: PolicyOutcome | null;
  readonly toolResults: readonly EvaluatedToolResult[];
  readonly failure: ExecutionFailure | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

/** The immutable result of one evaluation run. */
export interface EvaluationResult {
  readonly id: EvaluationId;
  readonly executionId: ExecutionId;
  readonly verdict: EvaluationVerdict;
  /** Weighted mean of the dimension scores, in `0..1`. */
  readonly overallScore: number;
  readonly scores: readonly EvaluationScore[];
  /** Identifiers of the rules that were applied, in application order. */
  readonly rulesApplied: readonly string[];
  readonly evaluatedAt: string;
  /** Always `true`: see the module comment on why determinism is the contract. */
  readonly deterministic: true;
  readonly metadata: AiCoreMetadata;
}
