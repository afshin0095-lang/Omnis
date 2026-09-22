/**
 * An agent's ceilings, expressed as policy.
 *
 * The point of these tests is not that a translation produces a list; it is that the
 * ceilings an agent declares are the ceilings the kernel will enforce, with the agent
 * named as their source — and that a preference is never mistaken for a restriction.
 */

import { describe, expect, it } from "vitest";
import { createModelId, createToolId } from "@omnis/types";
import { modelById } from "@omnis/ai-core-types";
import type { AgentDescriptor } from "@omnis/ai-core-types";
import { createPolicyEngine } from "@omnis/policy-engine";
import {
  AGENT_CONSTRAINT_POLICY_NAME,
  agentApprovalRule,
  agentConstraintPolicyInput,
  agentConstraintSource,
  agentConstraintSpecs,
  createAgentConstraintPolicies,
  hasAgentConstraints,
} from "./AgentConstraints.js";
import { createAgentRegistry } from "./AgentRegistry.js";
import { AT, registerAgent } from "./testSupport.js";

function agent(overrides: Parameters<typeof registerAgent>[1] = {}): AgentDescriptor {
  return registerAgent(createAgentRegistry(), { slug: "assistant", ...overrides });
}

describe("translating ceilings into constraints", () => {
  it("produces nothing for an unconstrained agent", () => {
    expect(agentConstraintSpecs(agent())).toEqual([]);
    expect(hasAgentConstraints(agent())).toBe(false);
    expect(agentApprovalRule(agent())).toBeNull();
  });

  it("turns every numeric ceiling into the matching constraint kind", () => {
    const specs = agentConstraintSpecs(
      agent({
        constraints: {
          maxSteps: 4,
          maxModelCalls: 8,
          maxToolCalls: 6,
          maxDurationMs: 30_000,
          maxCostMicroUsd: 2_500,
          maxRetriesPerStep: 2,
        },
      }),
    );

    expect(specs.map((spec) => [spec.kind, spec.value])).toEqual([
      ["max_steps", 4],
      ["max_model_calls", 8],
      ["max_tool_calls", 6],
      ["max_duration_ms", 30_000],
      ["max_cost_micro_usd", 2_500],
      ["max_retries", 2],
    ]);
  });

  it("names the agent and its version as the source of every constraint", () => {
    const descriptor = agent({
      slug: "brief-writer",
      version: "3.1.0",
      constraints: { maxSteps: 2 },
    });
    expect(agentConstraintSource(descriptor)).toBe("agent:brief-writer@3.1.0");
    for (const spec of agentConstraintSpecs(descriptor)) {
      expect(spec.source).toBe("agent:brief-writer@3.1.0");
      expect(typeof spec.reason).toBe("string");
    }
  });

  it("turns tool lists into allowed and denied constraints, and only when they say something", () => {
    const allowed = createToolId();
    const denied = createToolId();
    const both = agentConstraintSpecs(
      agent({ constraints: { allowedTools: [allowed], deniedTools: [denied] } }),
    );
    expect(both.map((spec) => [spec.kind, spec.value])).toEqual([
      ["allowed_tools", [String(allowed)]],
      ["denied_tools", [String(denied)]],
    ]);

    // An empty allowed list means "any tool its policy allows", not "no tools".
    expect(
      agentConstraintSpecs(agent({ constraints: { allowedTools: [], deniedTools: [] } })),
    ).toEqual([]);
  });

  it("keeps a model preference out of policy, because a preference is not a restriction", () => {
    const specs = agentConstraintSpecs(
      agent({ constraints: { preferredModels: [modelById(createModelId())] } }),
    );
    expect(specs).toEqual([]);
    expect(specs.map((spec) => spec.kind)).not.toContain("allowed_models");
  });

  it("turns approval-required risk levels into a rule rather than a constraint", () => {
    const rule = agentApprovalRule(
      agent({ constraints: { approvalRequiredAtRisk: ["high", "critical"] } }),
    );
    expect(rule).not.toBeNull();
    expect(rule?.outcome).toBe("require_approval");
    expect(rule?.conditions).toEqual([
      { field: "riskLevel", operator: "in", value: ["high", "critical"] },
    ]);
    expect(hasAgentConstraints(agent({ constraints: { approvalRequiredAtRisk: ["high"] } }))).toBe(
      true,
    );
  });
});

describe("the policy set a descriptor becomes", () => {
  it("allows by default, because the set exists to bound work rather than forbid it", () => {
    const input = agentConstraintPolicyInput(
      agent({ slug: "assistant", constraints: { maxSteps: 3 } }),
    );
    expect(input.defaultOutcome).toBe("allow");
    expect(input.name).toBe(`${AGENT_CONSTRAINT_POLICY_NAME}:assistant`);
    expect(input.baselineConstraints).toHaveLength(1);
    expect(input.metadata).toMatchObject({ agentVersion: "1.0.0" });
  });

  it("registers, and the engine then enforces the ceiling", () => {
    const engine = createPolicyEngine({ clock: () => AT });
    const descriptor = agent({ constraints: { maxSteps: 3, maxCostMicroUsd: 1_000 } });
    const policies = createAgentConstraintPolicies(engine);
    const policyId = policies.policyIdFor(descriptor);

    expect(policyId).not.toBeNull();
    const set = engine.requirePolicySet(policyId as never);
    expect(set.baselineConstraints.map((constraint) => constraint.kind)).toEqual([
      "max_steps",
      "max_cost_micro_usd",
    ]);
    expect(set.defaultOutcome).toBe("allow");
  });

  it("returns nothing to register for an unconstrained agent", () => {
    const engine = createPolicyEngine({ clock: () => AT });
    const policies = createAgentConstraintPolicies(engine);
    expect(policies.policyIdFor(agent())).toBeNull();
    expect(policies.size).toBe(0);
    expect(engine.size).toBe(0);
  });

  it("registers once per descriptor version, not once per run", () => {
    const engine = createPolicyEngine({ clock: () => AT });
    const policies = createAgentConstraintPolicies(engine);
    const descriptor = agent({ constraints: { maxSteps: 3 } });

    const first = policies.policyIdFor(descriptor);
    const second = policies.policyIdFor(descriptor);
    expect(second).toBe(first);
    expect(policies.size).toBe(1);
    expect(engine.size).toBe(1);
  });

  it("registers again when the ceilings change, so an old set is never reused for new limits", () => {
    const engine = createPolicyEngine({ clock: () => AT });
    const policies = createAgentConstraintPolicies(engine);
    const before = policies.policyIdFor(agent({ constraints: { maxSteps: 3 } }));

    // Same identifier and version, different ceilings: a caller edited the descriptor.
    const registry = createAgentRegistry();
    const edited = registerAgent(registry, { slug: "assistant", constraints: { maxSteps: 9 } });
    const after = policies.policyIdFor(edited);

    expect(after).not.toBe(before);
    expect(engine.requirePolicySet(after as never).baselineConstraints[0]?.value).toBe(9);
  });

  it("forgets what it registered on disposal, and can register again afterwards", () => {
    const engine = createPolicyEngine({ clock: () => AT });
    const policies = createAgentConstraintPolicies(engine);
    const descriptor = agent({ constraints: { maxSteps: 3 } });
    policies.policyIdFor(descriptor);
    expect(policies.size).toBe(1);

    policies.dispose();
    expect(policies.size).toBe(0);
    // The engine still holds the first set, so re-registering under the same name
    // produces a new version rather than a conflict.
    expect(policies.policyIdFor(descriptor)).not.toBeNull();
  });
});
