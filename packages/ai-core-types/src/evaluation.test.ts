import { describe, expect, it } from "vitest";
import {
  assertEvaluationRuleCount,
  assertEvaluationRuleSpec,
  clampScore,
  EVALUATION_DIMENSIONS,
  EVALUATION_VERDICT_RANK,
  isEvaluationDimension,
  MAX_EVALUATION_RULES,
  verdictForScore,
  weightedOverallScore,
  worstVerdict,
  type EvaluationRuleSpec,
  type EvaluationScore,
} from "./index.js";

function score(
  dimension: EvaluationScore["dimension"],
  value: number,
  weight: number,
): EvaluationScore {
  return {
    dimension,
    score: value,
    verdict: verdictForScore(value, 0.8, 0.5),
    weight,
    findings: [],
  };
}

function rule(overrides: Partial<EvaluationRuleSpec> = {}): EvaluationRuleSpec {
  return {
    id: "latency-budget",
    name: "Latency within budget",
    description: "Scores the execution against its latency budget.",
    dimension: "latency",
    weight: 1,
    passThreshold: 0.8,
    warnThreshold: 0.5,
    parameters: { maxLatencyMs: 4_000 },
    enabled: true,
    ...overrides,
  };
}

describe("scores", () => {
  it("clamps into 0..1 and treats a non-finite measurement as zero", () => {
    expect(clampScore(0.5)).toBe(0.5);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(7)).toBe(1);
    // A rule that divides by zero latency must not poison the overall score with NaN.
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("applies both thresholds", () => {
    expect(verdictForScore(0.9, 0.8, 0.5)).toBe("pass");
    expect(verdictForScore(0.8, 0.8, 0.5)).toBe("pass");
    expect(verdictForScore(0.6, 0.8, 0.5)).toBe("warn");
    expect(verdictForScore(0.5, 0.8, 0.5)).toBe("warn");
    expect(verdictForScore(0.49, 0.8, 0.5)).toBe("fail");
  });
});

describe("verdicts", () => {
  it("takes the worst verdict across dimensions", () => {
    expect(worstVerdict(["pass", "pass"])).toBe("pass");
    expect(worstVerdict(["pass", "warn"])).toBe("warn");
    expect(worstVerdict(["warn", "fail", "pass"])).toBe("fail");
    expect(worstVerdict([])).toBe("pass");
    expect(EVALUATION_VERDICT_RANK.pass).toBeLessThan(EVALUATION_VERDICT_RANK.fail);
  });

  it("recognizes its own dimensions", () => {
    for (const dimension of EVALUATION_DIMENSIONS) {
      expect(isEvaluationDimension(dimension)).toBe(true);
    }
    expect(isEvaluationDimension("vibes")).toBe(false);
  });
});

describe("weightedOverallScore", () => {
  it("weights by declared weight", () => {
    expect(weightedOverallScore([score("correctness", 1, 3), score("latency", 0, 1)])).toBeCloseTo(
      0.75,
      10,
    );
  });

  it("ignores zero-weight dimensions", () => {
    expect(weightedOverallScore([score("correctness", 1, 1), score("cost", 0, 0)])).toBe(1);
  });

  it("is zero when there is nothing to score", () => {
    expect(weightedOverallScore([])).toBe(0);
    expect(weightedOverallScore([score("cost", 1, 0)])).toBe(0);
  });

  it("clamps an out-of-range dimension score before weighting", () => {
    expect(weightedOverallScore([score("quality", 5, 1)])).toBe(1);
  });
});

describe("rule specs", () => {
  it("accepts a coherent rule", () => {
    expect(() => assertEvaluationRuleSpec(rule())).not.toThrow();
  });

  it("rejects inverted thresholds", () => {
    // A pass threshold below the warn threshold would make every passing score also a
    // warning, so the rule could never report a clean pass.
    expect(() =>
      assertEvaluationRuleSpec(rule({ passThreshold: 0.4, warnThreshold: 0.7 })),
    ).toThrow(RangeError);
  });

  it("rejects thresholds outside 0..1 and negative or non-finite weights", () => {
    expect(() => assertEvaluationRuleSpec(rule({ passThreshold: 1.2 }))).toThrow(RangeError);
    expect(() => assertEvaluationRuleSpec(rule({ warnThreshold: -0.1 }))).toThrow(RangeError);
    expect(() => assertEvaluationRuleSpec(rule({ weight: -1 }))).toThrow(RangeError);
    expect(() => assertEvaluationRuleSpec(rule({ weight: Number.NaN }))).toThrow(RangeError);
  });

  it("bounds the number of rules applied to one execution", () => {
    const rules = Array.from({ length: MAX_EVALUATION_RULES + 1 }, (_, index) =>
      rule({ id: `r${String(index)}` }),
    );
    expect(() => assertEvaluationRuleCount(rules)).toThrow(RangeError);
    expect(() => assertEvaluationRuleCount(rules.slice(0, MAX_EVALUATION_RULES))).not.toThrow();
  });
});
