/**
 * Evaluation validation and published contracts.
 *
 * Three shapes cross a boundary and are therefore schema-validated: a rule spec (authored by an
 * operator, stored, later read back), a rule set (the stored unit, versioned), and an evaluation
 * result (emitted in events and written to audit rows).
 *
 * {@link EvaluationInput} is deliberately *not* a zod schema. It is an in-process value built by
 * the kernel from facts it just measured, it contains an arbitrary JSON output and an
 * `ExecutionFailure` whose contract is owned by `@omnis/ai-core-types`, and re-declaring that
 * contract here would create a second source of truth that could drift. It is checked by
 * {@link assertEvaluationInput} instead, which reports every problem it finds.
 */

import {
  describeSchema,
  identifierSchemas,
  jsonObjectSchema,
  nonEmptyStringSchema,
  z,
} from "@omnis/validation";
import {
  AI_CORE_CONTRACT_VERSION,
  EVALUATION_DIMENSIONS,
  EVALUATION_VERDICTS,
  FINDING_SEVERITIES,
  MAX_EVALUATION_RULES,
  SLUG_CONTRACT,
  SLUG_PATTERN,
} from "@omnis/ai-core-types";
import type {
  EvaluationDimension,
  EvaluationFinding,
  EvaluationResult,
  EvaluationRuleSpec,
  EvaluationScore,
  EvaluationVerdict,
  FindingSeverity,
} from "@omnis/ai-core-types";

/** How many rule sets one engine holds. */
export const MAX_EVALUATION_RULE_SETS = 64;

/** The longest rule or rule-set name accepted. */
export const MAX_EVALUATION_NAME_LENGTH = 64;

/** An evaluation dimension. */
export const evaluationDimensionSchema = z.enum(EVALUATION_DIMENSIONS);

/** An evaluation verdict. */
export const evaluationVerdictSchema = z.enum(EVALUATION_VERDICTS);

/** A finding severity. */
export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);

/** A rule or rule-set identifier: a slug, because operators type these by hand. */
export const evaluationNameSchema = z
  .string()
  .min(2)
  .max(MAX_EVALUATION_NAME_LENGTH)
  .regex(SLUG_PATTERN, SLUG_CONTRACT);

/** True when the value names an evaluation verdict. */
export function isEvaluationVerdict(value: string): value is EvaluationVerdict {
  return (EVALUATION_VERDICTS as readonly string[]).includes(value);
}

/** True when the value names a finding severity. */
export function isFindingSeverity(value: string): value is FindingSeverity {
  return (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/** True when the value names an evaluation dimension. */
export function isEvaluationDimensionValue(value: string): value is EvaluationDimension {
  return (EVALUATION_DIMENSIONS as readonly string[]).includes(value);
}

/** One finding. */
export const evaluationFindingSchema = z.strictObject({
  code: nonEmptyStringSchema,
  message: z.string(),
  severity: findingSeveritySchema,
  dimension: evaluationDimensionSchema,
  detail: jsonObjectSchema,
});

/** One dimension's score. */
export const evaluationScoreSchema = z.strictObject({
  dimension: evaluationDimensionSchema,
  score: z.number().min(0).max(1),
  verdict: evaluationVerdictSchema,
  weight: z.number().min(0),
  findings: z.array(evaluationFindingSchema),
});

/**
 * One rule spec.
 *
 * The threshold refinement is in the schema rather than only in `assertEvaluationRuleSpec` so a
 * set loaded from storage is rejected for the same reason a set typed by hand would be.
 */
export const evaluationRuleSpecSchema = z
  .strictObject({
    id: evaluationNameSchema,
    name: nonEmptyStringSchema,
    description: z.string(),
    dimension: evaluationDimensionSchema,
    weight: z.number().min(0),
    passThreshold: z.number().min(0).max(1),
    warnThreshold: z.number().min(0).max(1),
    parameters: jsonObjectSchema,
    enabled: z.boolean(),
  })
  .refine((rule) => rule.passThreshold >= rule.warnThreshold, {
    message: "passThreshold must be greater than or equal to warnThreshold",
    path: ["passThreshold"],
  });

/** A stored rule set. */
export const evaluationRuleSetSchema = z.strictObject({
  name: evaluationNameSchema,
  description: z.string(),
  version: z.number().int().min(1),
  rules: z.array(evaluationRuleSpecSchema).max(MAX_EVALUATION_RULES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** A rule set as supplied at registration. */
export const evaluationRuleSetInputSchema = evaluationRuleSetSchema
  .omit({ version: true, updatedAt: true, createdAt: true, description: true, rules: true })
  .extend({
    description: z.string().optional(),
    rules: z.array(evaluationRuleSpecSchema).max(MAX_EVALUATION_RULES).optional(),
    version: z.number().int().min(1).optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
  });

/** The result of one evaluation run. */
export const evaluationResultSchema = z.strictObject({
  id: identifierSchemas.evaluation,
  executionId: identifierSchemas.execution,
  verdict: evaluationVerdictSchema,
  overallScore: z.number().min(0).max(1),
  scores: z.array(evaluationScoreSchema),
  rulesApplied: z.array(evaluationNameSchema),
  evaluatedAt: z.string().datetime(),
  deterministic: z.literal(true),
  metadata: jsonObjectSchema,
});

/** The rule spec contract. */
export const EVALUATION_RULE_CONTRACT = describeSchema(
  "EvaluationRuleSpec",
  evaluationRuleSpecSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The rule set contract. */
export const EVALUATION_RULE_SET_CONTRACT = describeSchema(
  "EvaluationRuleSet",
  evaluationRuleSetSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The evaluation result contract. */
export const EVALUATION_RESULT_CONTRACT = describeSchema(
  "EvaluationResult",
  evaluationResultSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** Re-exports the value shapes so callers do not have to import the types package too. */
export type {
  EvaluationDimension,
  EvaluationFinding,
  EvaluationResult,
  EvaluationRuleSpec,
  EvaluationScore,
  EvaluationVerdict,
};
