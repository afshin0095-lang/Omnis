/**
 * Policy evaluation: a pure function from a policy set and an input to a decision.
 *
 * The evaluator reads nothing but its arguments and an injected timestamp. No clock of its
 * own, no randomness, no I/O, no model call. That is what makes a decision reproducible:
 * given the same policy set version and the same input, the same decision comes out, which
 * is the property an audit trail depends on and the property a test can assert.
 *
 * Evaluation order:
 *
 * 1. Every enabled rule is checked against the input — target first (cheap field equality),
 *    then conditions (path resolution and comparison).
 * 2. The effective outcome is the most restrictive outcome among the rules that matched, or
 *    the set's default outcome when none did. Precedence lives in
 *    {@link POLICY_PRECEDENCE}, so a low-priority `allow` can never cancel a `deny`.
 * 3. Constraints are the set's baseline plus every matched rule's, in a deterministic order.
 *    Constraints from a denied evaluation are still reported: an audit row should show what
 *    the execution would have been limited to, not only that it stopped.
 * 4. The deciding rule is the highest-priority rule (lowest number) among those whose
 *    outcome equals the effective outcome, tie-broken by rule id.
 */

import type { JsonValue } from "@omnis/types";
import { sanitizeMetadata } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import { isAtLeastRisk, mostRestrictiveOutcome, readPath } from "@omnis/ai-core-types";
import type {
  ConstraintSpec,
  PolicyAction,
  PolicyApprovalRequest,
  PolicyCondition,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyOutcome,
  PolicyRule,
  PolicyRuleEvaluation,
  PolicyRuleTarget,
  PolicySet,
} from "@omnis/ai-core-types";
import { policyApprovalRequired, policyDenied } from "./errors.js";

/** Options for one evaluation. */
export interface EvaluationOptions {
  /**
   * Timestamp recorded on the decision, as UTC ISO 8601.
   *
   * Required, and supplied by the caller: the evaluator itself never reads a clock, because
   * a "deterministic" evaluator with a hidden `Date.now()` in it is not one.
   */
  readonly evaluatedAt: string;
  /**
   * When true, disabled rules are still reported in `rulesEvaluated` as non-matches.
   *
   * Off by default: a decision record that lists forty rules nobody enabled is noise in an
   * audit view. Turned on when explaining "why did nothing match" to a policy author.
   */
  readonly includeDisabledRules?: boolean;
}

/** Top-level fields a condition may address by name. */
const KNOWN_FIELDS: readonly string[] = Object.freeze([
  "executionId",
  "action",
  "subject",
  "resource",
  "riskLevel",
  "environment",
  "tenantId",
  "agentId",
  "toolId",
  "modelId",
  "providerId",
  "budgetId",
  "attributes",
]);

/**
 * Resolves a condition field against the evaluation input.
 *
 * Known top-level keys resolve directly; anything else is read out of `attributes` by
 * dotted path, with or without the `attributes.` prefix so that both `tenantId` and
 * `attributes.request.channel` read naturally. Path resolution refuses prototype keys, so a
 * condition string supplied by a caller cannot reach `constructor` or `__proto__`.
 *
 * Returns `undefined` for anything absent — a missing field is a fact about the input, not
 * an error in the policy.
 */
export function resolveField(input: PolicyEvaluationInput, field: string): JsonValue | undefined {
  if (KNOWN_FIELDS.includes(field)) {
    return (input as unknown as Readonly<Record<string, JsonValue>>)[field];
  }
  const path = field.startsWith("attributes.") ? field.slice("attributes.".length) : field;
  const resolved = readPath(input.attributes, path);
  return resolved as JsonValue | undefined;
}

/** Structural equality over JSON values. Total: it never throws and never recurses forever. */
export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => jsonEquals(entry, right[index] as JsonValue));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Readonly<Record<string, JsonValue>>;
    const rightRecord = right as Readonly<Record<string, JsonValue>>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return false;
    }
    return leftKeys.every((key) =>
      jsonEquals(leftRecord[key] as JsonValue, rightRecord[key] as JsonValue),
    );
  }
  return false;
}

/**
 * Orders two JSON values, or returns `null` when they cannot be ordered.
 *
 * Numbers compare numerically and must both be finite — `NaN` and `Infinity` are not JSON
 * values and a comparison against one is meaningless rather than false. Strings compare
 * lexicographically, which is the correct order for ISO 8601 timestamps: a policy that needs
 * "after 2026-01-01" should not have to know about epoch arithmetic. Nothing else is
 * ordered: comparing a boolean to a number would be a coercion, and coercions in a policy
 * engine are how a rule starts matching inputs its author never intended.
 */
export function compareJsonValues(left: JsonValue, right: JsonValue): number | null {
  if (typeof left === "number" && typeof right === "number") {
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return null;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return null;
}

/**
 * Evaluates one condition.
 *
 * Fail-closed: when a field is absent, every operator except `exists` yields `false`.
 * `ne` against a missing field is therefore `false`, not `true` — a rule that means "the
 * attribute must not be set" has to say so with `exists` and a `false` value, and that
 * explicitness is the point.
 */
export function evaluateCondition(
  input: PolicyEvaluationInput,
  condition: PolicyCondition,
): boolean {
  const actual = resolveField(input, condition.field);
  const expected = condition.value;

  if (condition.operator === "exists") {
    const present = actual !== undefined;
    return expected === false ? !present : present;
  }
  if (actual === undefined) {
    return false;
  }

  switch (condition.operator) {
    case "eq":
      return jsonEquals(actual, expected);
    case "ne":
      return !jsonEquals(actual, expected);
    case "in":
      return Array.isArray(expected) && expected.some((entry) => jsonEquals(actual, entry));
    case "not_in":
      return Array.isArray(expected) && !expected.some((entry) => jsonEquals(actual, entry));
    case "contains":
      if (Array.isArray(actual)) {
        return actual.some((entry) => jsonEquals(entry, expected));
      }
      return (
        typeof actual === "string" && typeof expected === "string" && actual.includes(expected)
      );
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const comparison = compareJsonValues(actual, expected);
      if (comparison === null) {
        return false;
      }
      if (condition.operator === "gt") {
        return comparison > 0;
      }
      if (condition.operator === "gte") {
        return comparison >= 0;
      }
      if (condition.operator === "lt") {
        return comparison < 0;
      }
      return comparison <= 0;
    }
    default:
      return false;
  }
}

/** Why a target filter did not match, or `null` when it did. */
export function targetMismatch(
  input: PolicyEvaluationInput,
  target: PolicyRuleTarget,
): string | null {
  if (target.subject !== null && target.subject !== input.subject) {
    return `subject=${input.subject}`;
  }
  if (target.action !== null && target.action !== input.action) {
    return `action=${input.action}`;
  }
  if (target.resource !== null && target.resource !== input.resource) {
    return `resource=${input.resource ?? "null"}`;
  }
  if (
    target.minimumRiskLevel !== null &&
    !isAtLeastRisk(input.riskLevel, target.minimumRiskLevel)
  ) {
    return `riskLevel=${input.riskLevel}<${target.minimumRiskLevel}`;
  }
  if (target.environment !== null && target.environment !== input.environment) {
    return `environment=${input.environment ?? "null"}`;
  }
  if (target.tenantId !== null && target.tenantId !== input.tenantId) {
    return "tenantId";
  }
  if (target.agentId !== null && target.agentId !== input.agentId) {
    return "agentId";
  }
  if (target.toolId !== null && target.toolId !== input.toolId) {
    return "toolId";
  }
  if (target.modelId !== null && target.modelId !== input.modelId) {
    return "modelId";
  }
  if (target.providerId !== null && target.providerId !== input.providerId) {
    return "providerId";
  }
  if (target.budgetId !== null && target.budgetId !== input.budgetId) {
    return "budgetId";
  }
  return null;
}

/** True when the input satisfies every non-null filter in the target. */
export function matchesTarget(input: PolicyEvaluationInput, target: PolicyRuleTarget): boolean {
  return targetMismatch(input, target) === null;
}

/** Evaluates one rule against the input, recording why it did or did not apply. */
export function evaluateRule(input: PolicyEvaluationInput, rule: PolicyRule): PolicyRuleEvaluation {
  if (!rule.enabled) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      outcome: null,
      reason: "disabled",
    };
  }
  const mismatch = targetMismatch(input, rule.target);
  if (mismatch !== null) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      outcome: null,
      reason: mismatch,
    };
  }
  for (const condition of rule.conditions) {
    if (!evaluateCondition(input, condition)) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: false,
        outcome: null,
        reason: `condition ${condition.field} ${condition.operator} failed`,
      };
    }
  }
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched: true,
    outcome: rule.outcome,
    reason: null,
  };
}

/**
 * Merges constraints into the order an audit record reports them: baseline first, then the
 * matched rules in rule-priority order.
 *
 * Nothing is dropped and nothing is deduplicated. Two rules limiting the same dimension are
 * both kept, and readers use {@link numericConstraint} — which takes the minimum — so the
 * most restrictive value wins without the merge having to guess which rule was meant.
 */
export function mergeConstraints(
  baseline: readonly ConstraintSpec[],
  rules: readonly PolicyRule[],
): readonly ConstraintSpec[] {
  const merged: ConstraintSpec[] = [...baseline];
  for (const rule of rankRules(rules)) {
    for (const constraint of rule.constraints) {
      merged.push(constraint);
    }
  }
  return Object.freeze(merged);
}

/** Rules in evaluation order: ascending priority, then ascending id. */
export function rankRules(rules: readonly PolicyRule[]): readonly PolicyRule[] {
  return Object.freeze(
    [...rules].sort(
      (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
    ),
  );
}

/**
 * Evaluates a policy set against an input.
 *
 * This is the whole gate. It never throws for a non-matching input: "no rule matched" is a
 * decision, and the set's `defaultOutcome` says what that decision is.
 */
export function evaluatePolicySet(
  policySet: PolicySet,
  input: PolicyEvaluationInput,
  options: EvaluationOptions,
): PolicyDecision {
  const evaluations: PolicyRuleEvaluation[] = [];
  const matched: PolicyRule[] = [];

  for (const rule of rankRules(policySet.rules)) {
    const evaluation = evaluateRule(input, rule);
    if (evaluation.matched || rule.enabled || options.includeDisabledRules === true) {
      evaluations.push(evaluation);
    }
    if (evaluation.matched) {
      matched.push(rule);
    }
  }

  // With no matched rule the set's default outcome decides. `mostRestrictiveOutcome` of an
  // empty list is `allow`, which would silently turn a default-deny set into a default-allow
  // one — the single most dangerous default in this package, so it is spelled out here.
  const outcome =
    matched.length === 0
      ? policySet.defaultOutcome
      : mostRestrictiveOutcome(matched.map((rule) => rule.outcome));
  // When the outcome came from a rule, that rule is named; among equals the highest priority
  // wins, and ids break the tie so the same set always blames the same rule. When no rule
  // matched, the set's default outcome decides and no rule is blamed.
  const deciding =
    matched.length === 0
      ? null
      : (rankRules(matched.filter((rule) => rule.outcome === outcome))[0] ?? null);

  const constraints = mergeConstraints(policySet.baselineConstraints, matched);
  const action = buildAction(outcome, deciding, constraints, policySet, input);
  const decision: PolicyDecision = {
    executionId: input.executionId,
    policyId: policySet.id,
    policyName: policySet.name,
    policyVersion: policySet.version,
    action,
    outcome,
    constraints,
    rulesEvaluated: Object.freeze(evaluations),
    decidedByRuleId: deciding?.id ?? null,
    evaluatedAt: options.evaluatedAt,
    deterministic: true,
  };
  return Object.freeze(decision);
}

/** Builds the decision's discriminated action. */
function buildAction(
  outcome: PolicyOutcome,
  deciding: PolicyRule | null,
  constraints: readonly ConstraintSpec[],
  policySet: PolicySet,
  input: PolicyEvaluationInput,
): PolicyAction {
  switch (outcome) {
    case "deny":
      return {
        outcome,
        reason:
          deciding === null
            ? defaultReason(policySet, input)
            : `${deciding.name}: ${deciding.description}`,
        ruleId: deciding?.id ?? "",
        constraints,
      };
    case "require_approval":
      return {
        outcome,
        reason:
          deciding === null
            ? defaultReason(policySet, input)
            : `${deciding.name}: ${deciding.description}`,
        ruleId: deciding?.id ?? "",
        constraints,
      };
    case "constrain":
      return { outcome, constraints };
    case "allow":
      return { outcome, constraints };
  }
}

/** The reason recorded when the default outcome decided. */
function defaultReason(policySet: PolicySet, input: PolicyEvaluationInput): string {
  return `no rule matched ${input.action} for ${input.subject}; default outcome is ${policySet.defaultOutcome}`;
}

/**
 * Throws unless the decision permits the operation to proceed.
 *
 * The single place where "policy said no" becomes an error, so every caller — kernel, tool
 * runtime, orchestrator — reports a denial the same way and with the same metadata.
 */
export function assertDecisionPermitted(
  decision: PolicyDecision,
  requiredApprover = "operator",
): void {
  if (decision.action.outcome === "deny") {
    throw policyDenied(decision);
  }
  if (decision.action.outcome === "require_approval") {
    throw policyApprovalRequired(decision, requiredApprover);
  }
}

/** Builds the approval request a `require_approval` decision implies, or `null`. */
export function toApprovalRequest(
  decision: PolicyDecision,
  requiredApprover: string,
  requestedAt: string,
): PolicyApprovalRequest | null {
  const action = decision.action;
  if (action.outcome !== "require_approval") {
    return null;
  }
  return Object.freeze({
    executionId: decision.executionId,
    policyId: decision.policyId,
    ruleId: action.ruleId,
    reason: action.reason,
    constraints: decision.constraints,
    requestedAt,
    requiredApprover,
  });
}

/**
 * Builds an evaluation input from an execution context.
 *
 * Identity facts (execution, tenant, agent) come from the context and cannot be overridden
 * by the caller: a tool invocation must not be able to present itself as belonging to a
 * different tenant to slip past a tenant-scoped rule. Everything else is supplied by the
 * caller, and the attribute bag is sanitized so a decision's inputs are always JSON-safe.
 */
export function evaluationInputFromContext(
  context: ExecutionContext,
  request: {
    readonly action: string;
    readonly subject: string;
    readonly resource?: string | null;
    readonly riskLevel?: PolicyEvaluationInput["riskLevel"];
    readonly toolId?: PolicyEvaluationInput["toolId"];
    readonly modelId?: PolicyEvaluationInput["modelId"];
    readonly providerId?: PolicyEvaluationInput["providerId"];
    readonly budgetId?: PolicyEvaluationInput["budgetId"];
    readonly attributes?: Readonly<Record<string, unknown>>;
  },
): PolicyEvaluationInput {
  const environment = context.metadata["environment"];
  const attributes = sanitizeMetadata({ ...context.metadata, ...(request.attributes ?? {}) });
  return {
    executionId: context.executionId,
    action: request.action,
    subject: request.subject,
    resource: request.resource ?? null,
    riskLevel: request.riskLevel ?? "low",
    environment: typeof environment === "string" ? environment : null,
    tenantId: context.tenantId,
    agentId: context.agentId,
    toolId: request.toolId ?? null,
    modelId: request.modelId ?? null,
    providerId: request.providerId ?? null,
    budgetId: request.budgetId ?? null,
    attributes,
  };
}
