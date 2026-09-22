import { describe, expect, it } from "vitest";
import { ValidationError } from "@omnis/errors";
import {
  BUILT_IN_EVALUATION_RULES,
  budgetScore,
  DEFAULT_EVALUATION_RULES,
  EVALUATION_RULE_KEYS,
  isEvaluationRuleKey,
  MAX_FINDINGS_PER_RULE,
  requireRuleImplementation,
  ruleImplementation,
  ruleSpecFor,
} from "./EvaluationRules.js";
import {
  evaluationInput,
  providerFailure,
  toolResult,
  unpricedUsage,
  usage,
} from "./testSupport.js";
import type { EvaluationInput } from "@omnis/ai-core-types";

/** Measures one rule against one input and returns the measurement. */
function measure(
  key: (typeof EVALUATION_RULE_KEYS)[number],
  input: EvaluationInput,
  overrides: Parameters<typeof ruleSpecFor>[1] = {},
) {
  const spec = ruleSpecFor(key, overrides);
  return BUILT_IN_EVALUATION_RULES[key].measure(input, spec);
}

describe("rule keys and defaults", () => {
  it("ships one implementation per key", () => {
    expect(EVALUATION_RULE_KEYS).toHaveLength(8);
    for (const key of EVALUATION_RULE_KEYS) {
      expect(isEvaluationRuleKey(key), key).toBe(true);
      expect(BUILT_IN_EVALUATION_RULES[key].key).toBe(key);
      expect(ruleImplementation(key)?.key).toBe(key);
      expect(BUILT_IN_EVALUATION_RULES[key].defaultParameters["rule"]).toBe(key);
    }
    expect(isEvaluationRuleKey("vibes")).toBe(false);
    expect(ruleImplementation("vibes")).toBeNull();
    expect(Object.isFrozen(BUILT_IN_EVALUATION_RULES)).toBe(true);
  });

  it("provides one default spec per implementation", () => {
    expect(DEFAULT_EVALUATION_RULES.map((spec) => spec.id)).toEqual([...EVALUATION_RULE_KEYS]);
    expect(DEFAULT_EVALUATION_RULES.every((spec) => spec.enabled)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EVALUATION_RULES)).toBe(true);
    // Every default scores a full mark against the known-good fixture, which is what makes the
    // fixture a baseline rather than an arbitrary bag of facts.
    for (const spec of DEFAULT_EVALUATION_RULES) {
      const implementation =
        BUILT_IN_EVALUATION_RULES[spec.parameters["rule"] as (typeof EVALUATION_RULE_KEYS)[number]];
      expect(implementation.measure(evaluationInput(), spec).score, spec.id).toBe(1);
    }
  });

  it("derives a variant without dropping the parameters it inherits", () => {
    const strict = ruleSpecFor("latency", {
      id: "latency-strict",
      weight: 5,
      passThreshold: 0.95,
      parameters: { warnMs: 500 },
    });
    expect(strict.id).toBe("latency-strict");
    expect(strict.weight).toBe(5);
    expect(strict.parameters).toEqual({ rule: "latency", warnMs: 500, maxMs: 30_000 });
    expect(strict.dimension).toBe("latency");
    expect(Object.isFrozen(strict)).toBe(true);
    expect(Object.isFrozen(strict.parameters)).toBe(true);
  });

  it("rejects a spec whose parameters contradict the implementation", () => {
    expect(() => ruleSpecFor("latency", { parameters: { warnMs: 40_000 } })).toThrow(
      ValidationError,
    );
    expect(() =>
      ruleSpecFor("latency", { parameters: { warnMs: 10, maxMs: 5, rule: "latency" } }),
    ).toThrow(ValidationError);
    expect(() => ruleSpecFor("cost", { parameters: { unknownKnob: 1 } })).toThrow(
      /unknownKnob|Unrecognized/,
    );
    expect(() => ruleSpecFor("output_shape", { parameters: { minCharacters: -1 } })).toThrow(
      ValidationError,
    );
    expect(() => ruleSpecFor("policy_compliance", { parameters: { constrainScore: 2 } })).toThrow(
      ValidationError,
    );
  });

  it("rejects a spec that declares the wrong dimension or an unknown implementation", () => {
    const latency = ruleSpecFor("latency");
    expect(() => requireRuleImplementation({ ...latency, dimension: "cost" })).toThrow(
      /declares dimension "cost"/,
    );
    expect(() =>
      requireRuleImplementation({
        ...latency,
        parameters: { ...latency.parameters, rule: "vibes" },
      }),
    ).toThrow(/not one of/);
    expect(() => requireRuleImplementation({ ...latency, parameters: {} })).toThrow(/not one of/);
    expect(() =>
      requireRuleImplementation({ ...latency, passThreshold: 0.2, warnThreshold: 0.9 }),
    ).toThrow(RangeError);
  });
});

describe("budgetScore", () => {
  it("interpolates between the warn line and the maximum", () => {
    expect(budgetScore(0, 100, 200)).toBe(1);
    expect(budgetScore(100, 100, 200)).toBe(1);
    expect(budgetScore(150, 100, 200)).toBe(0.5);
    expect(budgetScore(200, 100, 200)).toBe(0);
    expect(budgetScore(500, 100, 200)).toBe(0);
  });

  it("never divides by zero when the bounds are degenerate", () => {
    expect(budgetScore(50, 100, 100)).toBe(1);
    expect(budgetScore(150, 100, 100)).toBe(0);
    // An inverted pair cannot be registered — the schema refines it away — but a value under the
    // warn line is still within budget rather than a division by zero.
    expect(budgetScore(150, 200, 100)).toBe(1);
  });
});

describe("completion rule", () => {
  it("scores a clean execution at one", () => {
    const measured = measure("completion", evaluationInput());
    expect(measured.score).toBe(1);
    expect(measured.findings.map((entry) => entry.code)).toEqual(["execution_completed"]);
  });

  it("scores a failure, a cancellation and a timeout at zero, with the failure's own codes", () => {
    const failed = measure("completion", evaluationInput({ failure: providerFailure() }));
    expect(failed.score).toBe(0);
    expect(failed.findings[0]?.code).toBe("execution_failed");
    expect(failed.findings[0]?.detail["failureCode"]).toBe("timeout");
    // The finding quotes the failure message but not the output: the message is redacted at the
    // source, the output is not.
    expect(JSON.stringify(failed.findings)).not.toContain("Revenue rose");

    const cancelled = measure("completion", evaluationInput({ cancelled: true }));
    expect(cancelled.score).toBe(0);
    expect(cancelled.findings.map((entry) => entry.code)).toContain("execution_cancelled");

    const timedOut = measure("completion", evaluationInput({ timedOut: true }));
    expect(timedOut.findings.map((entry) => entry.code)).toContain("execution_timed_out");
  });
});

describe("expected_output rule", () => {
  it("records that nothing was measured when no expectation was declared", () => {
    const measured = measure("expected_output", evaluationInput());
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("no_expectation_declared");
    expect(measured.findings[0]?.severity).toBe("info");
  });

  it("scores a subset expectation by the fraction of facts that match", () => {
    const output = { summary: "Revenue rose 12% quarter over quarter.", rows: 3, extra: true };
    const full = measure(
      "expected_output",
      evaluationInput({
        output,
        expected: { rows: 3, summary: "Revenue rose 12% quarter over quarter." },
      }),
    );
    expect(full.score).toBe(1);
    expect(full.findings[0]?.code).toBe("expectation_satisfied");

    const half = measure(
      "expected_output",
      evaluationInput({ output, expected: { rows: 3, summary: "something else" } }),
    );
    expect(half.score).toBe(0.5);
    expect(half.findings[0]?.code).toBe("expected_field_mismatch");
    expect(half.findings[0]?.detail["path"]).toBe("summary");

    const missing = measure(
      "expected_output",
      evaluationInput({ output, expected: { absent: 1 } }),
    );
    expect(missing.score).toBe(0);
    expect(missing.findings[0]?.code).toBe("expected_field_missing");
  });

  it("scores nested expectations by leaf path", () => {
    const output = { report: { totals: { revenue: 12, cost: 5 }, label: "Q1" } };
    const measured = measure(
      "expected_output",
      evaluationInput({ output, expected: { report: { totals: { revenue: 12, cost: 6 } } } }),
    );
    expect(measured.score).toBe(0.5);
    expect(measured.findings[0]?.detail["path"]).toBe("report.totals.cost");
  });

  it("skips expectation keys the caller cannot predict", () => {
    const output = { answer: 1, generatedAt: "whenever" };
    const measured = measure(
      "expected_output",
      evaluationInput({ output, expected: { answer: 1, generatedAt: "2026-01-01" } }),
      {
        parameters: { ignoreKeys: ["generatedAt"] },
      },
    );
    expect(measured.score).toBe(1);
  });

  it("requires structural equality in exact mode", () => {
    const output = { a: 1, b: 2 };
    const subsetShape = { match: "exact" as const };
    expect(
      measure("expected_output", evaluationInput({ output, expected: { b: 2, a: 1 } }), {
        parameters: subsetShape,
      }).score,
    ).toBe(1);
    const extra = measure("expected_output", evaluationInput({ output, expected: { a: 1 } }), {
      parameters: subsetShape,
    });
    expect(extra.score).toBe(0);
    expect(extra.findings[0]?.code).toBe("expectation_mismatch");
    expect(extra.findings[0]?.detail["outputKind"]).toBe("object");
  });

  it("treats an empty expectation as grading nothing", () => {
    const measured = measure("expected_output", evaluationInput({ expected: {} }));
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("expectation_empty");
  });

  it("caps the findings it reports", () => {
    const expected: Record<string, number> = {};
    for (let index = 0; index < 30; index += 1) {
      expected[`field${String(index)}`] = index;
    }
    const measured = measure("expected_output", evaluationInput({ output: {}, expected }));
    expect(measured.score).toBe(0);
    expect(measured.findings).toHaveLength(MAX_FINDINGS_PER_RULE + 1);
    expect(measured.findings[MAX_FINDINGS_PER_RULE]?.code).toBe("findings_truncated");
    expect(measured.findings[MAX_FINDINGS_PER_RULE]?.detail["total"]).toBe(30);
  });
});

describe("output_schema rule", () => {
  it("does not grade a format nobody requested", () => {
    const measured = measure("output_schema", evaluationInput());
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("no_format_requested");
  });

  it("scores a satisfied format at one and a violated one at zero", () => {
    const ok = measure(
      "output_schema",
      evaluationInput({
        requestedResponseFormat: "json_schema",
        schemaName: "Rows",
        outputMatchesRequestedFormat: true,
      }),
    );
    expect(ok.score).toBe(1);
    expect(ok.findings[0]?.detail["schemaName"]).toBe("Rows");

    const bad = measure(
      "output_schema",
      evaluationInput({
        requestedResponseFormat: "json_schema",
        schemaName: "Rows",
        outputMatchesRequestedFormat: false,
      }),
    );
    expect(bad.score).toBe(0);
    expect(bad.findings[0]?.code).toBe("schema_mismatch");
    expect(bad.findings[0]?.severity).toBe("error");
    expect(bad.findings[0]?.detail["outputKind"]).toBe("object");
  });
});

describe("output_shape rule", () => {
  it("scores a normal answer at one", () => {
    const measured = measure("output_shape", evaluationInput());
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("output_shape_ok");
  });

  it("scores an empty output at zero", () => {
    expect(measure("output_shape", evaluationInput({ output: null })).score).toBe(0);
    expect(measure("output_shape", evaluationInput({ output: "" })).score).toBe(0);
    expect(measure("output_shape", evaluationInput({ output: null })).findings[0]?.code).toBe(
      "empty_output",
    );
  });

  it("grades a short answer proportionally", () => {
    const measured = measure("output_shape", evaluationInput({ output: "abc" }), {
      parameters: { minCharacters: 100 },
    });
    expect(measured.score).toBeCloseTo(0.03, 5);
    expect(measured.findings[0]?.code).toBe("output_too_short");
    expect(measured.findings[0]?.severity).toBe("warning");
  });

  it("grades an over-long answer proportionally", () => {
    const measured = measure("output_shape", evaluationInput({ output: "x".repeat(400) }), {
      parameters: { maxCharacters: 100 },
    });
    expect(measured.score).toBe(0.25);
    expect(measured.findings[0]?.code).toBe("output_too_long");
  });

  it("penalizes unfinished-template markers, whatever their casing", () => {
    const measured = measure(
      "output_shape",
      evaluationInput({ output: "Here is the report. Lorem Ipsum follows." }),
    );
    expect(measured.score).toBe(0.75);
    expect(measured.findings[0]?.code).toBe("forbidden_substring");
    expect(measured.findings[0]?.severity).toBe("error");
    expect(measured.findings[0]?.detail["markers"]).toEqual(["lorem ipsum"]);
  });

  it("takes the worst of several penalties", () => {
    const measured = measure("output_shape", evaluationInput({ output: "TODO" }), {
      parameters: { minCharacters: 100, forbiddenSubstrings: ["todo"] },
    });
    expect(measured.score).toBeLessThan(0.1);
    expect(measured.findings.map((entry) => entry.code)).toEqual([
      "output_too_short",
      "forbidden_substring",
    ]);
  });

  it("measures a structured output by its rendering", () => {
    const measured = measure("output_shape", evaluationInput({ output: { a: 1 } }), {
      parameters: { minCharacters: 100 },
    });
    expect(measured.findings[0]?.detail["characters"]).toBe('{"a":1}'.length);
  });
});

describe("latency rule", () => {
  it("does not grade an unmeasured duration", () => {
    const measured = measure("latency", evaluationInput({ latencyMs: null }));
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("latency_not_measured");
  });

  it("scores inside, between and beyond the bounds", () => {
    expect(measure("latency", evaluationInput({ latencyMs: 1_000 })).score).toBe(1);
    expect(measure("latency", evaluationInput({ latencyMs: 1_000 })).findings[0]?.code).toBe(
      "latency_within_budget",
    );

    const between = measure("latency", evaluationInput({ latencyMs: 17_000 }));
    expect(between.score).toBeCloseTo((30_000 - 17_000) / (30_000 - 4_000), 5);
    expect(between.findings[0]?.code).toBe("latency_above_warn");
    expect(between.findings[0]?.severity).toBe("warning");

    const beyond = measure("latency", evaluationInput({ latencyMs: 60_000 }));
    expect(beyond.score).toBe(0);
    expect(beyond.findings[0]?.code).toBe("latency_above_maximum");
    expect(beyond.findings[0]?.severity).toBe("error");
  });

  it("rounds the reported duration but scores the real one", () => {
    const measured = measure("latency", evaluationInput({ latencyMs: 1_234.7 }));
    expect(measured.findings[0]?.detail["latencyMs"]).toBe(1_235);
    expect(measured.score).toBe(1);
  });
});

describe("cost rule", () => {
  it("grades money when the model is priced", () => {
    expect(measure("cost", evaluationInput({ usage: usage({ costMicro: 10_000 }) })).score).toBe(1);
    const between = measure("cost", evaluationInput({ usage: usage({ costMicro: 275_000 }) }));
    expect(between.score).toBe(0.5);
    expect(between.findings[0]?.code).toBe("cost_above_warn");
    const beyond = measure("cost", evaluationInput({ usage: usage({ costMicro: 900_000 }) }));
    expect(beyond.score).toBe(0);
    expect(beyond.findings[0]?.code).toBe("cost_above_maximum");
  });

  it("grades tokens when the model is unpriced, and says so", () => {
    const measured = measure("cost", evaluationInput({ usage: unpricedUsage(2_000) }));
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("tokens_within_budget");
    expect(measured.findings[0]?.message).toContain("unpriced");
    expect(measured.findings[0]?.detail["priced"]).toBe(false);

    const heavy = measure("cost", evaluationInput({ usage: unpricedUsage(18_000) }));
    expect(heavy.score).toBe(0.5);
    expect(heavy.findings[0]?.code).toBe("tokens_above_warn");
  });

  it("does not grade an execution that recorded no usage", () => {
    const measured = measure("cost", evaluationInput({ usage: null }));
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("usage_not_measured");
  });
});

describe("policy_compliance rule", () => {
  it("maps each outcome to a configured score", () => {
    expect(measure("policy_compliance", evaluationInput({ policyOutcome: "allow" })).score).toBe(1);
    expect(
      measure("policy_compliance", evaluationInput({ policyOutcome: "constrain" })).score,
    ).toBe(0.6);
    expect(
      measure("policy_compliance", evaluationInput({ policyOutcome: "require_approval" })).score,
    ).toBe(0.85);
    expect(measure("policy_compliance", evaluationInput({ policyOutcome: "deny" })).score).toBe(0);
    expect(
      measure("policy_compliance", evaluationInput({ policyOutcome: "deny" })).findings[0]
        ?.severity,
    ).toBe("error");
    expect(
      measure("policy_compliance", evaluationInput({ policyOutcome: "constrain" })).findings[0]
        ?.severity,
    ).toBe("warning");
  });

  it("honors configured scores", () => {
    const strict = measure("policy_compliance", evaluationInput({ policyOutcome: "constrain" }), {
      parameters: { constrainScore: 0.1 },
    });
    expect(strict.score).toBe(0.1);
  });

  it("does not grade an execution no policy was evaluated for", () => {
    const measured = measure("policy_compliance", evaluationInput({ policyOutcome: null }));
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("policy_not_evaluated");
  });
});

describe("tool_outcomes rule", () => {
  it("does not grade an execution that called no tools", () => {
    const measured = measure("tool_outcomes", evaluationInput());
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("no_tools_invoked");
  });

  it("scores the fraction that succeeded", () => {
    const measured = measure(
      "tool_outcomes",
      evaluationInput({
        toolResults: [
          toolResult(),
          toolResult({ status: "failed", errorCode: "no_index", name: "search_documents" }),
          toolResult(),
          toolResult(),
        ],
      }),
    );
    expect(measured.score).toBe(0.75);
    expect(measured.findings[0]?.code).toBe("tool_failed");
    expect(measured.findings[0]?.severity).toBe("error");
    expect(measured.findings[0]?.detail["errorCode"]).toBe("no_index");
  });

  it("counts a governance denial against the score by default", () => {
    const denied = [toolResult({ status: "denied", errorCode: null }), toolResult()];
    const strict = measure("tool_outcomes", evaluationInput({ toolResults: denied }));
    expect(strict.score).toBe(0.5);
    expect(strict.findings[0]?.code).toBe("tool_denied");
    // A denial is governance working, so it is a warning rather than an error.
    expect(strict.findings[0]?.severity).toBe("warning");

    const lenient = measure("tool_outcomes", evaluationInput({ toolResults: denied }), {
      parameters: { deniedCountsAsFailure: false },
    });
    expect(lenient.score).toBe(1);
  });

  it("does not grade a run where every tool was denied and denials are excluded", () => {
    const measured = measure(
      "tool_outcomes",
      evaluationInput({ toolResults: [toolResult({ status: "denied" })] }),
      {
        parameters: { deniedCountsAsFailure: false },
      },
    );
    expect(measured.score).toBe(1);
    expect(measured.findings[0]?.code).toBe("tools_not_graded");
  });

  it("observes slow tools without changing the score", () => {
    const measured = measure(
      "tool_outcomes",
      evaluationInput({ toolResults: [toolResult({ durationMs: 900 })] }),
      {
        parameters: { maxDurationMs: 200 },
      },
    );
    expect(measured.score).toBe(1);
    expect(measured.findings.map((entry) => entry.code)).toEqual(["tool_slow"]);
    expect(
      measure("tool_outcomes", evaluationInput({ toolResults: [toolResult({ durationMs: 900 })] }))
        .findings[0]?.code,
    ).toBe("tools_succeeded");
  });
});
