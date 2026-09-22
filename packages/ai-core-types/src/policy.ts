/**
 * Policy contracts.
 *
 * Policy is the gate between "an agent wants to do something" and "the system does
 * it". Two properties are non-negotiable and are encoded in the shapes below:
 *
 * 1. **Determinism.** A decision is a pure function of the evaluation input and the
 *    policy set. No clock reads beyond the recorded timestamp, no randomness, no
 *    network, no "ask the model whether this is safe". A policy that is not
 *    reproducible cannot be tested, cannot be audited, and cannot be trusted to deny
 *    the same request twice.
 * 2. **Explicit precedence.** `deny` beats `require_approval` beats `constrain` beats
 *    `allow`, always. Precedence is a property of the *outcome*, not of rule order,
 *    so a low-priority allow can never undo a high-priority deny — and a rule author
 *    cannot accidentally create that hole by reordering a list.
 *
 * Constraints are data, not code: a `constrain` decision emits typed
 * {@link ConstraintSpec} values that the orchestrator, the budget engine and the tool
 * runtime interpret. A policy that could execute arbitrary logic would be an
 * un-sandboxed code path sitting in front of every privileged operation.
 */

import type { JsonValue } from "@omnis/types";
import { MAX_POLICY_RULES, type AiCoreMetadata } from "./constants.js";
import type {
  AgentId,
  BudgetId,
  ExecutionId,
  ModelId,
  PolicyId,
  ProviderId,
  TenantId,
  ToolId,
} from "./identifiers.js";
import type { ToolRiskLevel } from "./tool.js";

/** The four possible policy outcomes. */
export const POLICY_OUTCOMES = ["allow", "constrain", "require_approval", "deny"] as const;

/** One policy outcome. */
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

/**
 * Outcome precedence, most restrictive first.
 *
 * The effective outcome of a policy evaluation is the most restrictive outcome among
 * the rules that matched. This array *is* the precedence rule; the evaluator indexes
 * into it rather than hard-coding comparisons, so there is exactly one place to change
 * (and one test to update) if governance ever needs a different order.
 */
export const POLICY_PRECEDENCE: readonly PolicyOutcome[] = Object.freeze([
  "deny",
  "require_approval",
  "constrain",
  "allow",
]);

/** Numeric precedence rank. Lower is more restrictive. */
export function policyOutcomeRank(outcome: PolicyOutcome): number {
  return POLICY_PRECEDENCE.indexOf(outcome);
}

/** The most restrictive of the given outcomes, or `allow` when there are none. */
export function mostRestrictiveOutcome(outcomes: readonly PolicyOutcome[]): PolicyOutcome {
  let best: PolicyOutcome = "allow";
  for (const outcome of outcomes) {
    if (policyOutcomeRank(outcome) < policyOutcomeRank(best)) {
      best = outcome;
    }
  }
  return best;
}

/** True when the outcome stops the execution instead of shaping it. */
export function isBlockingOutcome(outcome: PolicyOutcome): boolean {
  return outcome === "deny" || outcome === "require_approval";
}

/** What a `constrain` outcome may limit. */
export const CONSTRAINT_KINDS = [
  "max_output_tokens",
  "max_cost_micro_usd",
  "max_tool_calls",
  "max_model_calls",
  "max_steps",
  "max_duration_ms",
  "max_retries",
  "allowed_models",
  "denied_models",
  "allowed_providers",
  "denied_providers",
  "allowed_tools",
  "denied_tools",
  "required_response_format",
  "redact_output",
  "require_streaming",
  "custom",
] as const;

/** One constraint kind. */
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

/**
 * A single limit or restriction imposed by a policy decision.
 *
 * `value` is JSON, and `source` names the rule that produced it, so an audit row can
 * answer "why was this execution limited to 500 tokens?" without re-running the
 * evaluation.
 */
export interface ConstraintSpec {
  readonly kind: ConstraintKind;
  readonly value: JsonValue;
  /** Identifier of the rule that imposed the constraint. */
  readonly source: string;
  readonly reason: string | null;
}

/** Reads a numeric constraint, or `null` when absent or not a finite number. */
export function numericConstraint(
  constraints: readonly ConstraintSpec[],
  kind: ConstraintKind,
): number | null {
  let result: number | null = null;
  for (const constraint of constraints) {
    if (constraint.kind !== kind) {
      continue;
    }
    if (typeof constraint.value === "number" && Number.isFinite(constraint.value)) {
      // The most restrictive value wins when two rules constrain the same dimension.
      result = result === null ? constraint.value : Math.min(result, constraint.value);
    }
  }
  return result;
}

/** Reads a string-list constraint, merging every rule that contributed. */
export function listConstraint(
  constraints: readonly ConstraintSpec[],
  kind: ConstraintKind,
): readonly string[] {
  const values: string[] = [];
  for (const constraint of constraints) {
    if (constraint.kind !== kind || !Array.isArray(constraint.value)) {
      continue;
    }
    for (const entry of constraint.value) {
      if (typeof entry === "string" && !values.includes(entry)) {
        values.push(entry);
      }
    }
  }
  return Object.freeze(values);
}

/** Comparison operators available to a rule condition. Deliberately small: no regex, no eval. */
export const POLICY_OPERATORS = [
  "eq",
  "ne",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "exists",
] as const;

/** One condition operator. */
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];

/**
 * A condition over one field of the evaluation input.
 *
 * `field` is a dotted path resolved against the input's `attributes` bag and its
 * known top-level keys. Path resolution is total: a missing field never throws, it
 * simply fails `exists` and fails every comparison.
 */
export interface PolicyCondition {
  readonly field: string;
  readonly operator: PolicyOperator;
  readonly value: JsonValue;
}

/** The entity kinds a rule may be scoped to. All fields are optional filters. */
export interface PolicyRuleTarget {
  /** Free-form subject class, e.g. `"agent"`, `"tool"`, `"model"`, `"tenant"`. */
  readonly subject: string | null;
  /** The action being attempted, e.g. `"execute"`, `"tool.invoke"`, `"model.call"`. */
  readonly action: string | null;
  /** The resource being acted on, e.g. a tool slug or model slug. */
  readonly resource: string | null;
  /** Minimum risk level the rule applies to, inclusive. */
  readonly minimumRiskLevel: ToolRiskLevel | null;
  readonly environment: string | null;
  readonly tenantId: TenantId | null;
  readonly agentId: AgentId | null;
  readonly toolId: ToolId | null;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly budgetId: BudgetId | null;
}

/** A {@link PolicyRuleTarget} that matches everything. */
export const MATCH_ALL_TARGET: PolicyRuleTarget = Object.freeze({
  subject: null,
  action: null,
  resource: null,
  minimumRiskLevel: null,
  environment: null,
  tenantId: null,
  agentId: null,
  toolId: null,
  modelId: null,
  providerId: null,
  budgetId: null,
});

/** One policy rule: a target, conditions, and the outcome when they all hold. */
export interface PolicyRule {
  /** Unique within its policy set. Recorded on every decision the rule contributes to. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly outcome: PolicyOutcome;
  readonly target: PolicyRuleTarget;
  /** All conditions must hold (logical AND). An empty list means "target match only". */
  readonly conditions: readonly PolicyCondition[];
  /** Constraints applied when the outcome is `constrain`. Ignored otherwise. */
  readonly constraints: readonly ConstraintSpec[];
  /**
   * Evaluation order within the same outcome.
   *
   * Priority never overrides precedence: it only decides which rule of the *winning*
   * outcome is reported as the reason, and which constraints are collected first.
   */
  readonly priority: number;
  readonly enabled: boolean;
  readonly metadata: AiCoreMetadata;
}

/** An immutable, versioned set of rules. */
export interface PolicySet {
  readonly id: PolicyId;
  readonly name: string;
  readonly description: string;
  /** Incremented whenever rules change; recorded on every decision it produces. */
  readonly version: number;
  readonly rules: readonly PolicyRule[];
  /** Outcome when no rule matches. `deny` for a default-deny set, `allow` for a permissive one. */
  readonly defaultOutcome: PolicyOutcome;
  /** Constraints applied to every decision from this set, regardless of matching rules. */
  readonly baselineConstraints: readonly ConstraintSpec[];
  readonly metadata: AiCoreMetadata;
  readonly createdAt: string;
}

/** Asserts a policy set is within the declared rule limit. */
export function assertPolicySetSize(policySet: PolicySet): void {
  if (policySet.rules.length > MAX_POLICY_RULES) {
    throw new RangeError(
      `policy set "${policySet.name}" declares ${policySet.rules.length} rules, the maximum is ${MAX_POLICY_RULES}`,
    );
  }
}

/** Everything a policy evaluation is allowed to know. */
export interface PolicyEvaluationInput {
  readonly executionId: ExecutionId;
  /** The action being attempted, e.g. `"agent.execute"` or `"tool.invoke"`. */
  readonly action: string;
  readonly subject: string;
  readonly resource: string | null;
  readonly riskLevel: ToolRiskLevel;
  readonly environment: string | null;
  readonly tenantId: TenantId | null;
  readonly agentId: AgentId | null;
  readonly toolId: ToolId | null;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly budgetId: BudgetId | null;
  /**
   * Additional facts conditions may reference, resolved by dotted path.
   *
   * Restricted to JSON so that a condition can never be written against a value that
   * would not survive serialization into the audit record.
   */
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

/** One rule's contribution to a decision. */
export interface PolicyRuleEvaluation {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly matched: boolean;
  readonly outcome: PolicyOutcome | null;
  /** Field that caused a non-match, when the rule was close enough to be worth explaining. */
  readonly reason: string | null;
}

/** The decision itself: a discriminated union on `outcome`. */
export type PolicyAction =
  | {
      readonly outcome: "allow";
      readonly constraints: readonly ConstraintSpec[];
    }
  | {
      readonly outcome: "constrain";
      readonly constraints: readonly ConstraintSpec[];
    }
  | {
      readonly outcome: "require_approval";
      readonly reason: string;
      readonly ruleId: string;
      readonly constraints: readonly ConstraintSpec[];
    }
  | {
      readonly outcome: "deny";
      readonly reason: string;
      readonly ruleId: string;
      readonly constraints: readonly ConstraintSpec[];
    };

/** An immutable policy decision, safe to store and to emit as an event payload. */
export interface PolicyDecision {
  readonly executionId: ExecutionId;
  readonly policyId: PolicyId;
  readonly policyName: string;
  readonly policyVersion: number;
  readonly action: PolicyAction;
  /** The winning outcome, duplicated from `action` for cheap indexing and telemetry. */
  readonly outcome: PolicyOutcome;
  /** Effective constraints: the policy set's baseline plus every matched rule's. */
  readonly constraints: readonly ConstraintSpec[];
  /** Every rule that was evaluated, matched or not. Kept for explainability. */
  readonly rulesEvaluated: readonly PolicyRuleEvaluation[];
  /** Identifier of the rule that decided the outcome, or `null` for the default outcome. */
  readonly decidedByRuleId: string | null;
  readonly evaluatedAt: string;
  /**
   * Always `true`.
   *
   * A literal type rather than a boolean: the contract promises determinism, and a
   * future evaluator that needs a non-deterministic input must change this type — and
   * therefore every consumer — instead of quietly opting out.
   */
  readonly deterministic: true;
}

/** An approval request raised by a `require_approval` decision. */
export interface PolicyApprovalRequest {
  readonly executionId: ExecutionId;
  readonly policyId: PolicyId;
  readonly ruleId: string;
  readonly reason: string;
  readonly constraints: readonly ConstraintSpec[];
  readonly requestedAt: string;
  /** Who must approve: any operator, the tenant owner, or a named role. */
  readonly requiredApprover: string;
}

/** A short, log-safe rendering of a decision. */
export function describePolicyDecision(decision: PolicyDecision): string {
  const rule = decision.decidedByRuleId === null ? "default" : decision.decidedByRuleId;
  return `${decision.outcome}(policy=${decision.policyName}@${decision.policyVersion}, rule=${rule}, constraints=${decision.constraints.length})`;
}
