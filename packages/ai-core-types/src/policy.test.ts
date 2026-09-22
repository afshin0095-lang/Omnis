import { describe, expect, it } from "vitest";
import { createExecutionId, createPolicyId } from "@omnis/types";
import {
  describePolicyDecision,
  isBlockingOutcome,
  listConstraint,
  mostRestrictiveOutcome,
  numericConstraint,
  POLICY_PRECEDENCE,
  policyOutcomeRank,
  type ConstraintSpec,
  type PolicyDecision,
  type PolicyOutcome,
} from "./index.js";

function constraint(
  kind: ConstraintSpec["kind"],
  value: ConstraintSpec["value"],
  source: string,
): ConstraintSpec {
  return { kind, value, source, reason: null };
}

function decision(
  outcome: PolicyOutcome,
  constraints: readonly ConstraintSpec[] = [],
): PolicyDecision {
  const decidingRule =
    outcome === "deny"
      ? "rule-deny"
      : outcome === "require_approval"
        ? "rule-approval"
        : constraints.length > 0
          ? "rule-constrain"
          : null;
  const action =
    outcome === "deny"
      ? { outcome, reason: "denied", ruleId: "rule-deny", constraints }
      : outcome === "require_approval"
        ? { outcome, reason: "needs a human", ruleId: "rule-approval", constraints }
        : { outcome, constraints };
  return {
    executionId: createExecutionId(),
    policyId: createPolicyId(),
    policyName: "prod-default",
    policyVersion: 3,
    action,
    outcome,
    constraints,
    rulesEvaluated: [],
    decidedByRuleId: decidingRule,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    deterministic: true,
  };
}

describe("policy precedence", () => {
  it("orders outcomes from most to least restrictive", () => {
    expect(POLICY_PRECEDENCE).toEqual(["deny", "require_approval", "constrain", "allow"]);
    expect(policyOutcomeRank("deny")).toBeLessThan(policyOutcomeRank("require_approval"));
    expect(policyOutcomeRank("require_approval")).toBeLessThan(policyOutcomeRank("constrain"));
    expect(policyOutcomeRank("constrain")).toBeLessThan(policyOutcomeRank("allow"));
  });

  it("never lets an allow outweigh a deny, whatever the order", () => {
    expect(mostRestrictiveOutcome(["allow", "allow", "deny"])).toBe("deny");
    expect(mostRestrictiveOutcome(["deny", "allow"])).toBe("deny");
    expect(mostRestrictiveOutcome(["allow", "constrain"])).toBe("constrain");
    expect(mostRestrictiveOutcome(["constrain", "require_approval"])).toBe("require_approval");
    expect(mostRestrictiveOutcome([])).toBe("allow");
  });

  it("is order independent across every permutation of a mixed set", () => {
    const outcomes: PolicyOutcome[] = ["allow", "constrain", "require_approval"];
    const permutations = [
      ["allow", "constrain", "require_approval"],
      ["require_approval", "allow", "constrain"],
      ["constrain", "require_approval", "allow"],
    ] as const;
    for (const permutation of permutations) {
      expect(mostRestrictiveOutcome(permutation), permutation.join(",")).toBe("require_approval");
    }
    expect(outcomes).toHaveLength(3);
  });

  it("marks deny and require_approval as blocking", () => {
    expect(isBlockingOutcome("deny")).toBe(true);
    expect(isBlockingOutcome("require_approval")).toBe(true);
    expect(isBlockingOutcome("constrain")).toBe(false);
    expect(isBlockingOutcome("allow")).toBe(false);
  });
});

describe("constraint readers", () => {
  it("takes the most restrictive numeric value when several rules constrain one kind", () => {
    const constraints = [
      constraint("max_output_tokens", 800, "rule-a"),
      constraint("max_output_tokens", 200, "rule-b"),
      constraint("max_cost_micro_usd", 1_000_000, "rule-c"),
    ];
    expect(numericConstraint(constraints, "max_output_tokens")).toBe(200);
    expect(numericConstraint(constraints, "max_cost_micro_usd")).toBe(1_000_000);
    expect(numericConstraint(constraints, "max_steps")).toBeNull();
  });

  it("ignores a non-numeric value on a numeric constraint", () => {
    expect(numericConstraint([constraint("max_steps", "ten", "rule-a")], "max_steps")).toBeNull();
    expect(
      numericConstraint([constraint("max_steps", Number.NaN, "rule-a")], "max_steps"),
    ).toBeNull();
  });

  it("merges and de-duplicates list constraints", () => {
    const constraints = [
      constraint("allowed_tools", ["search", "fetch"], "rule-a"),
      constraint("allowed_tools", ["fetch", "compute"], "rule-b"),
      constraint("denied_tools", ["shell"], "rule-c"),
    ];
    expect(listConstraint(constraints, "allowed_tools")).toEqual(["search", "fetch", "compute"]);
    expect(listConstraint(constraints, "denied_tools")).toEqual(["shell"]);
    expect(listConstraint(constraints, "allowed_models")).toEqual([]);
  });

  it("skips non-string entries in a list constraint", () => {
    expect(
      listConstraint(
        [constraint("allowed_tools", ["search", 42, null], "rule-a")],
        "allowed_tools",
      ),
    ).toEqual(["search"]);
  });
});

describe("describePolicyDecision", () => {
  it("names the winning rule and the constraint count", () => {
    expect(describePolicyDecision(decision("allow"))).toBe(
      "allow(policy=prod-default@3, rule=default, constraints=0)",
    );
    expect(
      describePolicyDecision(
        decision("constrain", [constraint("max_output_tokens", 200, "rule-constrain")]),
      ),
    ).toBe("constrain(policy=prod-default@3, rule=rule-constrain, constraints=1)");
    expect(describePolicyDecision(decision("deny"))).toBe(
      "deny(policy=prod-default@3, rule=rule-deny, constraints=0)",
    );
    expect(describePolicyDecision(decision("require_approval"))).toContain("rule=rule-approval");
  });
});
