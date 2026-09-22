/**
 * `@omnis/ai-evaluation` — deterministic evaluation of AI executions.
 *
 * Public surface:
 * - {@link EvaluationEngine} and {@link InMemoryEvaluationEngine}: versioned rule sets plus one
 *   `evaluate` call that grades measured facts.
 * - {@link BUILT_IN_EVALUATION_RULES}, {@link ruleSpecFor} and {@link DEFAULT_EVALUATION_RULES}:
 *   the eight shipped rules and the way to derive a variant of one.
 * - {@link evaluateRules}, {@link applyRule} and {@link aggregateByDimension}: the pure scoring
 *   core, usable without an engine.
 * - {@link evaluationInputFromResult} and {@link evaluationInputFromRecord}: build the facts a
 *   rule reads from something the kernel already produced.
 * - Schemas, published contracts and error factories.
 *
 * There is no LLM-as-judge here and no hook to add one. See the module comment in
 * `@omnis/ai-core-types`' `evaluation.ts` for why that is a decision rather than a gap.
 */

export {
  createEvaluationEngine,
  DEFAULT_EVALUATION_RULE_SET_NAME,
  InMemoryEvaluationEngine,
} from "./EvaluationEngine.js";
export type {
  EvaluationEngine,
  EvaluationEngineOptions,
  EvaluationOptions,
} from "./EvaluationEngine.js";

export { createRuleSet, enabledRules, findRule, ruleSetName } from "./ruleSets.js";
export type { EvaluationRuleSet, EvaluationRuleSetInput } from "./ruleSets.js";

export {
  BUILT_IN_EVALUATION_RULES,
  DEFAULT_EVALUATION_RULES,
  EVALUATION_RULE_KEYS,
  budgetScore,
  finding,
  isEvaluationRuleKey,
  MAX_FINDINGS_PER_RULE,
  measurement,
  requireRuleImplementation,
  ruleImplementation,
  ruleSpecFor,
  completionRuleParametersSchema,
  costRuleParametersSchema,
  expectedOutputRuleParametersSchema,
  latencyRuleParametersSchema,
  outputSchemaRuleParametersSchema,
  outputShapeRuleParametersSchema,
  policyComplianceRuleParametersSchema,
  toolOutcomesRuleParametersSchema,
} from "./EvaluationRules.js";
export type {
  EvaluationRuleImplementation,
  EvaluationRuleKey,
  RuleMeasurement,
  RuleSpecOverrides,
} from "./EvaluationRules.js";

export {
  aggregateByDimension,
  applyRule,
  assertNoDuplicateRuleIds,
  evaluateRules,
  orderFindings,
} from "./scoring.js";
export type { EvaluationOutcome } from "./scoring.js";

export {
  assertEvaluationInput,
  emptyUsage,
  evaluationInputFromRecord,
  evaluationInputFromResult,
  isEvaluationInput,
  isPolicyOutcome,
  MAX_EVALUATED_TOOL_RESULTS,
} from "./input.js";
export type { EvaluationInputExtras } from "./input.js";

export {
  jsonEquals,
  kindOfJson,
  leafPaths,
  MAX_COMPARED_PATHS,
  MAX_RENDERED_CHARACTERS,
  readJsonPath,
  renderedLength,
  stableJson,
} from "./jsonFacts.js";

export {
  duplicateRuleId,
  duplicateRuleSet,
  invalidEvaluationInput,
  invalidRule,
  invalidRuleParameters,
  invalidRuleSet,
  ruleNotFound,
  ruleSetCapacityExceeded,
  ruleSetNotFound,
  unknownRuleImplementation,
} from "./errors.js";

export {
  EVALUATION_RESULT_CONTRACT,
  EVALUATION_RULE_CONTRACT,
  EVALUATION_RULE_SET_CONTRACT,
  evaluationDimensionSchema,
  evaluationFindingSchema,
  evaluationNameSchema,
  evaluationResultSchema,
  evaluationRuleSetInputSchema,
  evaluationRuleSetSchema,
  evaluationRuleSpecSchema,
  evaluationScoreSchema,
  evaluationVerdictSchema,
  findingSeveritySchema,
  isEvaluationDimensionValue,
  isEvaluationVerdict,
  isFindingSeverity,
  MAX_EVALUATION_NAME_LENGTH,
  MAX_EVALUATION_RULE_SETS,
} from "./evaluationValidation.js";
