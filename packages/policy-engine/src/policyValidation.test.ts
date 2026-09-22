import { describe, expect, it } from "vitest";
import { AI_CORE_CONTRACT_VERSION, MATCH_ALL_TARGET, MAX_POLICY_RULES } from "@omnis/ai-core-types";
import { tryValidate, validate } from "@omnis/validation";
import { ValidationError } from "@omnis/errors";
import { InMemoryPolicyEngine } from "./InMemoryPolicyEngine.js";
import { evaluatePolicySet } from "./PolicyEvaluation.js";
import {
  constraintKindSchema,
  isConstraintKind,
  isPolicyDecision,
  isPolicyOperator,
  isToolRiskLevel,
  MAX_CONDITION_FIELD_LENGTH,
  MAX_RULE_CONDITIONS,
  MAX_RULE_CONSTRAINTS,
  policyConditionSchema,
  POLICY_DECISION_CONTRACT,
  policyDecisionSchema,
  policyEvaluationInputSchema,
  POLICY_EVALUATION_INPUT_CONTRACT,
  policyOperatorSchema,
  policyOutcomeSchema,
  policyRuleIdSchema,
  POLICY_RULE_CONTRACT,
  policyRuleTargetSchema,
  POLICY_SET_CONTRACT,
  policySetInputSchema,
  policySetSchema,
} from "./policyValidation.js";
import { AT, evaluationInput, policySet, policySetInput, rule, ruleInput } from "./testSupport.js";

describe("rule identifiers", () => {
  it("accepts lowercase dotted and kebab identifiers", () => {
    for (const id of ["a", "allow-all", "safety.deny-critical", "rule_1", "r1.2-3_4"]) {
      expect(policyRuleIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects identifiers that would be hard to read in an audit row", () => {
    for (const id of ["", "Allow", "with space", "-leading", "trailing/", "x".repeat(97)]) {
      expect(policyRuleIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe("vocabulary schemas", () => {
  it("accepts exactly the published outcomes, operators, kinds and risk levels", () => {
    for (const outcome of ["allow", "constrain", "require_approval", "deny"]) {
      expect(policyOutcomeSchema.safeParse(outcome).success, outcome).toBe(true);
    }
    expect(policyOutcomeSchema.safeParse("permit").success).toBe(false);

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
      "exists",
    ]) {
      expect(policyOperatorSchema.safeParse(operator).success, operator).toBe(true);
    }
    expect(policyOperatorSchema.safeParse("regex").success).toBe(false);
    expect(policyOperatorSchema.safeParse("eval").success).toBe(false);

    expect(constraintKindSchema.safeParse("max_cost_micro_usd").success).toBe(true);
    expect(constraintKindSchema.safeParse("spend_whatever").success).toBe(false);

    expect(isConstraintKind("redact_output")).toBe(true);
    expect(isConstraintKind("nope")).toBe(false);
    expect(isPolicyOperator("contains")).toBe(true);
    expect(isPolicyOperator("matches")).toBe(false);
    expect(isToolRiskLevel("critical")).toBe(true);
    expect(isToolRiskLevel("extreme")).toBe(false);
  });
});

describe("condition and target schemas", () => {
  it("accepts a well-formed condition", () => {
    expect(
      policyConditionSchema.safeParse({ field: "attributes.tokens", operator: "lt", value: 100 })
        .success,
    ).toBe(true);
    expect(
      policyConditionSchema.safeParse({
        field: "riskLevel",
        operator: "in",
        value: ["high", "critical"],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty field, an unknown operator and a non-JSON value", () => {
    expect(policyConditionSchema.safeParse({ field: "", operator: "eq", value: 1 }).success).toBe(
      false,
    );
    expect(
      policyConditionSchema.safeParse({
        field: "x".repeat(MAX_CONDITION_FIELD_LENGTH + 1),
        operator: "eq",
        value: 1,
      }).success,
    ).toBe(false);
    expect(
      policyConditionSchema.safeParse({ field: "a", operator: "eq", value: Number.NaN }).success,
    ).toBe(false);
    expect(policyConditionSchema.safeParse({ field: "a", operator: "eq" }).success).toBe(false);
  });

  it("accepts a partial target and rejects unknown identifiers", () => {
    expect(policyRuleTargetSchema.safeParse({ action: "tool.invoke" }).success).toBe(true);
    expect(policyRuleTargetSchema.safeParse(MATCH_ALL_TARGET).success).toBe(true);
    expect(policyRuleTargetSchema.safeParse({ tenantId: "not-an-identifier" }).success).toBe(false);
    expect(policyRuleTargetSchema.safeParse({ minimumRiskLevel: "extreme" }).success).toBe(false);
  });
});

describe("policy set schemas", () => {
  it("accepts a complete set", () => {
    expect(policySetSchema.safeParse(policySet({ rules: [rule({ id: "a" })] })).success).toBe(true);
    expect(
      policySetInputSchema.safeParse(policySetInput({ rules: [ruleInput({ id: "a" })] })).success,
    ).toBe(true);
  });

  it("rejects a set that could not be evaluated reproducibly", () => {
    expect(policySetSchema.safeParse({ ...policySet(), version: 0 }).success).toBe(false);
    expect(
      policySetSchema.safeParse({ ...policySet(), createdAt: "not-a-timestamp" }).success,
    ).toBe(false);
    expect(policySetSchema.safeParse({ ...policySet(), defaultOutcome: "maybe" }).success).toBe(
      false,
    );
    expect(policySetSchema.safeParse({ ...policySet(), name: "" }).success).toBe(false);
    expect(
      policySetSchema.safeParse({
        ...policySet(),
        rules: Array.from({ length: MAX_POLICY_RULES + 1 }, (_, index) =>
          rule({ id: `r${String(index)}` }),
        ),
      }).success,
    ).toBe(false);
    expect(
      policySetSchema.safeParse({
        ...policySet(),
        rules: [
          rule({
            id: "a",
            conditions: Array.from({ length: MAX_RULE_CONDITIONS + 1 }, () => ({
              field: "a",
              operator: "eq" as const,
              value: 1,
            })),
          }),
        ],
      }).success,
    ).toBe(false);
    expect(
      policySetSchema.safeParse({
        ...policySet(),
        rules: [
          rule({
            id: "a",
            constraints: Array.from({ length: MAX_RULE_CONSTRAINTS + 1 }, () => ({
              kind: "max_steps" as const,
              value: 1,
              source: "a",
              reason: null,
            })),
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a registration input without the fields the engine fills in", () => {
    const parsed = validate(
      policySetInputSchema,
      { name: "minimal", rules: [], defaultOutcome: "deny" },
      "PolicySet",
    );
    expect(parsed.id).toBeUndefined();
    expect(parsed.createdAt).toBeUndefined();
    expect(parsed.rules).toEqual([]);
  });

  it("reports a validation failure as a ValidationError naming the label", () => {
    expect(() =>
      validate(policySetInputSchema, { name: "", rules: [], defaultOutcome: "deny" }, "PolicySet"),
    ).toThrow(ValidationError);
    const result = tryValidate(policySetInputSchema, {
      name: "",
      rules: [],
      defaultOutcome: "deny",
    });
    expect(result.ok).toBe(false);
  });
});

describe("evaluation input schema", () => {
  it("accepts a complete input", () => {
    expect(policyEvaluationInputSchema.safeParse(evaluationInput()).success).toBe(true);
  });

  it("rejects an input that would make a decision unreproducible", () => {
    expect(
      policyEvaluationInputSchema.safeParse({ ...evaluationInput(), action: "" }).success,
    ).toBe(false);
    expect(
      policyEvaluationInputSchema.safeParse({ ...evaluationInput(), executionId: "exec_1" })
        .success,
    ).toBe(false);
    expect(
      policyEvaluationInputSchema.safeParse({ ...evaluationInput(), riskLevel: "extreme" }).success,
    ).toBe(false);
    expect(
      policyEvaluationInputSchema.safeParse({ ...evaluationInput(), attributes: { fn: undefined } })
        .success,
    ).toBe(false);
  });
});

describe("decision schema", () => {
  it("accepts a decision produced by the evaluator", () => {
    const decision = evaluatePolicySet(
      policySet({ rules: [rule({ id: "a", outcome: "constrain" })] }),
      evaluationInput(),
      { evaluatedAt: AT },
    );
    expect(policyDecisionSchema.safeParse(decision).success).toBe(true);
    expect(isPolicyDecision(JSON.parse(JSON.stringify(decision)))).toBe(true);
  });

  it("rejects a decision that is missing what an audit row needs", () => {
    const decision = evaluatePolicySet(policySet({ defaultOutcome: "allow" }), evaluationInput(), {
      evaluatedAt: AT,
    });
    expect(isPolicyDecision({ ...decision, deterministic: false })).toBe(false);
    expect(isPolicyDecision({ ...decision, evaluatedAt: "yesterday" })).toBe(false);
    expect(isPolicyDecision({ ...decision, outcome: "maybe" })).toBe(false);
    expect(isPolicyDecision({ ...decision, action: { outcome: "allow" } })).toBe(false);
    expect(isPolicyDecision(null)).toBe(false);
  });

  it("requires a deny action to carry a reason and a rule", () => {
    const decision = evaluatePolicySet(policySet({ defaultOutcome: "deny" }), evaluationInput(), {
      evaluatedAt: AT,
    });
    expect(policyDecisionSchema.safeParse(decision).success).toBe(true);
    expect(
      policyDecisionSchema.safeParse({ ...decision, action: { outcome: "deny", constraints: [] } })
        .success,
    ).toBe(false);
  });
});

describe("contracts", () => {
  it("publishes each contract at the AI Core version", () => {
    expect(POLICY_SET_CONTRACT.contractId).toBe("PolicySet");
    expect(POLICY_SET_CONTRACT.version).toBe(AI_CORE_CONTRACT_VERSION);
    expect(POLICY_RULE_CONTRACT.contractId).toBe("PolicyRule");
    expect(POLICY_DECISION_CONTRACT.contractId).toBe("PolicyDecision");
    expect(POLICY_DECISION_CONTRACT.version).toBe(AI_CORE_CONTRACT_VERSION);
    expect(POLICY_EVALUATION_INPUT_CONTRACT.contractId).toBe("PolicyEvaluationInput");
  });

  it("validates through the contract's schema", () => {
    expect(POLICY_SET_CONTRACT.schema.safeParse(policySet()).success).toBe(true);
    expect(POLICY_DECISION_CONTRACT.schema.safeParse({}).success).toBe(false);
  });
});

describe("engine round trip", () => {
  it("stores only sets its own schema accepts", () => {
    const eng = new InMemoryPolicyEngine({ clock: () => AT });
    const set = eng.registerPolicySet(
      policySetInput({ rules: [ruleInput({ id: "a", outcome: "constrain" })] }),
    );
    expect(policySetSchema.safeParse(set).success).toBe(true);
    const revised = eng.addRule(set.id, ruleInput({ id: "b", outcome: "deny" }));
    expect(policySetSchema.safeParse(revised).success).toBe(true);
    expect(revised.version).toBe(2);
  });
});
