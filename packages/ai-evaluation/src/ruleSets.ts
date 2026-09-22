/**
 * The stored rule set.
 *
 * Separate from the engine so the shape can be reasoned about — and validated — on its own. A rule
 * set is a versioned, frozen document: the version is what lets a stored evaluation result be
 * explained later against the rules that actually produced it.
 */

import { validate } from "@omnis/validation";
import type { EvaluationRuleSpec } from "@omnis/ai-core-types";
import { evaluationNameSchema, evaluationRuleSetSchema } from "./evaluationValidation.js";

/** A versioned, immutable collection of evaluation rules. */
export interface EvaluationRuleSet {
  /** Unique within an engine. A slug, because operators type these by hand. */
  readonly name: string;
  readonly description: string;
  /** Starts at 1 and increments on every edit. */
  readonly version: number;
  readonly rules: readonly EvaluationRuleSpec[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A rule set as supplied at registration. */
export interface EvaluationRuleSetInput {
  readonly name: string;
  readonly description?: string;
  readonly rules?: readonly EvaluationRuleSpec[];
  readonly version?: number;
  readonly createdAt?: string;
}

/** Normalizes a rule-set name, rejecting anything that is not a slug. */
export function ruleSetName(name: string): string {
  return validate(evaluationNameSchema, name, "evaluation rule set name");
}

/** Builds a frozen rule set, asserting it satisfies the published contract. */
export function createRuleSet(input: EvaluationRuleSet): EvaluationRuleSet {
  const set: EvaluationRuleSet = Object.freeze({
    name: input.name,
    description: input.description,
    version: input.version,
    rules: Object.freeze(input.rules.map((rule) => Object.freeze(rule))),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  validate(evaluationRuleSetSchema, set, "EvaluationRuleSet");
  return set;
}

/** The enabled rules of a set, in declaration order. */
export function enabledRules(set: EvaluationRuleSet): readonly EvaluationRuleSpec[] {
  return Object.freeze(set.rules.filter((rule) => rule.enabled));
}

/** One rule of a set, or `null`. */
export function findRule(set: EvaluationRuleSet, ruleId: string): EvaluationRuleSpec | null {
  return set.rules.find((rule) => rule.id === ruleId) ?? null;
}
