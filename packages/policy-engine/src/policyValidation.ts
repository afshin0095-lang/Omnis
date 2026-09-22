/**
 * Validation schemas for policy sets, rules and evaluation inputs.
 *
 * Policy is the last gate before privileged work, so its configuration is validated with
 * the same seriousness as a request body: a rule that parses into something the evaluator
 * silently ignores is a hole nobody can see. Every schema here is also the source of the
 * published contracts, so what the engine accepts and what the events promise are the same
 * definition rather than two that can drift.
 */

import type { JsonValue } from "@omnis/types";
import {
  AI_CORE_CONTRACT_VERSION,
  CONSTRAINT_KINDS,
  MATCH_ALL_TARGET,
  MAX_POLICY_RULES,
  POLICY_OPERATORS,
  POLICY_OUTCOMES,
  TOOL_RISK_LEVELS,
} from "@omnis/ai-core-types";
import type {
  ConstraintKind,
  PolicyCondition,
  PolicyDecision,
  PolicyOperator,
  PolicyOutcome,
  PolicyRuleTarget,
  PolicySet,
  ToolRiskLevel,
} from "@omnis/ai-core-types";
import {
  describeSchema,
  identifierSchemas,
  jsonObjectSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
  z,
} from "@omnis/validation";

/** Maximum number of constraints a single rule may impose. */
export const MAX_RULE_CONSTRAINTS = 16;

/** Maximum number of conditions a single rule may declare. */
export const MAX_RULE_CONDITIONS = 16;

/** Maximum length of a dotted condition field path. */
export const MAX_CONDITION_FIELD_LENGTH = 128;

/** Schema for one constraint kind. */
export const constraintKindSchema = z.enum(CONSTRAINT_KINDS);

/** Schema for one constraint. */
export const constraintSpecSchema = z.object({
  kind: constraintKindSchema,
  value: jsonValueSchema,
  source: nonEmptyStringSchema,
  reason: z.string().max(512).nullish(),
});

/** Schema for one condition operator. */
export const policyOperatorSchema = z.enum(POLICY_OPERATORS);

/** Schema for one policy outcome. */
export const policyOutcomeSchema = z.enum(POLICY_OUTCOMES);

/** Schema for one tool risk level. */
export const toolRiskLevelSchema = z.enum(TOOL_RISK_LEVELS);

/** Schema for one condition. */
export const policyConditionSchema = z.object({
  field: z.string().min(1).max(MAX_CONDITION_FIELD_LENGTH),
  operator: policyOperatorSchema,
  value: jsonValueSchema,
});

/** Schema for a rule target. Every field is an optional filter. */
export const policyRuleTargetSchema = z.object({
  subject: z.string().max(128).nullish(),
  action: z.string().max(128).nullish(),
  resource: z.string().max(256).nullish(),
  minimumRiskLevel: toolRiskLevelSchema.nullish(),
  environment: z.string().max(64).nullish(),
  tenantId: identifierSchemas.tenant.nullish(),
  agentId: identifierSchemas.agent.nullish(),
  toolId: identifierSchemas.tool.nullish(),
  modelId: identifierSchemas.model.nullish(),
  providerId: identifierSchemas.provider.nullish(),
  budgetId: identifierSchemas.budget.nullish(),
});

/** Schema for a rule identifier: opaque inside its policy set, but never empty or huge. */
export const policyRuleIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, {
    message: "policy rule id must be lowercase kebab/dot separated",
  });

/** Schema for a complete rule. */
export const policyRuleSchema = z.object({
  id: policyRuleIdSchema,
  name: nonEmptyStringSchema,
  description: z.string().max(1024),
  outcome: policyOutcomeSchema,
  target: policyRuleTargetSchema,
  conditions: z.array(policyConditionSchema).max(MAX_RULE_CONDITIONS),
  constraints: z.array(constraintSpecSchema).max(MAX_RULE_CONSTRAINTS),
  priority: z.number().int().min(0).max(1_000_000),
  enabled: z.boolean(),
  metadata: jsonObjectSchema,
});

/** Schema for a complete policy set. */
export const policySetSchema = z.object({
  id: identifierSchemas.policy,
  name: nonEmptyStringSchema,
  description: z.string().max(1024),
  version: z.number().int().min(1),
  rules: z.array(policyRuleSchema).max(MAX_POLICY_RULES),
  defaultOutcome: policyOutcomeSchema,
  baselineConstraints: z.array(constraintSpecSchema).max(MAX_RULE_CONSTRAINTS),
  metadata: jsonObjectSchema,
  createdAt: z.string().datetime(),
});

/** A rule as supplied at registration, before defaults are applied. */
export const policyRuleInputSchema = policyRuleSchema
  .omit({
    description: true,
    target: true,
    conditions: true,
    constraints: true,
    priority: true,
    enabled: true,
    metadata: true,
  })
  .extend({
    description: z.string().max(1024).optional(),
    target: policyRuleTargetSchema.partial().optional(),
    conditions: z.array(policyConditionSchema).max(MAX_RULE_CONDITIONS).optional(),
    constraints: z.array(constraintSpecSchema).max(MAX_RULE_CONSTRAINTS).optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    metadata: jsonObjectSchema.optional(),
  });

/** A policy set as supplied at registration. */
export const policySetInputSchema = z.object({
  id: identifierSchemas.policy.optional(),
  name: nonEmptyStringSchema,
  description: z.string().max(1024).optional(),
  rules: z.array(policyRuleInputSchema).max(MAX_POLICY_RULES),
  defaultOutcome: policyOutcomeSchema,
  baselineConstraints: z.array(constraintSpecSchema).max(MAX_RULE_CONSTRAINTS).optional(),
  metadata: jsonObjectSchema.optional(),
  createdAt: z.string().datetime().optional(),
});

/** Everything an evaluation is allowed to know. */
export const policyEvaluationInputSchema = z.object({
  executionId: identifierSchemas.execution,
  action: nonEmptyStringSchema,
  subject: nonEmptyStringSchema,
  resource: z.string().max(256).nullish(),
  riskLevel: toolRiskLevelSchema,
  environment: z.string().max(64).nullish(),
  tenantId: identifierSchemas.tenant.nullish(),
  agentId: identifierSchemas.agent.nullish(),
  toolId: identifierSchemas.tool.nullish(),
  modelId: identifierSchemas.model.nullish(),
  providerId: identifierSchemas.provider.nullish(),
  budgetId: identifierSchemas.budget.nullish(),
  attributes: jsonObjectSchema,
});

/** Schema for one rule's contribution to a decision. */
export const policyRuleEvaluationSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  matched: z.boolean(),
  outcome: policyOutcomeSchema.nullable(),
  reason: z.string().nullish(),
});

/** Schema for the decision's discriminated action. */
export const policyActionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow"), constraints: z.array(constraintSpecSchema) }),
  z.object({ outcome: z.literal("constrain"), constraints: z.array(constraintSpecSchema) }),
  z.object({
    outcome: z.literal("require_approval"),
    reason: z.string(),
    ruleId: z.string(),
    constraints: z.array(constraintSpecSchema),
  }),
  z.object({
    outcome: z.literal("deny"),
    reason: z.string(),
    ruleId: z.string(),
    constraints: z.array(constraintSpecSchema),
  }),
]);

/**
 * Schema for a decision.
 *
 * Published as a contract because decisions are emitted as events and written to audit
 * storage: a consumer that cannot parse one has lost the record of why something was
 * allowed or refused.
 */
export const policyDecisionSchema = z.object({
  executionId: identifierSchemas.execution,
  policyId: identifierSchemas.policy,
  policyName: z.string(),
  policyVersion: z.number().int().min(1),
  action: policyActionSchema,
  outcome: policyOutcomeSchema,
  constraints: z.array(constraintSpecSchema),
  rulesEvaluated: z.array(policyRuleEvaluationSchema),
  decidedByRuleId: z.string().nullish(),
  evaluatedAt: z.string().datetime(),
  deterministic: z.literal(true),
});

/** The policy set contract. */
export const POLICY_SET_CONTRACT = describeSchema(
  "PolicySet",
  policySetSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The policy rule contract. */
export const POLICY_RULE_CONTRACT = describeSchema(
  "PolicyRule",
  policyRuleSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The policy decision contract. */
export const POLICY_DECISION_CONTRACT = describeSchema(
  "PolicyDecision",
  policyDecisionSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The policy evaluation input contract. */
export const POLICY_EVALUATION_INPUT_CONTRACT = describeSchema(
  "PolicyEvaluationInput",
  policyEvaluationInputSchema,
  AI_CORE_CONTRACT_VERSION,
);

/**
 * A constraint as supplied at registration.
 *
 * `reason` is optional on the way in and always present (possibly `null`) on the stored rule,
 * so a decision's constraints have a uniform shape and an audit reader never has to ask
 * whether the field was omitted or deliberately empty.
 */
export interface ConstraintSpecInput {
  readonly kind: ConstraintKind;
  readonly value: JsonValue;
  readonly source: string;
  readonly reason?: string | null;
}

/** A rule as supplied at registration. */
export interface PolicyRuleInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly outcome: PolicyOutcome;
  readonly target?: Partial<PolicyRuleTarget>;
  readonly conditions?: readonly PolicyCondition[];
  readonly constraints?: readonly ConstraintSpecInput[];
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A policy set as supplied at registration. */
export interface PolicySetInput {
  readonly id?: PolicySet["id"];
  readonly name: string;
  readonly description?: string;
  readonly rules: readonly PolicyRuleInput[];
  readonly defaultOutcome: PolicyOutcome;
  readonly baselineConstraints?: readonly ConstraintSpecInput[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}

/** A rule target that matches everything, for callers that need the full shape. */
export const matchAllTarget = (): PolicyRuleTarget => MATCH_ALL_TARGET;

/** Type guards mirroring the schemas, for callers that already hold a value. */
export function isConstraintKind(value: string): value is ConstraintKind {
  return constraintKindSchema.safeParse(value).success;
}

/** True when the value is a known condition operator. */
export function isPolicyOperator(value: string): value is PolicyOperator {
  return policyOperatorSchema.safeParse(value).success;
}

/** True when the value is a known risk level. */
export function isToolRiskLevel(value: string): value is ToolRiskLevel {
  return toolRiskLevelSchema.safeParse(value).success;
}

/** True when the value is a structurally valid decision. */
export function isPolicyDecision(value: unknown): value is PolicyDecision {
  return policyDecisionSchema.safeParse(value).success;
}
