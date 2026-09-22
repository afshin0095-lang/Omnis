/**
 * The rules the evaluator knows how to apply.
 *
 * Every rule here measures a fact the kernel already recorded — did the execution finish, does
 * the output match the expectation, did it satisfy the requested format, how long did it take,
 * what did it cost, what did policy decide, how did the tools do. None of them calls a model.
 * That is the whole design: a rule that asked another model for an opinion would be
 * non-reproducible, would cost money to run, could be persuaded by the output it was grading,
 * and could not be unit-tested.
 *
 * A rule is data plus an implementation. The spec says which implementation to use
 * (`parameters.rule`), how much its dimension counts (`weight`), and where the pass and warn
 * lines sit; the implementation turns measured facts into a raw score in `0..1` and a list of
 * findings. Registration validates the pairing, so a spec that names an implementation which
 * measures a different dimension is rejected before it can silently produce a score nobody can
 * explain.
 */

import { z } from "@omnis/validation";
import { toValidationIssues } from "@omnis/validation";
import { assertEvaluationRuleSpec, clampScore } from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  EvaluationDimension,
  EvaluationFinding,
  EvaluationInput,
  EvaluationRuleSpec,
  FindingSeverity,
} from "@omnis/ai-core-types";
import { invalidRule, invalidRuleParameters, unknownRuleImplementation } from "./errors.js";
import {
  jsonEquals,
  kindOfJson,
  leafPaths,
  readJsonPath,
  renderedLength,
  stableJson,
} from "./jsonFacts.js";

/** The most findings one rule reports. The score carries the rest. */
export const MAX_FINDINGS_PER_RULE = 8;

/** The rule implementations this engine ships with. */
export const EVALUATION_RULE_KEYS = [
  "completion",
  "expected_output",
  "output_schema",
  "output_shape",
  "latency",
  "cost",
  "policy_compliance",
  "tool_outcomes",
] as const;

/** One rule implementation key. */
export type EvaluationRuleKey = (typeof EVALUATION_RULE_KEYS)[number];

/** What one rule measured: a raw score and the observations behind it. */
export interface RuleMeasurement {
  /** Raw score in `0..1` before thresholds are applied. Clamped by the engine. */
  readonly score: number;
  readonly findings: readonly EvaluationFinding[];
}

/** One rule implementation. */
export interface EvaluationRuleImplementation {
  readonly key: EvaluationRuleKey;
  /** The dimension this implementation measures. A spec must declare the same one. */
  readonly dimension: EvaluationDimension;
  readonly description: string;
  readonly defaultParameters: AiCoreMetadata;
  readonly defaultWeight: number;
  readonly defaultPassThreshold: number;
  readonly defaultWarnThreshold: number;
  /** Returns human-readable problems with a parameter bag, or an empty list when it is usable. */
  validateParameters(parameters: AiCoreMetadata): readonly string[];
  measure(input: EvaluationInput, spec: EvaluationRuleSpec): RuleMeasurement;
}

/** Builds one finding. */
export function finding(
  code: string,
  message: string,
  severity: FindingSeverity,
  dimension: EvaluationDimension,
  detail: AiCoreMetadata = {},
): EvaluationFinding {
  return Object.freeze({
    code,
    message,
    severity,
    dimension,
    detail: Object.freeze({ ...detail }),
  });
}

/** Builds one measurement. */
export function measurement(
  score: number,
  findings: readonly EvaluationFinding[],
): RuleMeasurement {
  return Object.freeze({ score: clampScore(score), findings: Object.freeze([...findings]) });
}

// ---------------------------------------------------------------------------
// Parameter schemas
//
// Each is strict: an unknown parameter is a typo, and a typo in a threshold is a rule that
// grades against a number nobody chose.
// ---------------------------------------------------------------------------

/** Parameters for the `completion` rule. It measures what happened, so it needs no knobs. */
export const completionRuleParametersSchema = z.strictObject({ rule: z.literal("completion") });

/** Parameters for the `expected_output` rule. */
export const expectedOutputRuleParametersSchema = z.strictObject({
  rule: z.literal("expected_output"),
  /** `subset` scores the fraction of expected facts present; `exact` requires structural equality. */
  match: z.enum(["subset", "exact"]).default("subset"),
  /** Top-level expectation keys that are not graded, e.g. a timestamp the caller cannot predict. */
  ignoreKeys: z.array(z.string().min(1)).max(32).default([]),
});

/** Parameters for the `output_schema` rule. */
export const outputSchemaRuleParametersSchema = z.strictObject({
  rule: z.literal("output_schema"),
});

/** Parameters for the `output_shape` rule. */
export const outputShapeRuleParametersSchema = z.strictObject({
  rule: z.literal("output_shape"),
  minCharacters: z.number().int().min(0).max(1_000_000).default(1),
  /** `null` disables the upper bound. */
  maxCharacters: z.number().int().min(1).max(10_000_000).nullable().default(null),
  /** Case-insensitive substrings that indicate an unfinished or templated answer. */
  forbiddenSubstrings: z
    .array(z.string().min(1))
    .max(32)
    .default(["lorem ipsum", "<placeholder>", "as an ai language model"]),
});

/** Parameters for the `latency` rule. */
export const latencyRuleParametersSchema = z
  .strictObject({
    rule: z.literal("latency"),
    warnMs: z.number().int().min(0).max(600_000).default(4_000),
    maxMs: z.number().int().min(1).max(600_000).default(30_000),
  })
  .refine((parameters) => parameters.warnMs < parameters.maxMs, {
    message: "warnMs must be less than maxMs",
    path: ["warnMs"],
  });

/** Parameters for the `cost` rule. Money is graded when it is known, tokens when it is not. */
export const costRuleParametersSchema = z
  .strictObject({
    rule: z.literal("cost"),
    warnMicroUsd: z.number().int().min(0).max(1_000_000_000).default(50_000),
    maxMicroUsd: z.number().int().min(1).max(1_000_000_000).default(500_000),
    warnTokens: z.number().int().min(0).max(100_000_000).default(4_000),
    maxTokens: z.number().int().min(1).max(100_000_000).default(32_000),
  })
  .refine(
    (parameters) =>
      parameters.warnMicroUsd < parameters.maxMicroUsd &&
      parameters.warnTokens < parameters.maxTokens,
    {
      message: "warn thresholds must be below their maximums",
      path: ["warnMicroUsd"],
    },
  );

/** Parameters for the `policy_compliance` rule. */
export const policyComplianceRuleParametersSchema = z.strictObject({
  rule: z.literal("policy_compliance"),
  /** Score for an execution that ran under a `constrain` outcome. */
  constrainScore: z.number().min(0).max(1).default(0.6),
  /** Score for an execution that ran only because a human approved it. */
  approvalScore: z.number().min(0).max(1).default(0.85),
  /** Score for an execution policy denied. */
  denyScore: z.number().min(0).max(1).default(0),
});

/** Parameters for the `tool_outcomes` rule. */
export const toolOutcomesRuleParametersSchema = z.strictObject({
  rule: z.literal("tool_outcomes"),
  /** `null` disables the slowness observation. */
  maxDurationMs: z.number().int().min(1).max(600_000).nullable().default(null),
  /** Whether a governance denial counts against the tool score. */
  deniedCountsAsFailure: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/** Interpolates a measured quantity against a warn line and a hard maximum. */
export function budgetScore(value: number, warnAt: number, maxAt: number): number {
  if (value <= warnAt) {
    return 1;
  }
  if (maxAt <= warnAt || value >= maxAt) {
    return 0;
  }
  return clampScore((maxAt - value) / (maxAt - warnAt));
}

function parameterIssues(
  schema: { safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } } },
  parameters: AiCoreMetadata,
): readonly string[] {
  const result = schema.safeParse(parameters);
  if (result.success) {
    return [];
  }
  return toValidationIssues(result.error as never).map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path}: ${issue.message}`,
  );
}

function numberParameter(spec: EvaluationRuleSpec, key: string, fallback: number): number {
  const value = spec.parameters[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidRuleParameters(spec.id, [`${key} must be a finite number`]);
  }
  return value;
}

function nullableNumberParameter(spec: EvaluationRuleSpec, key: string): number | null {
  const value = spec.parameters[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidRuleParameters(spec.id, [`${key} must be a finite number or null`]);
  }
  return value;
}

function booleanParameter(spec: EvaluationRuleSpec, key: string, fallback: boolean): boolean {
  const value = spec.parameters[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw invalidRuleParameters(spec.id, [`${key} must be a boolean`]);
  }
  return value;
}

function stringParameter(spec: EvaluationRuleSpec, key: string, fallback: string): string {
  const value = spec.parameters[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw invalidRuleParameters(spec.id, [`${key} must be a string`]);
  }
  return value;
}

function stringListParameter(
  spec: EvaluationRuleSpec,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const value = spec.parameters[key];
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidRuleParameters(spec.id, [`${key} must be an array of strings`]);
  }
  return value as readonly string[];
}

/** Caps a finding list, recording in the last entry how many were dropped. */
function cappedFindings(
  dimension: EvaluationDimension,
  findings: readonly EvaluationFinding[],
): readonly EvaluationFinding[] {
  if (findings.length <= MAX_FINDINGS_PER_RULE) {
    return findings;
  }
  const shown = findings.slice(0, MAX_FINDINGS_PER_RULE);
  return [
    ...shown,
    finding(
      "findings_truncated",
      `${String(findings.length - shown.length)} further findings were not reported`,
      "info",
      dimension,
      { reported: shown.length, total: findings.length },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

const completionRule: EvaluationRuleImplementation = {
  key: "completion",
  dimension: "correctness",
  description: "Scores whether the execution reached a successful terminal state.",
  defaultParameters: Object.freeze({ rule: "completion" }),
  defaultWeight: 3,
  defaultPassThreshold: 1,
  defaultWarnThreshold: 1,
  validateParameters: (parameters) => parameterIssues(completionRuleParametersSchema, parameters),
  measure(input, spec) {
    const findings: EvaluationFinding[] = [];
    let score = 1;
    if (input.failure !== null) {
      score = 0;
      findings.push(
        finding(
          "execution_failed",
          `execution failed: ${input.failure.message}`,
          "error",
          spec.dimension,
          {
            failureClass: input.failure.class,
            failureCode: input.failure.code,
            retryable: input.failure.retryable,
            attempt: input.failure.attempt,
          },
        ),
      );
    }
    if (input.cancelled) {
      score = 0;
      findings.push(
        finding(
          "execution_cancelled",
          "the execution was cancelled before it finished",
          "error",
          spec.dimension,
          {},
        ),
      );
    }
    if (input.timedOut) {
      score = 0;
      findings.push(
        finding(
          "execution_timed_out",
          "the execution exceeded its deadline",
          "error",
          spec.dimension,
          {},
        ),
      );
    }
    if (score === 1) {
      findings.push(
        finding(
          "execution_completed",
          "the execution reached a successful terminal state",
          "info",
          spec.dimension,
          {},
        ),
      );
    }
    return measurement(score, findings);
  },
};

const expectedOutputRule: EvaluationRuleImplementation = {
  key: "expected_output",
  dimension: "correctness",
  description: "Scores the output against the caller's declared expectation.",
  defaultParameters: Object.freeze({ rule: "expected_output", match: "subset", ignoreKeys: [] }),
  defaultWeight: 2,
  defaultPassThreshold: 1,
  defaultWarnThreshold: 0.6,
  validateParameters: (parameters) =>
    parameterIssues(expectedOutputRuleParametersSchema, parameters),
  measure(input, spec) {
    if (input.expected === null || input.expected === undefined) {
      // Nothing was expected, so nothing can be wrong. The finding records that the dimension
      // was not really measured: a green score that came from an absent expectation should not
      // read the same as one that came from a correct answer.
      return measurement(1, [
        finding(
          "no_expectation_declared",
          "no expected output was declared, so correctness was not measured",
          "info",
          spec.dimension,
          {},
        ),
      ]);
    }

    const match = stringParameter(spec, "match", "subset");
    if (match === "exact") {
      const equal = jsonEquals(input.output, input.expected);
      return equal
        ? measurement(1, [
            finding(
              "expectation_matched",
              "the output equals the expectation",
              "info",
              spec.dimension,
              { match },
            ),
          ])
        : measurement(0, [
            finding(
              "expectation_mismatch",
              "the output does not equal the expectation",
              "error",
              spec.dimension,
              {
                match,
                expectedKind: kindOfJson(input.expected),
                outputKind: kindOfJson(input.output),
              },
            ),
          ]);
    }

    const ignoreKeys = new Set(stringListParameter(spec, "ignoreKeys", []));
    const paths = leafPaths(input.expected).filter((path) => {
      const root = path.split(".")[0] ?? "";
      return !ignoreKeys.has(root);
    });
    if (paths.length === 0) {
      return measurement(1, [
        finding(
          "expectation_empty",
          "the declared expectation graded nothing",
          "info",
          spec.dimension,
          { match, ignoredKeys: [...ignoreKeys] },
        ),
      ]);
    }

    const mismatches: EvaluationFinding[] = [];
    let matched = 0;
    for (const path of paths) {
      const expectedValue = readJsonPath(input.expected, path);
      const actualValue = readJsonPath(input.output, path);
      if (jsonEquals(actualValue, expectedValue)) {
        matched += 1;
        continue;
      }
      mismatches.push(
        finding(
          actualValue === undefined ? "expected_field_missing" : "expected_field_mismatch",
          `expected ${path} to match`,
          "error",
          spec.dimension,
          {
            path,
            expectedKind: kindOfJson(expectedValue),
            actualKind: kindOfJson(actualValue),
          },
        ),
      );
    }

    const score = matched / paths.length;
    if (mismatches.length === 0) {
      return measurement(1, [
        finding(
          "expectation_satisfied",
          `all ${String(paths.length)} expected facts were present and equal`,
          "info",
          spec.dimension,
          { match, paths: paths.length },
        ),
      ]);
    }
    return measurement(score, cappedFindings(spec.dimension, mismatches));
  },
};

const outputSchemaRule: EvaluationRuleImplementation = {
  key: "output_schema",
  dimension: "schema_validity",
  description: "Scores whether the output satisfied the response format the caller requested.",
  defaultParameters: Object.freeze({ rule: "output_schema" }),
  defaultWeight: 2,
  defaultPassThreshold: 1,
  defaultWarnThreshold: 1,
  validateParameters: (parameters) => parameterIssues(outputSchemaRuleParametersSchema, parameters),
  measure(input, spec) {
    if (input.requestedResponseFormat === null) {
      return measurement(1, [
        finding(
          "no_format_requested",
          "no response format was requested, so schema validity was not measured",
          "info",
          spec.dimension,
          {},
        ),
      ]);
    }
    if (input.outputMatchesRequestedFormat) {
      return measurement(1, [
        finding(
          "format_satisfied",
          `the output satisfied the requested ${input.requestedResponseFormat} format`,
          "info",
          spec.dimension,
          {
            format: input.requestedResponseFormat,
            schemaName: input.schemaName,
          },
        ),
      ]);
    }
    return measurement(0, [
      finding(
        "schema_mismatch",
        `the output did not satisfy the requested ${input.requestedResponseFormat} format`,
        "error",
        spec.dimension,
        {
          format: input.requestedResponseFormat,
          schemaName: input.schemaName,
          outputKind: kindOfJson(input.output),
        },
      ),
    ]);
  },
};

const outputShapeRule: EvaluationRuleImplementation = {
  key: "output_shape",
  dimension: "quality",
  description: "Scores the output's presence, length and freedom from unfinished-template markers.",
  defaultParameters: Object.freeze({
    rule: "output_shape",
    minCharacters: 1,
    maxCharacters: null,
    forbiddenSubstrings: ["lorem ipsum", "<placeholder>", "as an ai language model"],
  }),
  defaultWeight: 1,
  defaultPassThreshold: 0.8,
  defaultWarnThreshold: 0.5,
  validateParameters: (parameters) => parameterIssues(outputShapeRuleParametersSchema, parameters),
  measure(input, spec) {
    const minCharacters = numberParameter(spec, "minCharacters", 1);
    const maxCharacters = nullableNumberParameter(spec, "maxCharacters");
    const forbidden = stringListParameter(spec, "forbiddenSubstrings", []);
    const length = renderedLength(input.output);
    const findings: EvaluationFinding[] = [];
    let score = 1;

    if (input.output === null || length === 0) {
      return measurement(0, [
        finding("empty_output", "the execution produced no output text", "error", spec.dimension, {
          requestedFormat: input.requestedResponseFormat,
        }),
      ]);
    }
    if (length < minCharacters) {
      score = minCharacters === 0 ? 1 : clampScore(length / minCharacters);
      findings.push(
        finding(
          "output_too_short",
          `output is ${String(length)} characters, at least ${String(minCharacters)} were expected`,
          "warning",
          spec.dimension,
          {
            characters: length,
            minCharacters,
          },
        ),
      );
    }
    if (maxCharacters !== null && length > maxCharacters) {
      score = Math.min(score, clampScore(maxCharacters / length));
      findings.push(
        finding(
          "output_too_long",
          `output is ${String(length)} characters, at most ${String(maxCharacters)} were expected`,
          "warning",
          spec.dimension,
          {
            characters: length,
            maxCharacters,
          },
        ),
      );
    }

    // Case-insensitive: a model that emits "Lorem Ipsum" has not avoided the check, and a marker
    // list that only matched one casing would be a rule that quietly stopped working.
    const text = (
      typeof input.output === "string" ? input.output : stableJson(input.output)
    ).toLowerCase();
    const hits = forbidden.filter((marker) => text.includes(marker.toLowerCase()));
    if (hits.length > 0) {
      score = Math.min(score, clampScore(1 - 0.25 * hits.length));
      findings.push(
        finding(
          "forbidden_substring",
          `output contains ${String(hits.length)} unfinished-template marker(s)`,
          "error",
          spec.dimension,
          {
            markers: hits,
          },
        ),
      );
    }
    if (findings.length === 0) {
      findings.push(
        finding(
          "output_shape_ok",
          `output is ${String(length)} characters with no template markers`,
          "info",
          spec.dimension,
          { characters: length },
        ),
      );
    }
    return measurement(score, findings);
  },
};

const latencyRule: EvaluationRuleImplementation = {
  key: "latency",
  dimension: "latency",
  description: "Scores wall-clock duration against a warn line and a hard maximum.",
  defaultParameters: Object.freeze({ rule: "latency", warnMs: 4_000, maxMs: 30_000 }),
  defaultWeight: 1,
  defaultPassThreshold: 0.8,
  defaultWarnThreshold: 0.4,
  validateParameters: (parameters) => parameterIssues(latencyRuleParametersSchema, parameters),
  measure(input, spec) {
    if (input.latencyMs === null) {
      return measurement(1, [
        finding(
          "latency_not_measured",
          "no duration was recorded, so latency was not graded",
          "info",
          spec.dimension,
          {},
        ),
      ]);
    }
    const warnMs = numberParameter(spec, "warnMs", 4_000);
    const maxMs = numberParameter(spec, "maxMs", 30_000);
    const score = budgetScore(input.latencyMs, warnMs, maxMs);
    const severity: FindingSeverity = score === 1 ? "info" : score === 0 ? "error" : "warning";
    const code =
      score === 1
        ? "latency_within_budget"
        : score === 0
          ? "latency_above_maximum"
          : "latency_above_warn";
    return measurement(score, [
      finding(
        code,
        `execution took ${String(Math.round(input.latencyMs))}ms against a ${String(warnMs)}ms warn line and a ${String(maxMs)}ms maximum`,
        severity,
        spec.dimension,
        {
          latencyMs: Math.round(input.latencyMs),
          warnMs,
          maxMs,
        },
      ),
    ]);
  },
};

const costRule: EvaluationRuleImplementation = {
  key: "cost",
  dimension: "cost",
  description:
    "Scores spend against a warn line and a hard maximum, in money when priced and in tokens when not.",
  defaultParameters: Object.freeze({
    rule: "cost",
    warnMicroUsd: 50_000,
    maxMicroUsd: 500_000,
    warnTokens: 4_000,
    maxTokens: 32_000,
  }),
  defaultWeight: 1,
  defaultPassThreshold: 0.8,
  defaultWarnThreshold: 0.4,
  validateParameters: (parameters) => parameterIssues(costRuleParametersSchema, parameters),
  measure(input, spec) {
    const usage = input.usage;
    if (usage === null) {
      return measurement(1, [
        finding(
          "usage_not_measured",
          "no usage was recorded, so cost was not graded",
          "info",
          spec.dimension,
          {},
        ),
      ]);
    }
    if (usage.costMicro !== null) {
      const warn = numberParameter(spec, "warnMicroUsd", 50_000);
      const max = numberParameter(spec, "maxMicroUsd", 500_000);
      const score = budgetScore(usage.costMicro, warn, max);
      return measurement(score, [
        finding(
          score === 1
            ? "cost_within_budget"
            : score === 0
              ? "cost_above_maximum"
              : "cost_above_warn",
          `execution cost ${String(usage.costMicro)} micro-USD against a ${String(warn)} warn line and a ${String(max)} maximum`,
          score === 1 ? "info" : score === 0 ? "error" : "warning",
          spec.dimension,
          {
            costMicro: usage.costMicro,
            warnMicroUsd: warn,
            maxMicroUsd: max,
            totalTokens: usage.totalTokens,
          },
        ),
      ]);
    }
    // Unpriced work is still bounded work: tokens are the only available measure, and grading
    // nothing would let an unpriced model spend without limit.
    const warnTokens = numberParameter(spec, "warnTokens", 4_000);
    const maxTokens = numberParameter(spec, "maxTokens", 32_000);
    const score = budgetScore(usage.totalTokens, warnTokens, maxTokens);
    return measurement(score, [
      finding(
        score === 1
          ? "tokens_within_budget"
          : score === 0
            ? "tokens_above_maximum"
            : "tokens_above_warn",
        `execution used ${String(usage.totalTokens)} tokens against a ${String(warnTokens)} warn line and a ${String(maxTokens)} maximum; the model is unpriced`,
        score === 1 ? "info" : score === 0 ? "error" : "warning",
        spec.dimension,
        { totalTokens: usage.totalTokens, warnTokens, maxTokens, priced: false },
      ),
    ]);
  },
};

const policyComplianceRule: EvaluationRuleImplementation = {
  key: "policy_compliance",
  dimension: "policy_compliance",
  description: "Scores the policy outcome that authorized the execution.",
  defaultParameters: Object.freeze({
    rule: "policy_compliance",
    constrainScore: 0.6,
    approvalScore: 0.85,
    denyScore: 0,
  }),
  defaultWeight: 2,
  defaultPassThreshold: 0.9,
  defaultWarnThreshold: 0.6,
  validateParameters: (parameters) =>
    parameterIssues(policyComplianceRuleParametersSchema, parameters),
  measure(input, spec) {
    if (input.policyOutcome === null) {
      return measurement(1, [
        finding(
          "policy_not_evaluated",
          "no policy was evaluated for this execution",
          "info",
          spec.dimension,
          {},
        ),
      ]);
    }
    const outcome = input.policyOutcome;
    if (outcome === "allow") {
      return measurement(1, [
        finding(
          "policy_allowed",
          "policy allowed the execution unconditionally",
          "info",
          spec.dimension,
          { outcome },
        ),
      ]);
    }
    if (outcome === "constrain") {
      const score = numberParameter(spec, "constrainScore", 0.6);
      return measurement(score, [
        finding(
          "policy_constrained",
          "the execution ran under policy constraints",
          "warning",
          spec.dimension,
          { outcome, score },
        ),
      ]);
    }
    if (outcome === "require_approval") {
      const score = numberParameter(spec, "approvalScore", 0.85);
      return measurement(score, [
        finding(
          "policy_required_approval",
          "the execution ran because a human approved it",
          "info",
          spec.dimension,
          { outcome, score },
        ),
      ]);
    }
    const score = numberParameter(spec, "denyScore", 0);
    return measurement(score, [
      finding("policy_denied", "policy denied this execution", "error", spec.dimension, {
        outcome,
        score,
      }),
    ]);
  },
};

const toolOutcomesRule: EvaluationRuleImplementation = {
  key: "tool_outcomes",
  dimension: "tool_correctness",
  description: "Scores the fraction of tool invocations that succeeded.",
  defaultParameters: Object.freeze({
    rule: "tool_outcomes",
    maxDurationMs: null,
    deniedCountsAsFailure: true,
  }),
  defaultWeight: 2,
  defaultPassThreshold: 1,
  defaultWarnThreshold: 0.5,
  validateParameters: (parameters) => parameterIssues(toolOutcomesRuleParametersSchema, parameters),
  measure(input, spec) {
    if (input.toolResults.length === 0) {
      return measurement(1, [
        finding("no_tools_invoked", "the execution invoked no tools", "info", spec.dimension, {}),
      ]);
    }
    const deniedCountsAsFailure = booleanParameter(spec, "deniedCountsAsFailure", true);
    const maxDurationMs = nullableNumberParameter(spec, "maxDurationMs");
    const graded = deniedCountsAsFailure
      ? input.toolResults
      : input.toolResults.filter((entry) => entry.status !== "denied");
    if (graded.length === 0) {
      return measurement(1, [
        finding(
          "tools_not_graded",
          "every tool invocation was denied by governance, which the rule is configured not to grade",
          "info",
          spec.dimension,
          {
            denied: input.toolResults.length,
          },
        ),
      ]);
    }

    const findings: EvaluationFinding[] = [];
    let succeeded = 0;
    for (const entry of graded) {
      if (entry.status === "succeeded") {
        succeeded += 1;
        continue;
      }
      findings.push(
        finding(
          entry.status === "failed" ? "tool_failed" : "tool_denied",
          `tool "${entry.name}" ${entry.status}${entry.errorCode === null ? "" : ` with code ${entry.errorCode}`}`,
          entry.status === "failed" ? "error" : "warning",
          spec.dimension,
          {
            toolId: entry.toolId,
            name: entry.name,
            errorCode: entry.errorCode,
            durationMs: entry.durationMs,
          },
        ),
      );
    }
    for (const entry of input.toolResults) {
      if (maxDurationMs !== null && entry.durationMs > maxDurationMs) {
        // An observation, not a score change: a slow tool that returned the right answer is a
        // latency problem, and the latency dimension is where that belongs.
        findings.push(
          finding(
            "tool_slow",
            `tool "${entry.name}" took ${String(entry.durationMs)}ms, above the ${String(maxDurationMs)}ms observation line`,
            "info",
            spec.dimension,
            {
              toolId: entry.toolId,
              name: entry.name,
              durationMs: entry.durationMs,
              maxDurationMs,
            },
          ),
        );
      }
    }

    const score = succeeded / graded.length;
    if (findings.length === 0) {
      findings.push(
        finding(
          "tools_succeeded",
          `all ${String(graded.length)} graded tool invocations succeeded`,
          "info",
          spec.dimension,
          { tools: graded.length, succeeded },
        ),
      );
    }
    return measurement(score, cappedFindings(spec.dimension, findings));
  },
};

/** Every implementation, keyed by the value a spec puts in `parameters.rule`. */
export const BUILT_IN_EVALUATION_RULES: Readonly<
  Record<EvaluationRuleKey, EvaluationRuleImplementation>
> = Object.freeze({
  completion: completionRule,
  expected_output: expectedOutputRule,
  output_schema: outputSchemaRule,
  output_shape: outputShapeRule,
  latency: latencyRule,
  cost: costRule,
  policy_compliance: policyComplianceRule,
  tool_outcomes: toolOutcomesRule,
});

/** Returns the implementation for a key, or `null` when the engine does not have one. */
export function ruleImplementation(key: string): EvaluationRuleImplementation | null {
  return (
    (
      BUILT_IN_EVALUATION_RULES as Readonly<
        Record<string, EvaluationRuleImplementation | undefined>
      >
    )[key] ?? null
  );
}

/** True when the value names a rule implementation. */
export function isEvaluationRuleKey(value: string): value is EvaluationRuleKey {
  return (EVALUATION_RULE_KEYS as readonly string[]).includes(value);
}

/**
 * Resolves and validates the implementation a spec asks for.
 *
 * Three things can be wrong, and all three are configuration errors rather than evaluation
 * results: the key is missing or unknown, the spec's dimension disagrees with what the
 * implementation measures, or the parameters do not satisfy the implementation's schema. All are
 * thrown here, at registration, so a rule set that cannot be applied is never stored.
 */
export function requireRuleImplementation(spec: EvaluationRuleSpec): EvaluationRuleImplementation {
  assertEvaluationRuleSpec(spec);
  const key = spec.parameters["rule"];
  if (typeof key !== "string" || !isEvaluationRuleKey(key)) {
    throw unknownRuleImplementation(spec.id, String(key), EVALUATION_RULE_KEYS);
  }
  const implementation = BUILT_IN_EVALUATION_RULES[key];
  if (implementation.dimension !== spec.dimension) {
    throw invalidRule(
      spec.id,
      `declares dimension "${spec.dimension}" but implementation "${key}" measures "${implementation.dimension}"`,
    );
  }
  const issues = implementation.validateParameters(spec.parameters);
  if (issues.length > 0) {
    throw invalidRuleParameters(spec.id, issues);
  }
  return implementation;
}

/** Overrides accepted when building a spec from an implementation's defaults. */
export interface RuleSpecOverrides {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly weight?: number;
  readonly passThreshold?: number;
  readonly warnThreshold?: number;
  readonly parameters?: AiCoreMetadata;
  readonly enabled?: boolean;
}

/**
 * Builds a rule spec from an implementation's defaults.
 *
 * Parameters are merged, not replaced, so tightening one threshold does not require restating the
 * rest — and cannot accidentally drop a bound the implementation relies on.
 */
export function ruleSpecFor(
  key: EvaluationRuleKey,
  overrides: RuleSpecOverrides = {},
): EvaluationRuleSpec {
  const implementation = BUILT_IN_EVALUATION_RULES[key];
  const spec: EvaluationRuleSpec = Object.freeze({
    id: overrides.id ?? implementation.key,
    name: overrides.name ?? implementation.key.replaceAll("_", " "),
    description: overrides.description ?? implementation.description,
    dimension: implementation.dimension,
    weight: overrides.weight ?? implementation.defaultWeight,
    passThreshold: overrides.passThreshold ?? implementation.defaultPassThreshold,
    warnThreshold: overrides.warnThreshold ?? implementation.defaultWarnThreshold,
    parameters: Object.freeze({
      ...implementation.defaultParameters,
      ...(overrides.parameters ?? {}),
    }),
    enabled: overrides.enabled ?? true,
  });
  requireRuleImplementation(spec);
  return spec;
}

/** The eight default rules, one per implementation, with the shipped weights and thresholds. */
export const DEFAULT_EVALUATION_RULES: readonly EvaluationRuleSpec[] = Object.freeze(
  EVALUATION_RULE_KEYS.map((key) => ruleSpecFor(key)),
);
