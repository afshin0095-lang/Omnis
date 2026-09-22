/**
 * Fixtures for this package's suites.
 *
 * Policy evaluation is deterministic by contract, so a fixture here is a *complete* input:
 * fixed identifiers, a fixed timestamp, and no clock. Anything a test does not set explicitly
 * is a value the evaluator would otherwise have to invent, and inventing values is exactly
 * what the contract forbids.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import {
  createAgentId,
  createExecutionId,
  createPolicyId,
  createTenantId,
  createToolId,
} from "@omnis/types";
import type {
  ConstraintKind,
  ConstraintSpec,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyRule,
  PolicySet,
} from "@omnis/ai-core-types";
import { MATCH_ALL_TARGET } from "@omnis/ai-core-types";
import type { PolicyRuleInput, PolicySetInput } from "./policyValidation.js";

/** The timestamp every fixture uses. */
export const AT = "2026-03-01T12:00:00.000Z";

/** Identifiers reused across suites, so assertions can name them. */
export const FIXTURE_IDS = {
  executionId: createExecutionId(),
  policyId: createPolicyId(),
  tenantId: createTenantId(),
  agentId: createAgentId(),
  toolId: createToolId(),
} as const;

/** Builds a complete evaluation input. */
export function evaluationInput(
  overrides: Partial<PolicyEvaluationInput> = {},
): PolicyEvaluationInput {
  return {
    executionId: FIXTURE_IDS.executionId,
    action: "tool.invoke",
    subject: "agent",
    resource: "search",
    riskLevel: "low",
    environment: "test",
    tenantId: FIXTURE_IDS.tenantId,
    agentId: FIXTURE_IDS.agentId,
    toolId: FIXTURE_IDS.toolId,
    modelId: null,
    providerId: null,
    budgetId: null,
    attributes: {},
    ...overrides,
  };
}

/** Builds a constraint. */
export function constraint(
  kind: ConstraintKind,
  value: ConstraintSpec["value"],
  source: string,
  reason: string | null = null,
): ConstraintSpec {
  return { kind, value, source, reason };
}

/** Builds a rule with every field present. */
export function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "rule.default",
    name: "Default rule",
    description: "A rule built by the fixture.",
    outcome: "allow",
    target: MATCH_ALL_TARGET,
    conditions: [],
    constraints: [],
    priority: 100,
    enabled: true,
    metadata: {},
    ...overrides,
  };
}

/** Builds a policy set with every field present. */
export function policySet(overrides: Partial<PolicySet> = {}): PolicySet {
  return {
    id: FIXTURE_IDS.policyId,
    name: "fixture-set",
    description: "A policy set built by the fixture.",
    version: 1,
    rules: [],
    defaultOutcome: "deny",
    baselineConstraints: [],
    metadata: {},
    createdAt: AT,
    ...overrides,
  };
}

/** Builds a registration input for the engine suites. */
export function policySetInput(overrides: Partial<PolicySetInput> = {}): PolicySetInput {
  return {
    name: "fixture-input",
    description: "A registration input built by the fixture.",
    rules: [],
    defaultOutcome: "deny",
    createdAt: AT,
    ...overrides,
  };
}

/** Builds a rule registration input. */
export function ruleInput(overrides: Partial<PolicyRuleInput> = {}): PolicyRuleInput {
  return {
    id: "rule.input",
    name: "Input rule",
    outcome: "allow",
    ...overrides,
  };
}

/** A decision, for suites that only need the shape. */
export function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    executionId: FIXTURE_IDS.executionId,
    policyId: FIXTURE_IDS.policyId,
    policyName: "fixture-set",
    policyVersion: 1,
    action: { outcome: "deny", reason: "fixture denial", ruleId: "rule.default", constraints: [] },
    outcome: "deny",
    constraints: [],
    rulesEvaluated: [],
    decidedByRuleId: "rule.default",
    evaluatedAt: AT,
    deterministic: true,
    ...overrides,
  };
}
