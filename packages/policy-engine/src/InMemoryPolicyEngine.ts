/**
 * The in-memory policy engine.
 *
 * Policy sets are stored frozen and versioned; every revision produces a new object rather
 * than editing the old one. A decision that quotes `policy@3` therefore keeps referring to
 * the same rules no matter what happens to the engine afterwards, which is what makes an
 * audit trail worth reading.
 *
 * All methods are synchronous. Evaluation is a pure function of stored rules and the input,
 * so there is nothing to await and nothing to interleave.
 */

import { nowIso } from "@omnis/types";
import { validate } from "@omnis/validation";
import { sanitizeMetadata } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import {
  assertJsonSafe,
  assertPolicySetSize,
  MATCH_ALL_TARGET,
  mostRestrictiveOutcome,
} from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  ConstraintSpec,
  PolicyCondition,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyId,
  PolicyOutcome,
  PolicyRule,
  PolicyRuleTarget,
  PolicySet,
} from "@omnis/ai-core-types";
import {
  assertDecisionPermitted,
  evaluatePolicySet,
  evaluationInputFromContext,
} from "./PolicyEvaluation.js";
import type {
  ContextualPolicyRequest,
  PolicyEngine,
  PolicyEngineOptions,
  PolicyGateResult,
} from "./PolicyEngine.js";
import type { ConstraintSpecInput, PolicyRuleInput, PolicySetInput } from "./policyValidation.js";
import {
  policyRuleInputSchema,
  policySetInputSchema,
  policySetSchema,
} from "./policyValidation.js";
import {
  duplicatePolicyRuleId,
  duplicatePolicySet,
  invalidPolicySet,
  policySetCapacityExceeded,
  policySetNotFound,
} from "./errors.js";
import { createPolicyId } from "@omnis/types";

/** Default rule priority: middling, so an explicit choice always wins. */
const DEFAULT_RULE_PRIORITY = 100;

/** Default capacity. */
const DEFAULT_MAX_POLICY_SETS = 32;

/** Redacts and JSON-checks caller metadata before it becomes part of a stored rule. */
function sanitizePolicyMetadata(metadata: Readonly<Record<string, unknown>>): AiCoreMetadata {
  const redacted = sanitizeMetadata(metadata);
  assertJsonSafe(redacted, "policy metadata");
  return redacted as AiCoreMetadata;
}

/** Gives every stored constraint the same shape: `reason` present, possibly `null`. */
function normalizeConstraint(constraint: ConstraintSpecInput): ConstraintSpec {
  return Object.freeze({
    kind: constraint.kind,
    value: constraint.value,
    source: constraint.source,
    reason: constraint.reason ?? null,
  });
}

/** Fills in the optional parts of a rule and freezes the result. */
function buildRule(input: PolicyRuleInput): PolicyRule {
  const parsed = validate(policyRuleInputSchema, input, "PolicyRule");
  const target: PolicyRuleTarget = Object.freeze({ ...MATCH_ALL_TARGET, ...(parsed.target ?? {}) });
  const conditions: readonly PolicyCondition[] = Object.freeze(
    (parsed.conditions ?? []).map((condition) => Object.freeze({ ...condition })),
  );
  const constraints: readonly ConstraintSpec[] = Object.freeze(
    (parsed.constraints ?? []).map(normalizeConstraint),
  );
  return Object.freeze({
    id: parsed.id,
    name: parsed.name,
    description: parsed.description ?? "",
    outcome: parsed.outcome,
    target,
    conditions,
    constraints,
    priority: parsed.priority ?? DEFAULT_RULE_PRIORITY,
    enabled: parsed.enabled ?? true,
    metadata: sanitizePolicyMetadata(parsed.metadata ?? {}),
  });
}

/**
 * Rejects a rule list containing the same identifier twice.
 *
 * Checked on every write path, not only at registration: `addRule` appending a rule whose id
 * already exists would otherwise produce a set in which "the rule that decided" is ambiguous,
 * and a decision that cannot name its rule cannot be audited.
 */
function assertUniqueRuleIds(rules: readonly PolicyRule[], policyId: PolicyId): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw duplicatePolicyRuleId(policyId, rule.id);
    }
    seen.add(rule.id);
  }
}

/** Builds every rule in a set and rejects duplicate identifiers. */
function buildRules(rules: readonly PolicyRuleInput[], policyId: PolicyId): readonly PolicyRule[] {
  const built = rules.map(buildRule);
  assertUniqueRuleIds(built, policyId);
  return Object.freeze(built);
}

/** Freezes a set and everything reachable from it. */
function deepFreezePolicySet(policySet: PolicySet): PolicySet {
  for (const rule of policySet.rules) {
    Object.freeze(rule.target);
    Object.freeze(rule.conditions);
    for (const condition of rule.conditions) {
      Object.freeze(condition);
    }
    Object.freeze(rule.constraints);
    for (const constraint of rule.constraints) {
      Object.freeze(constraint);
    }
    Object.freeze(rule.metadata);
    Object.freeze(rule);
  }
  Object.freeze(policySet.rules);
  Object.freeze(policySet.baselineConstraints);
  for (const constraint of policySet.baselineConstraints) {
    Object.freeze(constraint);
  }
  Object.freeze(policySet.metadata);
  return Object.freeze(policySet);
}

/** The in-memory implementation of {@link PolicyEngine}. */
export class InMemoryPolicyEngine implements PolicyEngine {
  private readonly policySets = new Map<PolicyId, PolicySet>();
  private readonly clock: () => string;
  private readonly maxPolicySets: number;
  private readonly includeDisabledRules: boolean;

  constructor(options: PolicyEngineOptions = {}) {
    this.clock = options.clock ?? nowIso;
    this.maxPolicySets = options.maxPolicySets ?? DEFAULT_MAX_POLICY_SETS;
    this.includeDisabledRules = options.includeDisabledRules ?? false;
    if (!Number.isInteger(this.maxPolicySets) || this.maxPolicySets <= 0) {
      throw new RangeError(
        `policy engine capacity must be a positive integer, received ${String(this.maxPolicySets)}`,
      );
    }
  }

  get size(): number {
    return this.policySets.size;
  }

  registerPolicySet(input: PolicySetInput): PolicySet {
    const parsed = validate(policySetInputSchema, input, "PolicySet");
    const policyId = parsed.id ?? createPolicyId();
    if (this.policySets.size >= this.maxPolicySets) {
      throw policySetCapacityExceeded(this.maxPolicySets);
    }
    if (this.policySets.has(policyId)) {
      throw duplicatePolicySet(policyId, parsed.name);
    }
    const policySet = deepFreezePolicySet({
      id: policyId,
      name: parsed.name,
      description: parsed.description ?? "",
      version: 1,
      rules: buildRules(parsed.rules, policyId),
      defaultOutcome: parsed.defaultOutcome,
      baselineConstraints: Object.freeze(
        (parsed.baselineConstraints ?? []).map(normalizeConstraint),
      ),
      metadata: sanitizePolicyMetadata(parsed.metadata ?? {}),
      createdAt: parsed.createdAt ?? this.clock(),
    });
    this.policySets.set(policyId, policySet);
    return policySet;
  }

  setRules(policyId: PolicyId, rules: readonly PolicyRuleInput[]): PolicySet {
    return this.revise(policyId, (current) => ({ ...current, rules: buildRules(rules, policyId) }));
  }

  addRule(policyId: PolicyId, rule: PolicyRuleInput): PolicySet {
    return this.revise(policyId, (current) => ({
      ...current,
      rules: Object.freeze([...current.rules, buildRule(rule)]),
    }));
  }

  removeRule(policyId: PolicyId, ruleId: string): PolicySet {
    return this.revise(policyId, (current) => ({
      ...current,
      rules: Object.freeze(current.rules.filter((candidate) => candidate.id !== ruleId)),
    }));
  }

  setDefaultOutcome(policyId: PolicyId, outcome: PolicyOutcome): PolicySet {
    return this.revise(policyId, (current) => ({ ...current, defaultOutcome: outcome }));
  }

  setBaselineConstraints(
    policyId: PolicyId,
    constraints: readonly ConstraintSpecInput[],
  ): PolicySet {
    return this.revise(policyId, (current) => ({
      ...current,
      baselineConstraints: Object.freeze(constraints.map(normalizeConstraint)),
    }));
  }

  getPolicySet(policyId: PolicyId): PolicySet | null {
    return this.policySets.get(policyId) ?? null;
  }

  requirePolicySet(policyId: PolicyId): PolicySet {
    const policySet = this.policySets.get(policyId);
    if (policySet === undefined) {
      throw policySetNotFound(policyId);
    }
    return policySet;
  }

  has(policyId: PolicyId): boolean {
    return this.policySets.has(policyId);
  }

  remove(policyId: PolicyId): boolean {
    return this.policySets.delete(policyId);
  }

  list(): readonly PolicySet[] {
    return Object.freeze(
      [...this.policySets.values()].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    );
  }

  evaluate(policyId: PolicyId, input: PolicyEvaluationInput): PolicyDecision {
    return evaluatePolicySet(this.requirePolicySet(policyId), input, {
      evaluatedAt: this.clock(),
      includeDisabledRules: this.includeDisabledRules,
    });
  }

  evaluateWithContext(
    policyId: PolicyId,
    context: ExecutionContext,
    request: ContextualPolicyRequest,
  ): PolicyDecision {
    return this.evaluate(policyId, evaluationInputFromContext(context, request));
  }

  gate(input: PolicyEvaluationInput, policyIds: readonly PolicyId[]): PolicyGateResult {
    const evaluatedAt = this.clock();
    const decisions: PolicyDecision[] = [];
    const seen = new Set<PolicyId>();
    for (const policyId of policyIds) {
      // A set listed twice is evaluated once: duplicating its constraints would silently
      // halve every limit a reader computes by summing them.
      if (seen.has(policyId)) {
        continue;
      }
      seen.add(policyId);
      decisions.push(
        evaluatePolicySet(this.requirePolicySet(policyId), input, {
          evaluatedAt,
          includeDisabledRules: this.includeDisabledRules,
        }),
      );
    }

    // Fail closed on an empty gate. `mostRestrictiveOutcome([])` is `allow`, so a caller that
    // passed no policy ids would otherwise get a permit for free — and "the policy list was
    // empty because configuration failed to load" is a real failure mode, not a hypothetical.
    if (decisions.length === 0) {
      return Object.freeze({
        executionId: input.executionId,
        outcome: "deny",
        constraints: Object.freeze([]),
        decisions: Object.freeze([]),
        decidedByPolicyId: null,
        decidedByRuleId: null,
        reason: "no policy sets were supplied for evaluation",
        evaluatedAt,
        deterministic: true,
      });
    }

    const outcome = mostRestrictiveOutcome(decisions.map((decision) => decision.outcome));
    const deciding = decisions.find((decision) => decision.outcome === outcome) ?? null;
    const constraints: ConstraintSpec[] = [];
    for (const decision of decisions) {
      constraints.push(...decision.constraints);
    }
    const action = deciding?.action;
    const reason =
      action !== undefined && (action.outcome === "deny" || action.outcome === "require_approval")
        ? action.reason
        : null;

    return Object.freeze({
      executionId: input.executionId,
      outcome,
      constraints: Object.freeze(constraints),
      decisions: Object.freeze(decisions),
      decidedByPolicyId: deciding?.policyId ?? null,
      decidedByRuleId: deciding?.decidedByRuleId ?? null,
      reason,
      evaluatedAt,
      deterministic: true,
    });
  }

  gateWithContext(
    context: ExecutionContext,
    request: ContextualPolicyRequest,
    policyIds: readonly PolicyId[],
  ): PolicyGateResult {
    return this.gate(evaluationInputFromContext(context, request), policyIds);
  }

  assertPermitted(
    policyId: PolicyId,
    input: PolicyEvaluationInput,
    requiredApprover = "operator",
  ): PolicyDecision {
    const decision = this.evaluate(policyId, input);
    assertDecisionPermitted(decision, requiredApprover);
    return decision;
  }

  /**
   * Applies a revision and stores it as the next version.
   *
   * The result is validated against the full policy set schema before it is stored, so a
   * revision can never leave the engine holding a set it would have refused at
   * registration — for example one whose rules now exceed the declared maximum.
   */
  private revise(policyId: PolicyId, patch: (current: PolicySet) => PolicySet): PolicySet {
    const current = this.requirePolicySet(policyId);
    const revised = patch(current);
    assertPolicySetSize(revised);
    assertUniqueRuleIds(revised.rules, policyId);
    const next = deepFreezePolicySet({ ...revised, id: policyId, version: current.version + 1 });
    validate(policySetSchema, next, "PolicySet");
    this.policySets.set(policyId, next);
    return next;
  }
}

/** Creates an in-memory policy engine. */
export function createPolicyEngine(options: PolicyEngineOptions = {}): PolicyEngine {
  return new InMemoryPolicyEngine(options);
}

/** Rejects a policy set that cannot be stored, before it reaches an engine. */
export function assertValidPolicySet(policySet: PolicySet): void {
  assertPolicySetSize(policySet);
  validate(policySetSchema, policySet, "PolicySet");
  assertUniqueRuleIds(policySet.rules, policySet.id);
  if (policySet.rules.length === 0 && policySet.defaultOutcome === "allow") {
    // Not an error — a permissive set is a legitimate configuration — but it is the shape
    // that most often means "the rules failed to load", so it is worth a distinct message.
    throw invalidPolicySet(
      "a policy set with no rules and a default outcome of allow permits everything",
    );
  }
}
