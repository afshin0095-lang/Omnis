import { describe, expect, it } from "vitest";
import {
  AI_CORE_CONTRACT_VERSION,
  EVALUATION_DIMENSIONS,
  EVALUATION_VERDICTS,
  FINDING_SEVERITIES,
  MAX_EVALUATION_RULES,
} from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import { validate } from "@omnis/validation";
import { InMemoryEvaluationEngine } from "./EvaluationEngine.js";
import { DEFAULT_EVALUATION_RULES, ruleSpecFor } from "./EvaluationRules.js";
import {
  EVALUATION_RESULT_CONTRACT,
  EVALUATION_RULE_CONTRACT,
  EVALUATION_RULE_SET_CONTRACT,
  evaluationNameSchema,
  evaluationResultSchema,
  evaluationRuleSetInputSchema,
  evaluationRuleSetSchema,
  evaluationRuleSpecSchema,
  evaluationScoreSchema,
  isEvaluationDimensionValue,
  isEvaluationVerdict,
  isFindingSeverity,
  MAX_EVALUATION_NAME_LENGTH,
  MAX_EVALUATION_RULE_SETS,
} from "./evaluationValidation.js";
import { AT, AT_MS, evaluationInput } from "./testSupport.js";

describe("names", () => {
  it("accepts a slug an operator can type", () => {
    for (const name of [
      "default",
      "release-gate",
      "strict.latency",
      "gate_2",
      "x".repeat(MAX_EVALUATION_NAME_LENGTH),
    ]) {
      expect(evaluationNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const name of [
      "",
      "x",
      "Release Gate",
      "-lead",
      "trail-",
      "x".repeat(MAX_EVALUATION_NAME_LENGTH + 1),
    ]) {
      expect(evaluationNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("knows the published enumerations", () => {
    expect(MAX_EVALUATION_RULE_SETS).toBe(64);
    for (const verdict of EVALUATION_VERDICTS) {
      expect(isEvaluationVerdict(verdict), verdict).toBe(true);
    }
    expect(isEvaluationVerdict("maybe")).toBe(false);
    for (const severity of FINDING_SEVERITIES) {
      expect(isFindingSeverity(severity), severity).toBe(true);
    }
    expect(isFindingSeverity("critical")).toBe(false);
    for (const dimension of EVALUATION_DIMENSIONS) {
      expect(isEvaluationDimensionValue(dimension), dimension).toBe(true);
    }
    expect(isEvaluationDimensionValue("vibes")).toBe(false);
  });
});

describe("rule spec schema", () => {
  it("accepts every shipped default", () => {
    for (const spec of DEFAULT_EVALUATION_RULES) {
      expect(evaluationRuleSpecSchema.safeParse(spec).success, spec.id).toBe(true);
    }
  });

  it("rejects incoherent thresholds and unknown keys", () => {
    const base = ruleSpecFor("latency");
    expect(
      evaluationRuleSpecSchema.safeParse({ ...base, passThreshold: 0.2, warnThreshold: 0.9 })
        .success,
    ).toBe(false);
    expect(evaluationRuleSpecSchema.safeParse({ ...base, passThreshold: 1.5 }).success).toBe(false);
    expect(evaluationRuleSpecSchema.safeParse({ ...base, weight: -1 }).success).toBe(false);
    expect(evaluationRuleSpecSchema.safeParse({ ...base, weight: Number.NaN }).success).toBe(false);
    // Strict: a typo in a parameter name must not be silently dropped.
    expect(evaluationRuleSpecSchema.safeParse({ ...base, threshold: 0.5 }).success).toBe(false);
    expect(evaluationRuleSpecSchema.safeParse({ ...base, enabled: "yes" }).success).toBe(false);
    expect(evaluationRuleSpecSchema.safeParse({ ...base, dimension: "vibes" }).success).toBe(false);
    expect(() =>
      validate(evaluationRuleSpecSchema, { ...base, dimension: "vibes" }, "EvaluationRuleSpec"),
    ).toThrow(ValidationError);
  });
});

describe("rule set schemas", () => {
  it("accepts a stored set and a registration input", () => {
    const engine = new InMemoryEvaluationEngine({ clock: () => AT_MS });
    expect(evaluationRuleSetSchema.safeParse(engine.requireRuleSet("default")).success).toBe(true);
    expect(evaluationRuleSetInputSchema.safeParse({ name: "gate" }).success).toBe(true);
    expect(
      evaluationRuleSetInputSchema.safeParse({
        name: "gate",
        rules: DEFAULT_EVALUATION_RULES,
        createdAt: AT,
      }).success,
    ).toBe(true);
  });

  it("rejects a set that has drifted from the contract", () => {
    const engine = new InMemoryEvaluationEngine({ clock: () => AT_MS });
    const set = engine.requireRuleSet("default");
    expect(evaluationRuleSetSchema.safeParse({ ...set, version: 0 }).success).toBe(false);
    expect(evaluationRuleSetSchema.safeParse({ ...set, updatedAt: "yesterday" }).success).toBe(
      false,
    );
    const tooMany = [
      ...set.rules,
      ...Array.from({ length: MAX_EVALUATION_RULES }, (_unused, index) =>
        ruleSpecFor("completion", { id: `completion-${String(index)}` }),
      ),
    ];
    expect(tooMany.length).toBeGreaterThan(MAX_EVALUATION_RULES);
    expect(evaluationRuleSetSchema.safeParse({ ...set, rules: tooMany }).success).toBe(false);
    expect(evaluationRuleSetSchema.safeParse({ ...set, name: "Not A Slug" }).success).toBe(false);
    expect(MAX_EVALUATION_RULES).toBe(32);
  });
});

describe("score and result schemas", () => {
  it("accepts what the engine produces", () => {
    const engine = new InMemoryEvaluationEngine({ clock: () => AT_MS });
    const result = engine.evaluate(evaluationInput());
    expect(evaluationResultSchema.safeParse(result).success).toBe(true);
    for (const score of result.scores) {
      expect(evaluationScoreSchema.safeParse(score).success, score.dimension).toBe(true);
    }
  });

  it("rejects a result that claims more than it measured", () => {
    const engine = new InMemoryEvaluationEngine({ clock: () => AT_MS });
    const result = engine.evaluate(evaluationInput());
    // `deterministic` is a literal, not a boolean: a result that admits otherwise is not a result
    // this package produced.
    expect(evaluationResultSchema.safeParse({ ...result, deterministic: false }).success).toBe(
      false,
    );
    expect(evaluationResultSchema.safeParse({ ...result, overallScore: 1.5 }).success).toBe(false);
    expect(evaluationResultSchema.safeParse({ ...result, overallScore: -0.1 }).success).toBe(false);
    expect(evaluationResultSchema.safeParse({ ...result, verdict: "great" }).success).toBe(false);
    expect(evaluationResultSchema.safeParse({ ...result, id: "evl_not-a-ulid" }).success).toBe(
      false,
    );
    expect(evaluationResultSchema.safeParse({ ...result, extra: 1 }).success).toBe(false);
    expect(evaluationResultSchema.safeParse({ ...result, evaluatedAt: "now" }).success).toBe(false);
    expect(
      evaluationScoreSchema.safeParse({
        dimension: "latency",
        score: 2,
        verdict: "pass",
        weight: 1,
        findings: [],
      }).success,
    ).toBe(false);
  });
});

describe("contracts", () => {
  it("publishes rule, rule set and result at the AI Core version", () => {
    expect(EVALUATION_RULE_CONTRACT.contractId).toBe("EvaluationRuleSpec");
    expect(EVALUATION_RULE_SET_CONTRACT.contractId).toBe("EvaluationRuleSet");
    expect(EVALUATION_RESULT_CONTRACT.contractId).toBe("EvaluationResult");
    for (const contract of [
      EVALUATION_RULE_CONTRACT,
      EVALUATION_RULE_SET_CONTRACT,
      EVALUATION_RESULT_CONTRACT,
    ]) {
      expect(contract.version).toBe(AI_CORE_CONTRACT_VERSION);
    }
    expect(EVALUATION_RESULT_CONTRACT.schema.safeParse({}).success).toBe(false);
  });
});
