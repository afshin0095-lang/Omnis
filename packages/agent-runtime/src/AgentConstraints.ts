/**
 * An agent's ceilings, expressed as policy.
 *
 * WHY CONSTRAINTS BECOME A POLICY SET
 * -----------------------------------
 * `AgentRuntimeConstraints` could be enforced by the runtime with a handful of
 * `if` statements. It is instead translated into a registered policy set, for
 * three reasons:
 *
 * 1. **One authority.** The kernel already gates every execution through the
 *    policy engine, and the engine already knows how to merge constraints from
 *    several sets, resolve precedence and report what it decided. A second
 *    enforcement path in the runtime would be a second authority, and the two
 *    would disagree in the cases that matter — a tenant policy stricter than the
 *    agent's, or an agent ceiling stricter than the tenant's.
 * 2. **Auditability.** A constraint that is a policy set appears in the decision
 *    recorded on the execution, with its source. A constraint enforced by an `if`
 *    appears nowhere, and "why did this agent stop at four steps" becomes a code
 *    reading exercise.
 * 3. **Testability.** The engine is deterministic and already tested; the
 *    translation below is a pure function from a descriptor to a policy input,
 *    which is the only new logic that needs its own tests.
 *
 * WHAT IS *NOT* TRANSLATED
 * ------------------------
 * `preferredModels` is a preference, not a restriction, and turning it into
 * `allowed_models` would silently make a fallback impossible. It stays a
 * preference and is applied by the planner's ordering, not by policy.
 */

import type { AgentDescriptor, PolicyId, PolicySet } from "@omnis/ai-core-types";
import type { PolicyEngine, PolicySetInput } from "@omnis/policy-engine";
import type { ConstraintSpecInput, PolicyRuleInput } from "@omnis/policy-engine";

/** The name every agent constraint set is registered under. */
export const AGENT_CONSTRAINT_POLICY_NAME = "agent-constraints";

/** Where a translated constraint says it came from. */
export function agentConstraintSource(descriptor: AgentDescriptor): string {
  return `agent:${descriptor.slug}@${descriptor.version}`;
}

/** The constraints a descriptor's ceilings imply, in a stable order. */
export function agentConstraintSpecs(descriptor: AgentDescriptor): readonly ConstraintSpecInput[] {
  const { constraints } = descriptor;
  const source = agentConstraintSource(descriptor);
  const specs: ConstraintSpecInput[] = [];

  if (constraints.maxSteps !== null) {
    specs.push({
      kind: "max_steps",
      value: constraints.maxSteps,
      source,
      reason: "the agent bounds its own plan length",
    });
  }
  if (constraints.maxModelCalls !== null) {
    specs.push({
      kind: "max_model_calls",
      value: constraints.maxModelCalls,
      source,
      reason: "the agent bounds its model calls",
    });
  }
  if (constraints.maxToolCalls !== null) {
    specs.push({
      kind: "max_tool_calls",
      value: constraints.maxToolCalls,
      source,
      reason: "the agent bounds its tool calls",
    });
  }
  if (constraints.maxDurationMs !== null) {
    specs.push({
      kind: "max_duration_ms",
      value: constraints.maxDurationMs,
      source,
      reason: "the agent bounds its own duration",
    });
  }
  if (constraints.maxCostMicroUsd !== null) {
    specs.push({
      kind: "max_cost_micro_usd",
      value: constraints.maxCostMicroUsd,
      source,
      reason: "the agent bounds its own cost",
    });
  }
  if (constraints.maxRetriesPerStep !== null) {
    specs.push({
      kind: "max_retries",
      value: constraints.maxRetriesPerStep,
      source,
      reason: "the agent bounds retries per step",
    });
  }
  if (constraints.allowedTools.length > 0) {
    specs.push({
      kind: "allowed_tools",
      value: [...constraints.allowedTools],
      source,
      reason: "the agent names the tools it may call",
    });
  }
  if (constraints.deniedTools.length > 0) {
    specs.push({
      kind: "denied_tools",
      value: [...constraints.deniedTools],
      source,
      reason: "the agent names the tools it may not call",
    });
  }

  return Object.freeze(specs);
}

/** The rule that makes a risk level require approval for this agent. */
export function agentApprovalRule(descriptor: AgentDescriptor): PolicyRuleInput | null {
  const levels = descriptor.constraints.approvalRequiredAtRisk;
  if (levels.length === 0) {
    return null;
  }
  return {
    id: `${descriptor.slug}-approval`,
    name: `${descriptor.displayName} requires approval at risk`,
    description: `Risk levels ${levels.join(", ")} need a human approval for this agent, whatever the tool descriptor says.`,
    outcome: "require_approval",
    conditions: Object.freeze([{ field: "riskLevel", operator: "in", value: [...levels] }]),
    constraints: Object.freeze([]),
    priority: 900,
    enabled: true,
    metadata: Object.freeze({ agentId: String(descriptor.id) }),
  };
}

/**
 * The policy set input a descriptor translates to.
 *
 * `defaultOutcome` is `allow`: this set exists to bound work, not to forbid it. A
 * set that denied by default would make every agent unrunnable until somebody
 * wrote a rule saying otherwise, and the tenant's own policy sets are the place
 * where denial belongs.
 */
export function agentConstraintPolicyInput(descriptor: AgentDescriptor): PolicySetInput {
  const rule = agentApprovalRule(descriptor);
  return {
    name: `${AGENT_CONSTRAINT_POLICY_NAME}:${descriptor.slug}`,
    description: `Ceilings declared by agent "${descriptor.slug}" version ${descriptor.version}.`,
    rules: rule === null ? Object.freeze([]) : Object.freeze([rule]),
    defaultOutcome: "allow",
    baselineConstraints: agentConstraintSpecs(descriptor),
    metadata: Object.freeze({ agentId: String(descriptor.id), agentVersion: descriptor.version }),
  };
}

/** True when a descriptor declares anything worth turning into policy. */
export function hasAgentConstraints(descriptor: AgentDescriptor): boolean {
  return agentConstraintSpecs(descriptor).length > 0 || agentApprovalRule(descriptor) !== null;
}

/**
 * Registers one constraint set per descriptor version, and remembers which.
 *
 * Re-registering on every run would grow the engine without bound and would make
 * the policy named in an old execution record resolve to a different set. The key
 * is `identifier:version`, so editing a descriptor's ceilings in the registry (which
 * produces a new descriptor object with the same version) does not silently reuse a
 * stale set — {@link policyIdFor} compares the specs it would register.
 */
export class AgentConstraintPolicies {
  readonly #engine: PolicyEngine;
  readonly #registered = new Map<string, { readonly specs: string; readonly policyId: PolicyId }>();

  constructor(engine: PolicyEngine) {
    this.#engine = engine;
  }

  /** The policy set enforcing this descriptor's ceilings, or `null` when it has none. */
  policyIdFor(descriptor: AgentDescriptor): PolicyId | null {
    if (!hasAgentConstraints(descriptor)) {
      return null;
    }
    const input = agentConstraintPolicyInput(descriptor);
    const fingerprint = JSON.stringify({
      constraints: input.baselineConstraints,
      rules: input.rules,
    });
    const key = `${String(descriptor.id)}:${descriptor.version}`;
    const existing = this.#registered.get(key);
    if (existing !== undefined && existing.specs === fingerprint) {
      return existing.policyId;
    }

    const registered: PolicySet = this.#engine.registerPolicySet(input);
    this.#registered.set(key, { specs: fingerprint, policyId: registered.id });
    return registered.id;
  }

  /** How many constraint sets are registered. */
  get size(): number {
    return this.#registered.size;
  }

  /** Forgets which sets were registered. The engine keeps its own copies. */
  dispose(): void {
    this.#registered.clear();
  }
}

/** Creates a constraint translator over one policy engine. */
export function createAgentConstraintPolicies(engine: PolicyEngine): AgentConstraintPolicies {
  return new AgentConstraintPolicies(engine);
}
