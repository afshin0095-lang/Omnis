/**
 * Evaluation errors.
 *
 * Everything here is a *configuration* failure. An evaluation never fails because the work it
 * measured was bad — a bad execution is a `fail` verdict, which is the answer, not an error.
 * What throws is a rule that cannot be applied: an unknown implementation, thresholds that
 * contradict each other, a rule set nobody registered. Catching those at registration time is
 * the point: a rule set that cannot be evaluated would otherwise produce a silently empty
 * result, and an empty result reads as a pass.
 *
 * No error here carries the evaluated output. Outputs are model text and routinely contain
 * whatever the user typed; an error message travels into logs.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";

/** A rule set that is not registered. */
export function ruleSetNotFound(name: string): NotFoundError {
  return new NotFoundError("evaluation-rule-set", name, {
    retryable: false,
    metadata: { registry: "evaluation", name },
  });
}

/** A rule set name that is already registered. */
export function duplicateRuleSet(name: string): ConflictError {
  return new ConflictError(
    `evaluation-rule-set:${name}`,
    `evaluation rule set "${name}" is already registered`,
    {
      retryable: false,
      metadata: { registry: "evaluation", name },
    },
  );
}

/** Two rules in one set claim the same identifier. */
export function duplicateRuleId(ruleSet: string, ruleId: string): ConflictError {
  return new ConflictError(
    `evaluation-rule:${ruleSet}/${ruleId}`,
    `evaluation rule "${ruleId}" is already defined in "${ruleSet}"`,
    {
      retryable: false,
      metadata: { registry: "evaluation", ruleSet, ruleId },
    },
  );
}

/** A rule identifier that is not in the set being evaluated. */
export function ruleNotFound(ruleSet: string, ruleId: string): NotFoundError {
  return new NotFoundError("evaluation-rule", `${ruleSet}/${ruleId}`, {
    retryable: false,
    metadata: { registry: "evaluation", ruleSet, ruleId },
  });
}

/** A rule set that cannot be stored as given. */
export function invalidRuleSet(reason: string, name: string | null = null): ValidationError {
  return new ValidationError(`evaluation rule set is invalid: ${reason}`, {
    retryable: false,
    metadata: { registry: "evaluation", name },
  });
}

/** A rule the engine cannot apply. */
export function invalidRule(ruleId: string, reason: string): ValidationError {
  return new ValidationError(`evaluation rule "${ruleId}" is invalid: ${reason}`, {
    retryable: false,
    metadata: { registry: "evaluation", ruleId },
  });
}

/** A rule that names an implementation the engine does not have. */
export function unknownRuleImplementation(
  ruleId: string,
  key: string,
  known: readonly string[],
): ValidationError {
  return new ValidationError(
    `evaluation rule "${ruleId}" names implementation "${key}", which is not one of: ${known.join(", ")}`,
    {
      retryable: false,
      // The known keys are configuration, not data: listing them turns the error into the fix.
      metadata: { registry: "evaluation", ruleId, key, known },
    },
  );
}

/** A rule whose parameters do not satisfy its implementation's schema. */
export function invalidRuleParameters(ruleId: string, issues: readonly string[]): ValidationError {
  return new ValidationError(
    `evaluation rule "${ruleId}" has invalid parameters: ${issues.join("; ")}`,
    {
      retryable: false,
      metadata: { registry: "evaluation", ruleId, issues },
    },
  );
}

/** More rule sets than the engine is configured to hold. */
export function ruleSetCapacityExceeded(maxRuleSets: number): ConflictError {
  return new ConflictError(
    "evaluation-rule-set:capacity",
    `evaluation engine holds at most ${String(maxRuleSets)} rule sets`,
    {
      retryable: false,
      metadata: { registry: "evaluation", maxRuleSets },
    },
  );
}

/** An evaluation input that is missing facts the rules read. */
export function invalidEvaluationInput(issues: readonly string[]): ValidationError {
  return new ValidationError(`evaluation input is invalid: ${issues.join("; ")}`, {
    retryable: false,
    // Issues name fields, never values: the output field is model text.
    metadata: { registry: "evaluation", issues },
  });
}
