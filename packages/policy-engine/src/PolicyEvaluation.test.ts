import { describe, expect, it } from "vitest";
import { createTenantId } from "@omnis/types";
import { createExecutionContext } from "@omnis/execution-context";
import { MATCH_ALL_TARGET, numericConstraint } from "@omnis/ai-core-types";
import type { PolicyCondition, PolicyRule } from "@omnis/ai-core-types";
import { PolicyViolationError } from "@omnis/errors";
import {
  assertDecisionPermitted,
  compareJsonValues,
  evaluateCondition,
  evaluatePolicySet,
  evaluateRule,
  evaluationInputFromContext,
  jsonEquals,
  matchesTarget,
  mergeConstraints,
  rankRules,
  resolveField,
  targetMismatch,
  toApprovalRequest,
} from "./PolicyEvaluation.js";
import { AT, constraint, evaluationInput, FIXTURE_IDS, policySet, rule } from "./testSupport.js";

function condition(
  field: string,
  operator: PolicyCondition["operator"],
  value: PolicyCondition["value"],
): PolicyCondition {
  return { field, operator, value };
}

describe("resolveField", () => {
  it("reads the known top-level fields by name", () => {
    const input = evaluationInput();
    expect(resolveField(input, "action")).toBe("tool.invoke");
    expect(resolveField(input, "riskLevel")).toBe("low");
    expect(resolveField(input, "tenantId")).toBe(FIXTURE_IDS.tenantId);
    expect(resolveField(input, "modelId")).toBeNull();
  });

  it("reads attributes with and without the prefix", () => {
    const input = evaluationInput({ attributes: { request: { channel: "web", tokens: 12 } } });
    expect(resolveField(input, "request.channel")).toBe("web");
    expect(resolveField(input, "attributes.request.channel")).toBe("web");
    expect(resolveField(input, "request.tokens")).toBe(12);
  });

  it("returns undefined for anything absent", () => {
    expect(resolveField(evaluationInput(), "nope")).toBeUndefined();
    expect(resolveField(evaluationInput({ attributes: { a: { b: 1 } } }), "a.c")).toBeUndefined();
  });

  it("refuses to traverse the prototype chain", () => {
    // A condition field is caller-supplied configuration. If `constructor` resolved, a rule
    // could be written against something no record ever set.
    const input = evaluationInput({ attributes: { nested: {} } });
    expect(resolveField(input, "__proto__")).toBeUndefined();
    expect(resolveField(input, "nested.constructor")).toBeUndefined();
    expect(resolveField(input, "nested.__proto__.polluted")).toBeUndefined();
  });
});

describe("jsonEquals", () => {
  it("compares primitives, arrays and objects structurally", () => {
    expect(jsonEquals(1, 1)).toBe(true);
    expect(jsonEquals("a", "a")).toBe(true);
    expect(jsonEquals(null, null)).toBe(true);
    expect(jsonEquals([1, "a", null], [1, "a", null])).toBe(true);
    expect(jsonEquals({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
  });

  it("does not coerce", () => {
    expect(jsonEquals(1, "1")).toBe(false);
    expect(jsonEquals(0, false)).toBe(false);
    expect(jsonEquals(null, false)).toBe(false);
    expect(jsonEquals([], {})).toBe(false);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("compareJsonValues", () => {
  it("orders numbers and strings", () => {
    expect(compareJsonValues(1, 2)).toBe(-1);
    expect(compareJsonValues(2, 2)).toBe(0);
    expect(compareJsonValues("2026-01-02", "2026-01-01")).toBe(1);
  });

  it("refuses to order mixed or non-numeric types", () => {
    expect(compareJsonValues(1, "1")).toBeNull();
    expect(compareJsonValues(true, false)).toBeNull();
    expect(compareJsonValues(null, null)).toBeNull();
    expect(compareJsonValues([1], [2])).toBeNull();
    expect(compareJsonValues(Number.NaN, 1)).toBeNull();
    expect(compareJsonValues(Number.POSITIVE_INFINITY, 1)).toBeNull();
  });
});

describe("evaluateCondition", () => {
  const input = evaluationInput({
    attributes: { tokens: 500, tags: ["a", "b"], nested: { deep: true }, note: "hello" },
  });

  it("evaluates equality and inequality", () => {
    expect(evaluateCondition(input, condition("attributes.tokens", "eq", 500))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.tokens", "eq", 501))).toBe(false);
    expect(evaluateCondition(input, condition("attributes.tokens", "ne", 501))).toBe(true);
    expect(evaluateCondition(input, condition("riskLevel", "eq", "low"))).toBe(true);
  });

  it("evaluates membership", () => {
    expect(evaluateCondition(input, condition("riskLevel", "in", ["low", "medium"]))).toBe(true);
    expect(evaluateCondition(input, condition("riskLevel", "in", ["high"]))).toBe(false);
    expect(evaluateCondition(input, condition("riskLevel", "not_in", ["high", "critical"]))).toBe(
      true,
    );
    // A non-array operand is a broken rule, and a broken rule must not match.
    expect(evaluateCondition(input, condition("riskLevel", "in", "low"))).toBe(false);
    expect(evaluateCondition(input, condition("riskLevel", "not_in", "high"))).toBe(false);
  });

  it("evaluates ordering", () => {
    expect(evaluateCondition(input, condition("attributes.tokens", "gt", 499))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.tokens", "gte", 500))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.tokens", "lt", 500))).toBe(false);
    expect(evaluateCondition(input, condition("attributes.tokens", "lte", 500))).toBe(true);
    // Ordering across types is a coercion, and coercions are refused.
    expect(evaluateCondition(input, condition("attributes.tokens", "gt", "499"))).toBe(false);
    expect(evaluateCondition(input, condition("attributes.nested.deep", "gt", 0))).toBe(false);
  });

  it("evaluates containment for arrays and strings", () => {
    expect(evaluateCondition(input, condition("attributes.tags", "contains", "a"))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.tags", "contains", "c"))).toBe(false);
    expect(evaluateCondition(input, condition("attributes.note", "contains", "ell"))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.tokens", "contains", 5))).toBe(false);
  });

  it("evaluates existence in both directions", () => {
    expect(evaluateCondition(input, condition("attributes.tokens", "exists", true))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.tokens", "exists", false))).toBe(false);
    expect(evaluateCondition(input, condition("attributes.missing", "exists", false))).toBe(true);
    expect(evaluateCondition(input, condition("attributes.missing", "exists", true))).toBe(false);
    // A null field exists: it was written, and its value is null.
    expect(
      evaluateCondition(evaluationInput({ modelId: null }), condition("modelId", "exists", true)),
    ).toBe(true);
  });

  it("fails closed on a missing field for every comparison operator", () => {
    for (const operator of [
      "eq",
      "ne",
      "in",
      "not_in",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
    ] as const) {
      expect(
        evaluateCondition(input, condition("attributes.absent", operator, "anything")),
        operator,
      ).toBe(false);
    }
  });
});

describe("target matching", () => {
  const input = evaluationInput();

  it("matches everything with the match-all target", () => {
    expect(matchesTarget(input, MATCH_ALL_TARGET)).toBe(true);
    expect(targetMismatch(input, MATCH_ALL_TARGET)).toBeNull();
  });

  it("filters on each dimension", () => {
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, action: "tool.invoke" })).toBe(true);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, action: "model.call" })).toBe(false);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, subject: "agent" })).toBe(true);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, resource: "search" })).toBe(true);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, environment: "production" })).toBe(false);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, tenantId: FIXTURE_IDS.tenantId })).toBe(
      true,
    );
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, toolId: FIXTURE_IDS.toolId })).toBe(true);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, modelId: null })).toBe(true);
  });

  it("treats a minimum risk level as inclusive", () => {
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, minimumRiskLevel: "low" })).toBe(true);
    expect(matchesTarget(input, { ...MATCH_ALL_TARGET, minimumRiskLevel: "medium" })).toBe(false);
    const critical = evaluationInput({ riskLevel: "critical" });
    expect(matchesTarget(critical, { ...MATCH_ALL_TARGET, minimumRiskLevel: "high" })).toBe(true);
    expect(matchesTarget(critical, { ...MATCH_ALL_TARGET, minimumRiskLevel: "critical" })).toBe(
      true,
    );
  });

  it("reports which dimension failed", () => {
    // The reason names the field and the value the input actually carried.
    expect(targetMismatch(input, { ...MATCH_ALL_TARGET, action: "model.call" })).toBe(
      "action=tool.invoke",
    );
    expect(
      targetMismatch(evaluationInput({ riskLevel: "low" }), {
        ...MATCH_ALL_TARGET,
        minimumRiskLevel: "high",
      }),
    ).toBe("riskLevel=low<high");
    // Identifiers are not echoed: a mismatch reason ends up in a decision record.
    expect(targetMismatch(input, { ...MATCH_ALL_TARGET, tenantId: createTenantId() })).toBe(
      "tenantId",
    );
  });
});

describe("evaluateRule", () => {
  it("reports a disabled rule as a non-match without evaluating it", () => {
    const evaluation = evaluateRule(
      evaluationInput(),
      rule({ enabled: false, conditions: [condition("nope", "eq", 1)] }),
    );
    expect(evaluation.matched).toBe(false);
    expect(evaluation.reason).toBe("disabled");
    expect(evaluation.outcome).toBeNull();
  });

  it("requires every condition to hold", () => {
    const matching = rule({
      conditions: [condition("riskLevel", "eq", "low"), condition("attributes.tokens", "lt", 1000)],
    });
    const input = evaluationInput({ attributes: { tokens: 10 } });
    expect(evaluateRule(input, matching).matched).toBe(true);

    const failing = rule({
      conditions: [condition("riskLevel", "eq", "low"), condition("attributes.tokens", "gt", 1000)],
    });
    const evaluation = evaluateRule(input, failing);
    expect(evaluation.matched).toBe(false);
    expect(evaluation.reason).toContain("attributes.tokens");
  });

  it("names the matched rule's outcome", () => {
    const evaluation = evaluateRule(
      evaluationInput(),
      rule({ id: "r1", name: "R1", outcome: "deny" }),
    );
    expect(evaluation).toEqual({
      ruleId: "r1",
      ruleName: "R1",
      matched: true,
      outcome: "deny",
      reason: null,
    });
  });
});

describe("rankRules and mergeConstraints", () => {
  it("orders rules by ascending priority then by id", () => {
    const rules = [
      rule({ id: "b", priority: 10 }),
      rule({ id: "a", priority: 10 }),
      rule({ id: "c", priority: 1 }),
    ];
    expect(rankRules(rules).map((candidate) => candidate.id)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const rules = [rule({ id: "b", priority: 10 }), rule({ id: "a", priority: 1 })];
    rankRules(rules);
    expect(rules.map((candidate) => candidate.id)).toEqual(["b", "a"]);
  });

  it("puts baseline constraints first and keeps every rule's contribution", () => {
    const baseline = [constraint("max_retries", 3, "baseline")];
    const rules = [
      rule({ id: "b", priority: 10, constraints: [constraint("max_retries", 5, "b")] }),
      rule({ id: "a", priority: 1, constraints: [constraint("max_output_tokens", 100, "a")] }),
    ];
    const merged = mergeConstraints(baseline, rules);
    expect(merged.map((entry) => entry.source)).toEqual(["baseline", "a", "b"]);
    // Two rules limiting the same dimension both survive; the reader takes the minimum.
    expect(numericConstraint(merged, "max_retries")).toBe(3);
    expect(Object.isFrozen(merged)).toBe(true);
  });
});

describe("evaluatePolicySet", () => {
  it("applies the set's default outcome when nothing matches", () => {
    const deny = evaluatePolicySet(policySet({ defaultOutcome: "deny" }), evaluationInput(), {
      evaluatedAt: AT,
    });
    expect(deny.outcome).toBe("deny");
    expect(deny.decidedByRuleId).toBeNull();
    if (deny.action.outcome === "deny") {
      expect(deny.action.reason).toContain("no rule matched");
      expect(deny.action.ruleId).toBe("");
    } else {
      expect.unreachable("a deny decision carries a deny action");
    }

    const allow = evaluatePolicySet(policySet({ defaultOutcome: "allow" }), evaluationInput(), {
      evaluatedAt: AT,
    });
    expect(allow.outcome).toBe("allow");
    expect(allow.action.outcome).toBe("allow");
  });

  it("lets the most restrictive matched outcome win, whatever the rule order", () => {
    const rules: readonly PolicyRule[] = [
      rule({ id: "allow-it", outcome: "allow", priority: 1 }),
      rule({ id: "constrain-it", outcome: "constrain", priority: 2 }),
      rule({ id: "approve-it", outcome: "require_approval", priority: 3 }),
      rule({ id: "deny-it", outcome: "deny", priority: 4 }),
    ];
    const set = policySet({ rules, defaultOutcome: "allow" });
    // The deny rule has the lowest priority number of the blocking rules and still loses
    // nothing: precedence is a property of the outcome, not of the ordering.
    const decision = evaluatePolicySet(set, evaluationInput(), { evaluatedAt: AT });
    expect(decision.outcome).toBe("deny");
    expect(decision.decidedByRuleId).toBe("deny-it");

    const withoutDeny = policySet({ rules: rules.slice(0, 3), defaultOutcome: "allow" });
    expect(evaluatePolicySet(withoutDeny, evaluationInput(), { evaluatedAt: AT }).outcome).toBe(
      "require_approval",
    );

    const withoutApproval = policySet({ rules: rules.slice(0, 2), defaultOutcome: "allow" });
    expect(evaluatePolicySet(withoutApproval, evaluationInput(), { evaluatedAt: AT }).outcome).toBe(
      "constrain",
    );

    const onlyAllow = policySet({ rules: [rules[0] as PolicyRule], defaultOutcome: "deny" });
    expect(evaluatePolicySet(onlyAllow, evaluationInput(), { evaluatedAt: AT }).outcome).toBe(
      "allow",
    );
  });

  it("names the highest-priority rule among equals, tie-broken by id", () => {
    const set = policySet({
      defaultOutcome: "allow",
      rules: [
        rule({ id: "zzz", outcome: "constrain", priority: 5 }),
        rule({ id: "aaa", outcome: "constrain", priority: 5 }),
        rule({ id: "mmm", outcome: "constrain", priority: 1 }),
      ],
    });
    expect(evaluatePolicySet(set, evaluationInput(), { evaluatedAt: AT }).decidedByRuleId).toBe(
      "mmm",
    );

    const tied = policySet({
      defaultOutcome: "allow",
      rules: [
        rule({ id: "zzz", outcome: "constrain", priority: 5 }),
        rule({ id: "aaa", outcome: "constrain", priority: 5 }),
      ],
    });
    expect(evaluatePolicySet(tied, evaluationInput(), { evaluatedAt: AT }).decidedByRuleId).toBe(
      "aaa",
    );
  });

  it("collects baseline constraints plus every matched rule's", () => {
    const set = policySet({
      defaultOutcome: "allow",
      baselineConstraints: [constraint("max_retries", 2, "baseline")],
      rules: [
        rule({
          id: "a",
          outcome: "constrain",
          constraints: [constraint("max_output_tokens", 100, "a")],
        }),
        rule({ id: "b", outcome: "constrain", constraints: [constraint("max_steps", 4, "b")] }),
        rule({
          id: "c",
          outcome: "allow",
          enabled: false,
          constraints: [constraint("max_steps", 99, "c")],
        }),
      ],
    });
    const decision = evaluatePolicySet(set, evaluationInput(), { evaluatedAt: AT });
    expect(decision.constraints.map((entry) => entry.source)).toEqual(["baseline", "a", "b"]);
    expect(numericConstraint(decision.constraints, "max_steps")).toBe(4);
  });

  it("keeps constraints on a denial, so an audit row shows what would have applied", () => {
    const set = policySet({
      defaultOutcome: "allow",
      baselineConstraints: [constraint("max_retries", 2, "baseline")],
      rules: [rule({ id: "deny-it", outcome: "deny" })],
    });
    const decision = evaluatePolicySet(set, evaluationInput(), { evaluatedAt: AT });
    expect(decision.outcome).toBe("deny");
    expect(decision.constraints.map((entry) => entry.source)).toEqual(["baseline"]);
  });

  it("records every evaluated rule, and only the enabled ones by default", () => {
    const set = policySet({
      defaultOutcome: "allow",
      rules: [
        rule({ id: "matches", outcome: "allow" }),
        rule({
          id: "misses",
          outcome: "deny",
          target: { ...MATCH_ALL_TARGET, action: "model.call" },
        }),
        rule({ id: "off", outcome: "deny", enabled: false }),
      ],
    });
    const decision = evaluatePolicySet(set, evaluationInput(), { evaluatedAt: AT });
    expect(decision.rulesEvaluated.map((entry) => entry.ruleId)).toEqual(["matches", "misses"]);
    expect(decision.rulesEvaluated[1]?.reason).toBe("action=tool.invoke");

    const verbose = evaluatePolicySet(set, evaluationInput(), {
      evaluatedAt: AT,
      includeDisabledRules: true,
    });
    expect(verbose.rulesEvaluated.map((entry) => entry.ruleId)).toEqual([
      "matches",
      "misses",
      "off",
    ]);
  });

  it("produces an immutable, JSON-safe decision carrying the set's version", () => {
    const set = policySet({
      version: 7,
      name: "governance",
      rules: [rule({ id: "a", outcome: "constrain" })],
    });
    const decision = evaluatePolicySet(set, evaluationInput(), { evaluatedAt: AT });
    expect(decision.policyVersion).toBe(7);
    expect(decision.policyName).toBe("governance");
    expect(decision.evaluatedAt).toBe(AT);
    expect(decision.deterministic).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.constraints)).toBe(true);
    expect(Object.isFrozen(decision.rulesEvaluated)).toBe(true);
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it("is deterministic: the same set and input give an identical decision", () => {
    const set = policySet({
      rules: [
        rule({ id: "a", outcome: "constrain", constraints: [constraint("max_steps", 3, "a")] }),
      ],
    });
    const input = evaluationInput({ attributes: { tokens: 5 } });
    const first = evaluatePolicySet(set, input, { evaluatedAt: AT });
    const second = evaluatePolicySet(set, input, { evaluatedAt: AT });
    expect(second).toEqual(first);
  });
});

describe("assertDecisionPermitted", () => {
  it("returns quietly for allow and constrain", () => {
    expect(() =>
      assertDecisionPermitted(
        evaluatePolicySet(policySet({ defaultOutcome: "allow" }), evaluationInput(), {
          evaluatedAt: AT,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertDecisionPermitted(
        evaluatePolicySet(policySet({ defaultOutcome: "constrain" }), evaluationInput(), {
          evaluatedAt: AT,
        }),
      ),
    ).not.toThrow();
  });

  it("throws a non-retryable policy violation on a denial", () => {
    const decision = evaluatePolicySet(
      policySet({
        rules: [rule({ id: "no", name: "No", outcome: "deny", description: "because" })],
      }),
      evaluationInput(),
      {
        evaluatedAt: AT,
      },
    );
    try {
      assertDecisionPermitted(decision);
      expect.unreachable("a denial must throw");
    } catch (error) {
      const violation = error as PolicyViolationError;
      expect(violation).toBeInstanceOf(PolicyViolationError);
      expect(violation.code).toBe("policy_violation");
      expect(violation.retryable).toBe(false);
      expect(violation.requiresApproval).toBe(false);
      expect(violation.rule).toBe("no");
      expect(violation.message).toContain("because");
      expect(violation.policyId).toBe(FIXTURE_IDS.policyId);
    }
  });

  it("marks an approval gate as requiring approval", () => {
    const decision = evaluatePolicySet(
      policySet({
        rules: [
          rule({
            id: "ask",
            name: "Ask",
            outcome: "require_approval",
            description: "human needed",
          }),
        ],
      }),
      evaluationInput(),
      { evaluatedAt: AT },
    );
    try {
      assertDecisionPermitted(decision, "tenant-owner");
      expect.unreachable("an approval gate must throw");
    } catch (error) {
      const violation = error as PolicyViolationError;
      expect(violation.requiresApproval).toBe(true);
      expect(violation.metadata["requiredApprover"]).toBe("tenant-owner");
    }
  });
});

describe("toApprovalRequest", () => {
  it("builds a request from an approval decision", () => {
    const decision = evaluatePolicySet(
      policySet({
        rules: [
          rule({
            id: "ask",
            name: "Ask",
            outcome: "require_approval",
            description: "human needed",
          }),
        ],
      }),
      evaluationInput(),
      { evaluatedAt: AT },
    );
    const request = toApprovalRequest(decision, "operator", AT);
    expect(request).not.toBeNull();
    expect(request?.ruleId).toBe("ask");
    expect(request?.reason).toContain("human needed");
    expect(request?.requiredApprover).toBe("operator");
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("returns null for any other outcome", () => {
    // A denial is not an approval request: there is nothing to approve, so the caller gets
    // null and reports the denial instead of opening an approval that can never be granted.
    expect(
      toApprovalRequest(
        evaluatePolicySet(policySet({ defaultOutcome: "deny" }), evaluationInput(), {
          evaluatedAt: AT,
        }),
        "operator",
        AT,
      ),
    ).toBeNull();
    expect(
      toApprovalRequest(
        evaluatePolicySet(policySet({ defaultOutcome: "allow" }), evaluationInput(), {
          evaluatedAt: AT,
        }),
        "operator",
        AT,
      ),
    ).toBeNull();
    expect(
      toApprovalRequest(
        evaluatePolicySet(policySet({ defaultOutcome: "constrain" }), evaluationInput(), {
          evaluatedAt: AT,
        }),
        "operator",
        AT,
      ),
    ).toBeNull();
  });
});

describe("evaluationInputFromContext", () => {
  it("takes identity from the context and facts from the request", () => {
    const context = createExecutionContext({
      tenantId: FIXTURE_IDS.tenantId,
      agentId: FIXTURE_IDS.agentId,
      metadata: { environment: "production", region: "eu" },
    });
    const input = evaluationInputFromContext(context, {
      action: "tool.invoke",
      subject: "agent",
      resource: "publish",
      riskLevel: "high",
      toolId: FIXTURE_IDS.toolId,
      attributes: { approved: false },
    });
    expect(input.executionId).toBe(context.executionId);
    expect(input.tenantId).toBe(FIXTURE_IDS.tenantId);
    expect(input.agentId).toBe(FIXTURE_IDS.agentId);
    expect(input.environment).toBe("production");
    expect(input.attributes["region"]).toBe("eu");
    expect(input.attributes["approved"]).toBe(false);
  });

  it("defaults the risk level to low and absent facts to null", () => {
    const context = createExecutionContext({});
    const input = evaluationInputFromContext(context, {
      action: "model.call",
      subject: "orchestrator",
    });
    expect(input.riskLevel).toBe("low");
    expect(input.environment).toBeNull();
    expect(input.resource).toBeNull();
    expect(input.tenantId).toBeNull();
    expect(input.modelId).toBeNull();
  });

  it("sanitizes attributes so a decision's inputs are always JSON-safe", () => {
    const context = createExecutionContext({
      metadata: { apiKey: "AIza" + "A".repeat(35), ok: true },
    });
    const input = evaluationInputFromContext(context, { action: "tool.invoke", subject: "agent" });
    expect(String(input.attributes["apiKey"])).not.toContain("AIza");
    expect(input.attributes["ok"]).toBe(true);
    expect(JSON.parse(JSON.stringify(input.attributes))).toEqual(input.attributes);
  });
});
