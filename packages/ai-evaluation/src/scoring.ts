/**
 * Turning rule measurements into scores.
 *
 * This module is pure: the same input and the same specs always produce the same scores, with no
 * clock, no identifiers and no I/O. That is what makes an evaluation result reproducible enough to
 * be compared across runs, and what makes it testable without standing anything up.
 *
 * Rules are applied in the order they are given, then grouped by dimension. Grouping matters
 * because a caller may attach two latency rules — one for the happy path, one for a strict tier —
 * and the result has to say something about *latency*, not about whichever rule happened to run
 * last.
 */

import {
  EVALUATION_DIMENSIONS,
  assertEvaluationRuleCount,
  clampScore,
  verdictForScore,
  weightedOverallScore,
  worstVerdict,
} from "@omnis/ai-core-types";
import type {
  EvaluationDimension,
  EvaluationFinding,
  EvaluationInput,
  EvaluationRuleSpec,
  EvaluationScore,
  EvaluationVerdict,
  FindingSeverity,
} from "@omnis/ai-core-types";
import { isOmnisError } from "@omnis/errors";
import { duplicateRuleId } from "./errors.js";
import { finding, measurement, requireRuleImplementation } from "./EvaluationRules.js";
import type { RuleMeasurement } from "./EvaluationRules.js";

/** What one pass over a rule list produced. */
export interface EvaluationOutcome {
  readonly scores: readonly EvaluationScore[];
  /** Identifiers of the rules that were applied, in application order. */
  readonly rulesApplied: readonly string[];
  readonly verdict: EvaluationVerdict;
  /** Weighted mean of the dimension scores, in `0..1`. */
  readonly overallScore: number;
}

/**
 * Applies one rule and returns its provisional score.
 *
 * A rule that throws is recorded as a failed measurement rather than allowed to abort the
 * evaluation. A broken rule is a configuration fault, and the honest report of it is "this
 * dimension scored zero because its rule could not run" — not an exception that hides every other
 * dimension's result.
 */
export function applyRule(input: EvaluationInput, spec: EvaluationRuleSpec): EvaluationScore {
  const implementation = requireRuleImplementation(spec);
  let measured: RuleMeasurement;
  let ruleFailed = false;
  try {
    measured = implementation.measure(input, spec);
  } catch (error) {
    ruleFailed = true;
    measured = measurement(0, [
      finding(
        "rule_error",
        `rule "${spec.id}" could not be applied: ${isOmnisError(error) ? error.message : String(error)}`,
        "error",
        spec.dimension,
        {
          rule: spec.id,
          implementation: implementation.key,
          code: isOmnisError(error) ? error.code : "unknown",
        },
      ),
    ]);
  }

  const score = clampScore(measured.score);
  return Object.freeze({
    dimension: spec.dimension,
    score,
    // A rule that could not run never passes, whatever thresholds it declared.
    verdict: ruleFailed ? "fail" : verdictForScore(score, spec.passThreshold, spec.warnThreshold),
    weight: spec.weight,
    findings: Object.freeze([...measured.findings]),
  });
}

/** Severity order: an error is read before a warning, a warning before an observation. */
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = Object.freeze({
  error: 0,
  warning: 1,
  info: 2,
});

/**
 * Orders findings so the result document does not depend on the order rules were listed.
 *
 * Two callers evaluating the same execution with the same rules in a different order must get
 * byte-identical results, or a stored result cannot be compared against a fresh one. Sorting by
 * severity, then code, then message also puts the observations worth reading first.
 */
export function orderFindings(
  findings: readonly EvaluationFinding[],
): readonly EvaluationFinding[] {
  return Object.freeze(
    [...findings].sort(
      (left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message),
    ),
  );
}

/**
 * Groups provisional scores by dimension.
 *
 * Dimensions appear in the published {@link EVALUATION_DIMENSIONS} order, not in the order the
 * rules ran, so two evaluations of the same input produce byte-identical result documents.
 */
export function aggregateByDimension(
  provisional: readonly EvaluationScore[],
): readonly EvaluationScore[] {
  const grouped = new Map<EvaluationDimension, EvaluationScore[]>();
  for (const score of provisional) {
    const existing = grouped.get(score.dimension);
    if (existing === undefined) {
      grouped.set(score.dimension, [score]);
      continue;
    }
    existing.push(score);
  }

  const aggregated: EvaluationScore[] = [];
  for (const dimension of EVALUATION_DIMENSIONS) {
    const members = grouped.get(dimension);
    if (members === undefined || members.length === 0) {
      continue;
    }
    const totalWeight = members.reduce(
      (sum, member) => sum + (member.weight > 0 ? member.weight : 0),
      0,
    );
    const score =
      totalWeight === 0
        ? members.reduce((sum, member) => sum + clampScore(member.score), 0) / members.length
        : members.reduce(
            (sum, member) =>
              sum + clampScore(member.score) * (member.weight > 0 ? member.weight : 0),
            0,
          ) / totalWeight;
    aggregated.push(
      Object.freeze({
        dimension,
        score: clampScore(score),
        // The worst member verdict wins: averaging a failure away with two passes is how a
        // regression hides inside a healthy-looking overall score.
        verdict: worstVerdict(members.map((member) => member.verdict)),
        weight: members.reduce((sum, member) => sum + member.weight, 0),
        findings: orderFindings(members.flatMap((member) => [...member.findings])),
      }),
    );
  }
  return Object.freeze(aggregated);
}

/**
 * Evaluates an input against a list of rules.
 *
 * Disabled rules are skipped and never appear in `rulesApplied`. With no enabled rules at all the
 * verdict is `warn`, not `pass`: measuring nothing is not the same as measuring a good result, and
 * a caller that sees `pass` will assume something was checked.
 */
export function evaluateRules(
  input: EvaluationInput,
  specs: readonly EvaluationRuleSpec[],
): EvaluationOutcome {
  assertEvaluationRuleCount(specs);
  assertNoDuplicateRuleIds(specs);

  const enabled = specs.filter((spec) => spec.enabled);
  const provisional = enabled.map((spec) => applyRule(input, spec));
  const scores = aggregateByDimension(provisional);

  return Object.freeze({
    scores,
    rulesApplied: Object.freeze(enabled.map((spec) => spec.id)),
    verdict: scores.length === 0 ? "warn" : worstVerdict(scores.map((score) => score.verdict)),
    overallScore: clampScore(weightedOverallScore(scores)),
  });
}

/** Throws when two specs in one list claim the same identifier. */
export function assertNoDuplicateRuleIds(specs: readonly EvaluationRuleSpec[]): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.id)) {
      throw duplicateRuleId("<evaluation>", spec.id);
    }
    seen.add(spec.id);
  }
}
