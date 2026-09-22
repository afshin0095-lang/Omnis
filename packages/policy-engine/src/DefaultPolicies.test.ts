import { describe, expect, it } from "vitest";
import { createPolicyId, createTenantId } from "@omnis/types";
import { listConstraint, numericConstraint } from "@omnis/ai-core-types";
import type { PolicySet } from "@omnis/ai-core-types";
import { InMemoryPolicyEngine } from "./InMemoryPolicyEngine.js";
import {
  BASELINE_SAFETY_CONSTRAINTS,
  DEFAULT_POLICY_RULE_IDS,
  defaultPolicySets,
  denyAllPolicySet,
  permissivePolicySet,
  registerDefaultPolicies,
  safetyPolicySet,
} from "./DefaultPolicies.js";
import { AT, evaluationInput } from "./testSupport.js";

function engine(): InMemoryPolicyEngine {
  return new InMemoryPolicyEngine({ clock: () => AT });
}

/** Registers one default set and returns it. */
function registered(
  eng: InMemoryPolicyEngine,
  input: ReturnType<typeof safetyPolicySet>,
): PolicySet {
  return eng.registerPolicySet(input);
}

describe("deny-all", () => {
  it("denies everything and blames no rule", () => {
    const eng = engine();
    const set = registered(eng, denyAllPolicySet());
    for (const action of ["tool.invoke", "model.call", "agent.execute", "content.publish"]) {
      const decision = eng.evaluate(set.id, evaluationInput({ action }));
      expect(decision.outcome, action).toBe("deny");
      expect(decision.decidedByRuleId, action).toBeNull();
      expect(decision.constraints).toEqual([]);
    }
  });

  it("has no rules, so nothing can accidentally permit an action", () => {
    expect(denyAllPolicySet().rules).toEqual([]);
    expect(denyAllPolicySet().defaultOutcome).toBe("deny");
  });
});

describe("safety baseline", () => {
  const eng = engine();
  const set = registered(eng, safetyPolicySet());

  it("requires approval for a high-risk tool nobody has approved", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({ action: "tool.invoke", riskLevel: "high" }),
    );
    expect(decision.outcome).toBe("require_approval");
    expect(decision.decidedByRuleId).toBe(DEFAULT_POLICY_RULE_IDS.approveHighRiskTool);
  });

  it("requires approval for a critical tool with no approval recorded", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({ action: "tool.invoke", riskLevel: "critical" }),
    );
    expect(decision.outcome).toBe("require_approval");
  });

  it("denies a critical tool that was explicitly refused", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({
        action: "tool.invoke",
        riskLevel: "critical",
        attributes: { approved: false },
      }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.decidedByRuleId).toBe(DEFAULT_POLICY_RULE_IDS.denyRefusedCriticalTool);
  });

  it("lets an approved critical tool proceed under the constraints", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({
        action: "tool.invoke",
        riskLevel: "critical",
        attributes: { approved: true },
      }),
    );
    // Approval already happened, so the gate shapes the call instead of asking again.
    expect(decision.outcome).toBe("constrain");
    expect(numericConstraint(decision.constraints, "max_retries")).toBe(2);
  });

  it("does not require approval for a low-risk tool", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({ action: "tool.invoke", riskLevel: "low" }),
    );
    expect(decision.outcome).toBe("constrain");
    expect(decision.decidedByRuleId).toBeNull();
  });

  it("denies production traffic whose tenant is null", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({ action: "model.call", environment: "production", tenantId: null }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.decidedByRuleId).toBe(DEFAULT_POLICY_RULE_IDS.denyProductionWithoutTenant);
  });

  it("allows production traffic that carries a tenant", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({
        action: "model.call",
        environment: "production",
        tenantId: createTenantId(),
      }),
    );
    expect(decision.outcome).toBe("constrain");
    expect(decision.decidedByRuleId).toBe(DEFAULT_POLICY_RULE_IDS.constrainModelCalls);
    expect(numericConstraint(decision.constraints, "max_output_tokens")).toBe(8_192);
    // The rule's ceiling is tighter than the baseline's, and the tighter one is what a reader
    // gets: the most restrictive value always wins.
    expect(numericConstraint(decision.constraints, "max_cost_micro_usd")).toBe(1_000_000);
  });

  it("constrains an agent execution with step, tool and model ceilings", () => {
    const decision = eng.evaluate(set.id, evaluationInput({ action: "agent.execute" }));
    expect(decision.outcome).toBe("constrain");
    expect(numericConstraint(decision.constraints, "max_steps")).toBe(24);
    expect(numericConstraint(decision.constraints, "max_tool_calls")).toBe(32);
    expect(numericConstraint(decision.constraints, "max_model_calls")).toBe(16);
    expect(numericConstraint(decision.constraints, "max_duration_ms")).toBe(300_000);
  });

  it("constrains an action no rule mentions instead of allowing it by silence", () => {
    const decision = eng.evaluate(
      set.id,
      evaluationInput({ action: "content.publish", subject: "agent" }),
    );
    expect(decision.outcome).toBe("constrain");
    expect(decision.decidedByRuleId).toBeNull();
    expect(decision.constraints.map((entry) => entry.source)).toEqual(
      BASELINE_SAFETY_CONSTRAINTS.map((entry) => entry.source),
    );
    expect(listConstraint(decision.constraints, "allowed_models")).toEqual([]);
  });

  it("redacts output by default", () => {
    const decision = eng.evaluate(set.id, evaluationInput({ action: "model.call" }));
    const redact = decision.constraints.find((entry) => entry.kind === "redact_output");
    expect(redact?.value).toBe(true);
  });
});

describe("permissive", () => {
  it("allows every action but still carries the baseline limits", () => {
    const eng = engine();
    const set = registered(eng, permissivePolicySet());
    for (const action of ["tool.invoke", "model.call", "agent.execute", "content.publish"]) {
      const decision = eng.evaluate(set.id, evaluationInput({ action, riskLevel: "critical" }));
      expect(decision.outcome, action).toBe("allow");
      expect(decision.decidedByRuleId, action).toBe(DEFAULT_POLICY_RULE_IDS.permissiveAllowAll);
      expect(numericConstraint(decision.constraints, "max_cost_micro_usd"), action).toBe(5_000_000);
      expect(numericConstraint(decision.constraints, "max_retries"), action).toBe(2);
    }
  });

  it("is a rule rather than an empty allow-by-default set", () => {
    expect(permissivePolicySet().rules).toHaveLength(1);
    expect(permissivePolicySet().defaultOutcome).toBe("constrain");
  });
});

describe("registration", () => {
  it("registers all three sets in a stable order", () => {
    const eng = engine();
    const sets = registerDefaultPolicies(eng);
    expect(sets.map((candidate) => candidate.name)).toEqual([
      "default-deny",
      "safety-baseline",
      "permissive",
    ]);
    expect(eng.size).toBe(3);
    expect(Object.isFrozen(sets)).toBe(true);
  });

  it("honors pinned identifiers", () => {
    const eng = engine();
    const denyAll = createPolicyId();
    const safety = createPolicyId();
    const permissive = createPolicyId();
    const sets = registerDefaultPolicies(eng, { denyAll, safety, permissive });
    expect(sets.map((candidate) => candidate.id)).toEqual([denyAll, safety, permissive]);
    expect(eng.has(safety)).toBe(true);
  });

  it("publishes the three inputs for a caller that wants to adapt them", () => {
    expect(defaultPolicySets().map((candidate) => candidate.name)).toEqual([
      "default-deny",
      "safety-baseline",
      "permissive",
    ]);
  });

  it("gates an action with the safety set and the permissive set together", () => {
    const eng = engine();
    const permissive = eng.registerPolicySet(permissivePolicySet());
    const safety = eng.registerPolicySet(safetyPolicySet());
    const gate = eng.gate(evaluationInput({ action: "tool.invoke", riskLevel: "high" }), [
      permissive.id,
      safety.id,
    ]);
    // A permissive tenant policy cannot widen what the safety set requires.
    expect(gate.outcome).toBe("require_approval");
    expect(gate.decidedByPolicyId).toBe(safety.id);
    expect(gate.decidedByRuleId).toBe(DEFAULT_POLICY_RULE_IDS.approveHighRiskTool);
    expect(gate.reason).toContain("Require approval for high-risk tools");
  });

  it("keeps every rule identifier unique across the default sets", () => {
    const ids = defaultPolicySets().flatMap((candidate) => candidate.rules.map((rule) => rule.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });
});
