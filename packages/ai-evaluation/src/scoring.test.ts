import { describe, expect, it } from "vitest";
import { MAX_EVALUATION_RULES } from "@omnis/ai-core-types";
import type { EvaluationRuleSpec } from "@omnis/ai-core-types";
import { ConflictError, ValidationError } from "@omnis/errors";
import {
  aggregateByDimension,
  applyRule,
  assertNoDuplicateRuleIds,
  evaluateRules,
} from "./scoring.js";
import { DEFAULT_EVALUATION_RULES, ruleSpecFor } from "./EvaluationRules.js";
import { evaluationInput } from "./testSupport.js";

describe("applyRule", () => {
  it("turns a measurement into a score with a verdict from the thresholds", () => {
    const pass = applyRule(evaluationInput({ latencyMs: 1_000 }), ruleSpecFor("latency"));
    expect(pass.score).toBe(1);
    expect(pass.verdict).toBe("pass");
    expect(pass.dimension).toBe("latency");
    expect(pass.weight).toBe(1);
    expect(Object.isFrozen(pass)).toBe(true);
    expect(Object.isFrozen(pass.findings)).toBe(true);

    const warn = applyRule(evaluationInput({ latencyMs: 17_000 }), ruleSpecFor("latency"));
    expect(warn.score).toBeGreaterThan(0.4);
    expect(warn.score).toBeLessThan(0.9);
    expect(warn.verdict).toBe("warn");

    const fail = applyRule(evaluationInput({ latencyMs: 60_000 }), ruleSpecFor("latency"));
    expect(fail.score).toBe(0);
    expect(fail.verdict).toBe("fail");
  });

  it("honors a rule's own thresholds", () => {
    const strict = ruleSpecFor("latency", { passThreshold: 1, warnThreshold: 1 });
    expect(applyRule(evaluationInput({ latencyMs: 17_000 }), strict).verdict).toBe("fail");
    const lenient = ruleSpecFor("latency", { passThreshold: 0.1, warnThreshold: 0 });
    expect(applyRule(evaluationInput({ latencyMs: 60_000 }), lenient).verdict).toBe("warn");
  });

  it("records a rule that throws as a failed measurement instead of aborting", () => {
    // A malformed fact bag from a caller that skipped assertEvaluationInput: the tool rule reads
    // `toolResults.length` on a string and the engine has to survive it.
    const broken = applyRule(
      evaluationInput({ toolResults: { length: 2 } as never }),
      ruleSpecFor("tool_outcomes"),
    );
    expect(broken.score).toBe(0);
    expect(broken.verdict).toBe("fail");
    expect(broken.findings[0]?.code).toBe("rule_error");
    expect(broken.findings[0]?.detail["rule"]).toBe("tool_outcomes");
    expect(broken.findings[0]?.message).toContain("could not be applied");
  });

  it("never fails a rule whose thresholds would let a broken rule pass", () => {
    const lenient = ruleSpecFor("tool_outcomes", { passThreshold: 0, warnThreshold: 0 });
    const broken = applyRule(evaluationInput({ toolResults: { length: 2 } as never }), lenient);
    expect(broken.verdict).toBe("fail");
  });

  it("validates the spec it is given", () => {
    const bad = { ...ruleSpecFor("latency"), dimension: "cost" } as EvaluationRuleSpec;
    expect(() => applyRule(evaluationInput(), bad)).toThrow(ValidationError);
  });
});

describe("aggregateByDimension", () => {
  it("combines rules that share a dimension by weight", () => {
    const completion = applyRule(evaluationInput(), ruleSpecFor("completion"));
    const expected = applyRule(
      evaluationInput({ expected: { missing: 1 }, output: {} }),
      ruleSpecFor("expected_output"),
    );
    expect(completion.dimension).toBe("correctness");
    expect(expected.dimension).toBe("correctness");

    const aggregated = aggregateByDimension([completion, expected]);
    expect(aggregated).toHaveLength(1);
    const correctness = aggregated[0];
    expect(correctness?.dimension).toBe("correctness");
    // (1 * 3 + 0 * 2) / 5
    expect(correctness?.score).toBe(0.6);
    expect(correctness?.weight).toBe(5);
    // The worst member verdict wins rather than being averaged away.
    expect(correctness?.verdict).toBe("fail");
    // Ordered by severity, so the failure is read before the observation that the execution ran.
    expect(correctness?.findings.map((entry) => entry.code)).toEqual([
      "expected_field_missing",
      "execution_completed",
    ]);
  });

  it("emits dimensions in the published order, not the order the rules ran", () => {
    const reversed = [...DEFAULT_EVALUATION_RULES]
      .reverse()
      .map((spec) => applyRule(evaluationInput(), spec));
    const aggregated = aggregateByDimension(reversed);
    expect(aggregated.map((score) => score.dimension)).toEqual([
      "correctness",
      "policy_compliance",
      "schema_validity",
      "quality",
      "latency",
      "cost",
      "tool_correctness",
    ]);
    expect(Object.isFrozen(aggregated)).toBe(true);
  });

  it("falls back to a plain mean when every weight is zero", () => {
    const first = applyRule(evaluationInput(), ruleSpecFor("completion", { id: "a", weight: 0 }));
    const second = applyRule(
      evaluationInput({ cancelled: true }),
      ruleSpecFor("completion", { id: "b", weight: 0 }),
    );
    const aggregated = aggregateByDimension([first, second]);
    expect(aggregated[0]?.score).toBe(0.5);
    expect(aggregated[0]?.weight).toBe(0);
  });

  it("returns nothing for nothing", () => {
    expect(aggregateByDimension([])).toEqual([]);
  });
});

describe("evaluateRules", () => {
  it("scores the known-good fixture as a pass", () => {
    const outcome = evaluateRules(evaluationInput(), DEFAULT_EVALUATION_RULES);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.overallScore).toBe(1);
    expect(outcome.scores).toHaveLength(7);
    expect(outcome.rulesApplied).toHaveLength(8);
    expect(outcome.scores.every((score) => score.verdict === "pass")).toBe(true);
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("skips disabled rules and does not list them", () => {
    const rules = [
      ruleSpecFor("completion"),
      ruleSpecFor("latency", { id: "latency-off", enabled: false }),
    ];
    const outcome = evaluateRules(evaluationInput({ latencyMs: 600_000 }), rules);
    expect(outcome.rulesApplied).toEqual(["completion"]);
    expect(outcome.scores.map((score) => score.dimension)).toEqual(["correctness"]);
    expect(outcome.verdict).toBe("pass");
  });

  it("warns rather than passing when nothing was measured", () => {
    const outcome = evaluateRules(evaluationInput(), []);
    expect(outcome.verdict).toBe("warn");
    expect(outcome.overallScore).toBe(0);
    expect(outcome.scores).toEqual([]);
    expect(outcome.rulesApplied).toEqual([]);

    const allDisabled = evaluateRules(evaluationInput(), [
      ruleSpecFor("completion", { enabled: false }),
    ]);
    expect(allDisabled.verdict).toBe("warn");
  });

  it("fails the whole evaluation when any dimension fails", () => {
    const outcome = evaluateRules(
      evaluationInput({ latencyMs: 600_000 }),
      DEFAULT_EVALUATION_RULES,
    );
    expect(outcome.verdict).toBe("fail");
    expect(outcome.overallScore).toBeLessThan(1);
    expect(outcome.scores.find((score) => score.dimension === "latency")?.verdict).toBe("fail");
  });

  it("is deterministic", () => {
    const input = evaluationInput({ latencyMs: 9_000, expected: { rows: 3 } });
    expect(JSON.stringify(evaluateRules(input, DEFAULT_EVALUATION_RULES))).toBe(
      JSON.stringify(evaluateRules(input, DEFAULT_EVALUATION_RULES)),
    );
    // Rule order in the list does not change the result document.
    const shuffled = [
      DEFAULT_EVALUATION_RULES[3],
      DEFAULT_EVALUATION_RULES[0],
      DEFAULT_EVALUATION_RULES[7],
      DEFAULT_EVALUATION_RULES[1],
    ].filter((spec): spec is EvaluationRuleSpec => spec !== undefined);
    const a = evaluateRules(input, shuffled);
    const b = evaluateRules(input, [...shuffled].reverse());
    expect(JSON.stringify(a.scores)).toBe(JSON.stringify(b.scores));
    expect(a.verdict).toBe(b.verdict);
    expect(a.overallScore).toBe(b.overallScore);
  });

  it("rejects duplicate rule identifiers", () => {
    expect(() =>
      evaluateRules(evaluationInput(), [ruleSpecFor("completion"), ruleSpecFor("completion")]),
    ).toThrow(ConflictError);
    expect(() =>
      assertNoDuplicateRuleIds([ruleSpecFor("latency"), ruleSpecFor("latency", { id: "latency" })]),
    ).toThrow(ConflictError);
    expect(() =>
      assertNoDuplicateRuleIds([ruleSpecFor("latency"), ruleSpecFor("cost")]),
    ).not.toThrow();
  });

  it("rejects more rules than the contract allows", () => {
    const many = Array.from({ length: MAX_EVALUATION_RULES + 1 }, (_unused, index) =>
      ruleSpecFor("completion", { id: `completion-${String(index)}` }),
    );
    expect(() => evaluateRules(evaluationInput(), many)).toThrow(RangeError);
    expect(() =>
      evaluateRules(evaluationInput(), many.slice(0, MAX_EVALUATION_RULES)),
    ).not.toThrow();
  });
});
