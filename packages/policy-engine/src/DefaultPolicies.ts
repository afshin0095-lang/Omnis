/**
 * The policy sets OMNIS ships with.
 *
 * Three sets, each answering a different question an operator asks on day one:
 *
 * - **deny-all** — the default-deny floor. Nothing is permitted until a rule says so. This is
 *   what a fresh deployment should be pointed at, and what a test suite uses to prove the gate
 *   actually gates.
 * - **safety-baseline** — the set a normal deployment runs with. It never allows by silence:
 *   its default outcome is `constrain`, so even an action no rule mentions leaves with spend,
 *   step and retry limits attached. High-risk tool invocations require approval, a critical
 *   tool that was explicitly refused is denied, and production traffic without a tenant is
 *   denied.
 * - **permissive** — a single allow-all rule plus the baseline constraints, for local
 *   development where the interesting failures are elsewhere. It is a rule, not an empty set
 *   with `defaultOutcome: "allow"`, because that shape is indistinguishable from "the rules
 *   failed to load" and {@link assertValidPolicySet} refuses it.
 *
 * Every limit here is data. Nothing in this file executes, calls a provider, or reads a
 * clock; a rule that needs a live fact gets it from the evaluation input's attributes.
 */

import { createPolicyId } from "@omnis/types";
import type { PolicyId, PolicySet } from "@omnis/ai-core-types";
import type { PolicyEngine } from "./PolicyEngine.js";
import type { ConstraintSpecInput, PolicySetInput } from "./policyValidation.js";

/** Rule identifiers, exported so tests and telemetry can name a rule without a literal. */
export const DEFAULT_POLICY_RULE_IDS = Object.freeze({
  permissiveAllowAll: "permissive.allow-all",
  approveHighRiskTool: "safety.approve-high-risk-tool",
  denyRefusedCriticalTool: "safety.deny-refused-critical-tool",
  denyProductionWithoutTenant: "safety.deny-production-without-tenant",
  constrainModelCalls: "safety.constrain-model-calls",
  constrainAgentExecution: "safety.constrain-agent-execution",
} as const);

/**
 * Limits applied to every decision from the safety and permissive sets.
 *
 * These are the numbers that stop a runaway loop from becoming an invoice: a per-execution
 * spend ceiling, a retry ceiling, and output redaction. A rule can tighten any of them —
 * {@link numericConstraint} takes the minimum — but nothing in a policy set can widen them.
 */
export const BASELINE_SAFETY_CONSTRAINTS: readonly ConstraintSpecInput[] = Object.freeze([
  {
    kind: "max_cost_micro_usd",
    value: 5_000_000,
    source: "baseline.safety",
    reason: "per-execution spend ceiling of 5 USD",
  },
  {
    kind: "max_retries",
    value: 2,
    source: "baseline.safety",
    reason: "unbounded retries turn an outage into a bill",
  },
  {
    kind: "max_duration_ms",
    value: 300_000,
    source: "baseline.safety",
    reason: "five minute ceiling on one execution",
  },
  {
    kind: "redact_output",
    value: true,
    source: "baseline.safety",
    reason: "outputs are logged and stored",
  },
]);

/** The default-deny floor: no rules, nothing permitted. */
export function denyAllPolicySet(policyId: PolicyId = createPolicyId()): PolicySetInput {
  return {
    id: policyId,
    name: "default-deny",
    description:
      "Denies every action. The floor a deployment starts from and the set a gate test points at.",
    rules: [],
    defaultOutcome: "deny",
    baselineConstraints: [],
    metadata: { kind: "default", posture: "deny" },
  };
}

/** The safety baseline: constrained by default, approval for risk, denial for the sharp edges. */
export function safetyPolicySet(policyId: PolicyId = createPolicyId()): PolicySetInput {
  return {
    id: policyId,
    name: "safety-baseline",
    description:
      "Constrains everything it does not explicitly shape, requires approval for risky tools, and denies the two cases that must never run unattended.",
    // Constraining rather than allowing by default: an action no rule mentions still leaves
    // with the baseline limits attached, so "we forgot a rule" costs throughput, not control.
    defaultOutcome: "constrain",
    baselineConstraints: BASELINE_SAFETY_CONSTRAINTS,
    metadata: { kind: "default", posture: "constrain" },
    rules: [
      {
        id: DEFAULT_POLICY_RULE_IDS.denyRefusedCriticalTool,
        name: "Deny a critical tool that was explicitly refused",
        description: "A critical-risk tool invocation whose approval flag is present and not true.",
        outcome: "deny",
        priority: 5,
        target: { action: "tool.invoke", minimumRiskLevel: "critical" },
        // Two conditions, ANDed: the flag must exist, and it must not be true. Absent is not
        // the same as refused — an absent flag falls through to the approval rule below, which
        // is the honest reading of "nobody has looked at this yet".
        conditions: [
          { field: "attributes.approved", operator: "exists", value: true },
          { field: "attributes.approved", operator: "ne", value: true },
        ],
      },
      {
        id: DEFAULT_POLICY_RULE_IDS.denyProductionWithoutTenant,
        name: "Deny production traffic with no tenant",
        description: "Unattributable production work cannot be billed, rate-limited or revoked.",
        outcome: "deny",
        priority: 5,
        target: { environment: "production" },
        // `tenantId: null` is a value the context wrote, not an absent field, so the condition
        // compares against null rather than testing existence: a rule that meant "no tenant"
        // and matched "the tenant field was never populated" would be a different rule.
        conditions: [{ field: "tenantId", operator: "eq", value: null }],
      },
      {
        id: DEFAULT_POLICY_RULE_IDS.approveHighRiskTool,
        name: "Require approval for high-risk tools",
        description: "A high or critical risk tool invocation that nobody has approved yet.",
        outcome: "require_approval",
        priority: 10,
        target: { action: "tool.invoke", minimumRiskLevel: "high" },
        // Only when no approval has been recorded. Once an operator has decided — either way —
        // this rule stops applying: `approved: true` proceeds under the constraints below, and
        // `approved: false` is denied by the rule above rather than sent back for approval.
        conditions: [{ field: "attributes.approved", operator: "exists", value: false }],
      },
      {
        id: DEFAULT_POLICY_RULE_IDS.constrainModelCalls,
        name: "Constrain model calls",
        description: "Output, spend and call-count ceilings on a single model invocation.",
        outcome: "constrain",
        priority: 50,
        target: { action: "model.call" },
        constraints: [
          {
            kind: "max_output_tokens",
            value: 8_192,
            source: DEFAULT_POLICY_RULE_IDS.constrainModelCalls,
          },
          {
            kind: "max_cost_micro_usd",
            value: 1_000_000,
            source: DEFAULT_POLICY_RULE_IDS.constrainModelCalls,
          },
          {
            kind: "max_model_calls",
            value: 8,
            source: DEFAULT_POLICY_RULE_IDS.constrainModelCalls,
          },
        ],
      },
      {
        id: DEFAULT_POLICY_RULE_IDS.constrainAgentExecution,
        name: "Constrain agent execution",
        description: "Step, tool and model ceilings on one agent run.",
        outcome: "constrain",
        priority: 50,
        target: { action: "agent.execute" },
        constraints: [
          { kind: "max_steps", value: 24, source: DEFAULT_POLICY_RULE_IDS.constrainAgentExecution },
          {
            kind: "max_tool_calls",
            value: 32,
            source: DEFAULT_POLICY_RULE_IDS.constrainAgentExecution,
          },
          {
            kind: "max_model_calls",
            value: 16,
            source: DEFAULT_POLICY_RULE_IDS.constrainAgentExecution,
          },
        ],
      },
    ],
  };
}

/** Allow everything, within the baseline limits. For local development. */
export function permissivePolicySet(policyId: PolicyId = createPolicyId()): PolicySetInput {
  return {
    id: policyId,
    name: "permissive",
    description:
      "Allows every action, still carrying the baseline spend, retry and redaction limits.",
    defaultOutcome: "constrain",
    baselineConstraints: BASELINE_SAFETY_CONSTRAINTS,
    metadata: { kind: "default", posture: "allow" },
    rules: [
      {
        id: DEFAULT_POLICY_RULE_IDS.permissiveAllowAll,
        name: "Allow all actions",
        description:
          "Development posture: permit everything the baseline constraints already bound.",
        outcome: "allow",
        priority: 1_000,
        target: {},
      },
    ],
  };
}

/** The three default sets, in the order an operator should read them. */
export function defaultPolicySets(): readonly PolicySetInput[] {
  return Object.freeze([denyAllPolicySet(), safetyPolicySet(), permissivePolicySet()]);
}

/** Identifier overrides for {@link registerDefaultPolicies}, so a composition root can pin them. */
export interface DefaultPolicyIds {
  readonly denyAll?: PolicyId;
  readonly safety?: PolicyId;
  readonly permissive?: PolicyId;
}

/**
 * Registers the default sets and returns them in a stable order: deny-all, safety, permissive.
 *
 * Ids may be pinned by the caller. Pinning matters for configuration: a policy id that
 * changes between boots would invalidate every stored decision that references it.
 */
export function registerDefaultPolicies(
  engine: PolicyEngine,
  ids: DefaultPolicyIds = {},
): readonly PolicySet[] {
  const registered = [
    engine.registerPolicySet(denyAllPolicySet(ids.denyAll)),
    engine.registerPolicySet(safetyPolicySet(ids.safety)),
    engine.registerPolicySet(permissivePolicySet(ids.permissive)),
  ];
  return Object.freeze(registered);
}
