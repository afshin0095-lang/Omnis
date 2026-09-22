/**
 * `@omnis/policy-engine` — the gate between "an agent wants to do something" and "the system
 * does it".
 *
 * Public surface:
 * - {@link PolicyEngine} and {@link InMemoryPolicyEngine}: versioned policy sets and the
 *   decisions they produce.
 * - {@link evaluatePolicySet} and the condition/target/rule helpers: the pure evaluation core,
 *   exported so a caller can evaluate a set it did not register and still get identical
 *   semantics.
 * - {@link PolicyGateResult}: the merge rule for governing one action with several sets.
 * - {@link assertDecisionPermitted}: the single place a denial becomes an error.
 * - Default policy sets, validation schemas and error factories.
 *
 * Precedence is `deny` > `require_approval` > `constrain` > `allow`, and it is a property of
 * outcomes rather than of rule order — see `POLICY_PRECEDENCE` in `@omnis/ai-core-types`.
 */

export {
  createPolicyEngine,
  InMemoryPolicyEngine,
  assertValidPolicySet,
} from "./InMemoryPolicyEngine.js";

export type {
  ContextualPolicyRequest,
  PolicyEngine,
  PolicyEngineOptions,
  PolicyGateResult,
} from "./PolicyEngine.js";

export {
  assertDecisionPermitted,
  compareJsonValues,
  evaluateCondition,
  evaluatePolicySet,
  evaluateRule,
  evaluationInputFromContext,
  jsonEquals,
  matchesTarget,
  mergeConstraints,
  rankRules,
  resolveField,
  targetMismatch,
  toApprovalRequest,
} from "./PolicyEvaluation.js";
export type { EvaluationOptions } from "./PolicyEvaluation.js";

export {
  BASELINE_SAFETY_CONSTRAINTS,
  DEFAULT_POLICY_RULE_IDS,
  defaultPolicySets,
  denyAllPolicySet,
  permissivePolicySet,
  registerDefaultPolicies,
  safetyPolicySet,
} from "./DefaultPolicies.js";
export type { DefaultPolicyIds } from "./DefaultPolicies.js";

export {
  duplicatePolicyRuleId,
  duplicatePolicySet,
  invalidPolicyRule,
  invalidPolicySet,
  policyApprovalRequired,
  policyDenied,
  policySetCapacityExceeded,
  policySetNotFound,
  unsupportedPolicyOutcome,
} from "./errors.js";

export {
  constraintKindSchema,
  constraintSpecSchema,
  isConstraintKind,
  isPolicyDecision,
  isPolicyOperator,
  isToolRiskLevel,
  MAX_CONDITION_FIELD_LENGTH,
  MAX_RULE_CONDITIONS,
  MAX_RULE_CONSTRAINTS,
  policyActionSchema,
  policyConditionSchema,
  POLICY_DECISION_CONTRACT,
  policyDecisionSchema,
  policyEvaluationInputSchema,
  POLICY_EVALUATION_INPUT_CONTRACT,
  policyOperatorSchema,
  policyOutcomeSchema,
  policyRuleEvaluationSchema,
  policyRuleIdSchema,
  policyRuleInputSchema,
  policyRuleSchema,
  POLICY_RULE_CONTRACT,
  policyRuleTargetSchema,
  POLICY_SET_CONTRACT,
  policySetInputSchema,
  policySetSchema,
  toolRiskLevelSchema,
} from "./policyValidation.js";
export type { ConstraintSpecInput, PolicyRuleInput, PolicySetInput } from "./policyValidation.js";
