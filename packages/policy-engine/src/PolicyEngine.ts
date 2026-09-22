/**
 * The policy engine contract.
 *
 * An engine owns policy sets and answers one question: *may this action happen now?* It
 * holds no execution state, invokes nothing, and cannot be talked into calling a provider or
 * a tool — it produces a decision, and the caller decides what to do with it. That separation
 * is why the kernel can enforce "policy before privileged execution" without the policy
 * engine knowing what privileged execution is.
 *
 * Every mutating method returns the new immutable {@link PolicySet} with its version
 * incremented, so a caller can record exactly which revision produced a decision. Nothing
 * here mutates a set in place: a decision quoting `policy@3` must keep meaning the same rules
 * forever.
 */

import type { ExecutionContext } from "@omnis/execution-context";
import type {
  ConstraintSpec,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyId,
  PolicyOutcome,
  PolicySet,
} from "@omnis/ai-core-types";
import type { ConstraintSpecInput, PolicyRuleInput, PolicySetInput } from "./policyValidation.js";

/** How an engine is configured. */
export interface PolicyEngineOptions {
  /** Source of decision timestamps, as UTC ISO 8601. Injectable for tests. */
  readonly clock?: () => string;
  /** Maximum number of registered policy sets. */
  readonly maxPolicySets?: number;
  /**
   * Report disabled rules in a decision's `rulesEvaluated` list.
   *
   * Off by default: rules nobody enabled are noise in an audit view. Turn it on when a policy
   * author needs to see why nothing matched.
   */
  readonly includeDisabledRules?: boolean;
}

/**
 * The combined result of evaluating several policy sets for one action.
 *
 * A real request is governed by more than one set — tenant policy, agent policy, tool policy
 * — and the caller must not have to invent the merge rule. The merge is: most restrictive
 * outcome wins, constraints accumulate, and the deciding set is the first one (in the order
 * the caller supplied) whose outcome equals the winner.
 */
export interface PolicyGateResult {
  readonly executionId: PolicyEvaluationInput["executionId"];
  /** The most restrictive outcome across every evaluated set. */
  readonly outcome: PolicyOutcome;
  /** Every constraint from every evaluated set, in evaluation order. */
  readonly constraints: readonly ConstraintSpec[];
  /** The individual decisions, in the order the policy ids were given. */
  readonly decisions: readonly PolicyDecision[];
  /** The set that decided the outcome, or `null` when nothing was evaluated. */
  readonly decidedByPolicyId: PolicyId | null;
  /** The rule inside that set, or `null` when its default outcome decided. */
  readonly decidedByRuleId: string | null;
  /** Human-readable reason, present whenever the outcome blocks. */
  readonly reason: string | null;
  readonly evaluatedAt: string;
  /** Always `true`, for the same reason {@link PolicyDecision.deterministic} is. */
  readonly deterministic: true;
}

/** What an action under evaluation is, when derived from an execution context. */
export interface ContextualPolicyRequest {
  readonly action: string;
  readonly subject: string;
  readonly resource?: string | null;
  readonly riskLevel?: PolicyEvaluationInput["riskLevel"];
  readonly toolId?: PolicyEvaluationInput["toolId"];
  readonly modelId?: PolicyEvaluationInput["modelId"];
  readonly providerId?: PolicyEvaluationInput["providerId"];
  readonly budgetId?: PolicyEvaluationInput["budgetId"];
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** The engine's public surface. */
export interface PolicyEngine {
  /** Number of registered policy sets. */
  readonly size: number;

  /** Registers a policy set at version 1. */
  registerPolicySet(input: PolicySetInput): PolicySet;

  /** Replaces a set's rules, incrementing its version. */
  setRules(policyId: PolicyId, rules: readonly PolicyRuleInput[]): PolicySet;

  /** Appends a rule, incrementing the version. */
  addRule(policyId: PolicyId, rule: PolicyRuleInput): PolicySet;

  /** Removes a rule by id, incrementing the version. */
  removeRule(policyId: PolicyId, ruleId: string): PolicySet;

  /** Changes the outcome used when no rule matches, incrementing the version. */
  setDefaultOutcome(policyId: PolicyId, outcome: PolicyOutcome): PolicySet;

  /** Replaces the constraints applied to every decision from this set. */
  setBaselineConstraints(
    policyId: PolicyId,
    constraints: readonly ConstraintSpecInput[],
  ): PolicySet;

  getPolicySet(policyId: PolicyId): PolicySet | null;

  /** Like {@link getPolicySet}, but throws when the set is not registered. */
  requirePolicySet(policyId: PolicyId): PolicySet;

  has(policyId: PolicyId): boolean;

  remove(policyId: PolicyId): boolean;

  /** Every set, ordered by name then id. */
  list(): readonly PolicySet[];

  /** Evaluates one set against one input. */
  evaluate(policyId: PolicyId, input: PolicyEvaluationInput): PolicyDecision;

  /** Evaluates one set against an action derived from an execution context. */
  evaluateWithContext(
    policyId: PolicyId,
    context: ExecutionContext,
    request: ContextualPolicyRequest,
  ): PolicyDecision;

  /** Evaluates several sets and merges them into one gate result. */
  gate(input: PolicyEvaluationInput, policyIds: readonly PolicyId[]): PolicyGateResult;

  /** {@link gate} for an action derived from an execution context. */
  gateWithContext(
    context: ExecutionContext,
    request: ContextualPolicyRequest,
    policyIds: readonly PolicyId[],
  ): PolicyGateResult;

  /**
   * Evaluates and enforces in one step.
   *
   * Returns the decision when the action may proceed; throws a `PolicyViolationError` when
   * it may not. Callers that need to record a denial rather than propagate it use
   * {@link evaluate} and inspect the outcome themselves.
   */
  assertPermitted(
    policyId: PolicyId,
    input: PolicyEvaluationInput,
    requiredApprover?: string,
  ): PolicyDecision;
}
