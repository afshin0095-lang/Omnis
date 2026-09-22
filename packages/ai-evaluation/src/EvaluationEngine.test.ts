import { describe, expect, it } from "vitest";
import { createCorrelationId, createTenantId } from "@omnis/types";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { createExecutionContext } from "@omnis/execution-context";
import { MAX_EVALUATION_RULES } from "@omnis/ai-core-types";
import {
  createEvaluationEngine,
  DEFAULT_EVALUATION_RULE_SET_NAME,
  InMemoryEvaluationEngine,
} from "./EvaluationEngine.js";
import { EVALUATION_RULE_KEYS, ruleSpecFor } from "./EvaluationRules.js";
import { evaluationResultSchema, evaluationRuleSetSchema } from "./evaluationValidation.js";
import { AT, AT_MS, evaluationInput, providerFailure } from "./testSupport.js";

/** An engine on a fixed clock, with the shipped defaults. */
function engine(
  overrides: ConstructorParameters<typeof InMemoryEvaluationEngine>[0] = {},
): InMemoryEvaluationEngine {
  return new InMemoryEvaluationEngine({ clock: () => AT_MS, ...overrides });
}

describe("construction", () => {
  it("registers the shipped default rule set", () => {
    const subject = engine();
    expect(subject.size).toBe(1);
    const set = subject.requireRuleSet(DEFAULT_EVALUATION_RULE_SET_NAME);
    expect(set.name).toBe("default");
    expect(set.version).toBe(1);
    expect(set.rules.map((rule) => rule.id)).toEqual([...EVALUATION_RULE_KEYS]);
    expect(set.createdAt).toBe(AT);
    expect(set.updatedAt).toBe(AT);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.rules)).toBe(true);
    expect(evaluationRuleSetSchema.safeParse(set).success).toBe(true);
  });

  it("can start empty", () => {
    const subject = engine({ registerDefaults: false });
    expect(subject.size).toBe(0);
    expect(() => subject.evaluate(evaluationInput())).toThrow(NotFoundError);
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => engine({ maxRuleSets: 0 })).toThrow(RangeError);
    expect(() => engine({ maxRuleSets: 1.5 })).toThrow(RangeError);
  });

  it("is available through the factory", () => {
    expect(createEvaluationEngine({ clock: () => AT_MS })).toBeInstanceOf(InMemoryEvaluationEngine);
  });
});

describe("evaluation", () => {
  it("grades a clean execution as a pass", () => {
    const subject = engine();
    const input = evaluationInput();
    const result = subject.evaluate(input);
    expect(result.id.startsWith("evl_")).toBe(true);
    expect(result.executionId).toBe(input.executionId);
    expect(result.verdict).toBe("pass");
    expect(result.overallScore).toBe(1);
    expect(result.scores).toHaveLength(7);
    expect(result.rulesApplied).toHaveLength(8);
    expect(result.evaluatedAt).toBe(AT);
    expect(result.deterministic).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(evaluationResultSchema.safeParse(result).success).toBe(true);
  });

  it("records which rule set and version produced the result", () => {
    const subject = engine();
    const result = subject.evaluate(evaluationInput());
    expect(result.metadata["ruleSet"]).toBe("default");
    expect(result.metadata["ruleSetVersion"]).toBe(1);
    expect(result.metadata["rulesApplied"]).toBe(8);
    expect(result.metadata["rulesAvailable"]).toBe(8);

    subject.setRules(DEFAULT_EVALUATION_RULE_SET_NAME, [ruleSpecFor("completion")]);
    const after = subject.evaluate(evaluationInput());
    expect(after.metadata["ruleSetVersion"]).toBe(2);
    expect(after.rulesApplied).toEqual(["completion"]);
    // The first result still names the version that produced it, which is the whole point of
    // versioning the set instead of editing it.
    expect(result.metadata["ruleSetVersion"]).toBe(1);
  });

  it("fails an execution that failed", () => {
    const subject = engine();
    const result = subject.evaluate(
      evaluationInput({
        failure: providerFailure("timeout", "the provider did not respond in time"),
        latencyMs: 45_000,
      }),
    );
    expect(result.verdict).toBe("fail");
    expect(result.overallScore).toBeLessThan(1);
    const codes = result.scores.flatMap((score) => score.findings.map((entry) => entry.code));
    expect(codes).toContain("execution_failed");
    expect(codes).toContain("latency_above_maximum");
  });

  it("grades a named rule set", () => {
    const subject = engine();
    subject.registerRuleSet({
      name: "strict-latency",
      description: "Latency only",
      rules: [
        ruleSpecFor("latency", {
          passThreshold: 1,
          warnThreshold: 1,
          parameters: { warnMs: 100, maxMs: 200 },
        }),
      ],
    });
    const result = subject.evaluate(evaluationInput({ latencyMs: 1_200 }), {
      ruleSet: "strict-latency",
    });
    expect(result.verdict).toBe("fail");
    expect(result.rulesApplied).toEqual(["latency"]);
    expect(result.metadata["ruleSet"]).toBe("strict-latency");
    expect(() => subject.evaluate(evaluationInput(), { ruleSet: "nope" })).toThrow(NotFoundError);
  });

  it("restricts a run to chosen rules, in the set's order", () => {
    const subject = engine();
    const result = subject.evaluate(evaluationInput(), { rules: ["cost", "completion"] });
    expect(result.rulesApplied).toEqual(["completion", "cost"]);
    const reversed = subject.evaluate(evaluationInput(), { rules: ["completion", "cost"] });
    expect(JSON.stringify(reversed.scores)).toBe(JSON.stringify(result.scores));
    expect(() => subject.evaluate(evaluationInput(), { rules: ["nope"] })).toThrow(NotFoundError);
  });

  it("carries correlation identity into metadata without scoring it", () => {
    const subject = engine();
    const context = createExecutionContext(
      { correlationId: createCorrelationId(), tenantId: createTenantId() },
      { clock: () => AT_MS },
    );
    const result = subject.evaluate(evaluationInput(), { context });
    expect(result.metadata["correlationId"]).toBe(context.correlationId);
    expect(result.metadata["tenantId"]).toBe(context.tenantId);
    expect(result.verdict).toBe("pass");
  });

  it("redacts secret-looking metadata and keeps caller tags", () => {
    const subject = engine();
    const result = subject.evaluate(evaluationInput(), {
      metadata: { apiKey: "AIza" + "A".repeat(35), tier: "gold" },
    });
    expect(result.metadata["tier"]).toBe("gold");
    expect(String(result.metadata["apiKey"])).not.toContain("AIza");
  });

  it("refuses an input that is missing facts", () => {
    const subject = engine();
    expect(() => subject.evaluate({ executionId: "" } as never)).toThrow(ValidationError);
  });

  it("produces identical documents for identical facts", () => {
    const subject = engine();
    const input = evaluationInput({ latencyMs: 9_000, expected: { rows: 3 } });
    const first = subject.evaluate(input);
    const second = subject.evaluate(input);
    expect(second.verdict).toBe(first.verdict);
    expect(second.overallScore).toBe(first.overallScore);
    expect(JSON.stringify(second.scores)).toBe(JSON.stringify(first.scores));
    expect(second.evaluatedAt).toBe(first.evaluatedAt);
    expect(second.id).not.toBe(first.id);
  });
});

describe("rule set registration", () => {
  it("stores a custom set and validates it against the published contract", () => {
    const subject = engine({ registerDefaults: false });
    const set = subject.registerRuleSet({
      name: "release-gate",
      description: "The gate a release has to pass",
      rules: [ruleSpecFor("completion"), ruleSpecFor("output_schema")],
      createdAt: AT,
    });
    expect(set.version).toBe(1);
    expect(set.rules).toHaveLength(2);
    expect(evaluationRuleSetSchema.safeParse(set).success).toBe(true);
    expect(subject.hasRuleSet("release-gate")).toBe(true);
    expect(subject.getRuleSet("release-gate")).toBe(set);
    expect(subject.getRuleSet("missing")).toBeNull();
    expect(() => subject.requireRuleSet("missing")).toThrow(NotFoundError);
  });

  it("rejects a duplicate name, a bad name and a nonsensical rule list", () => {
    const subject = engine();
    expect(() => subject.registerRuleSet({ name: "default" })).toThrow(ConflictError);
    expect(() => subject.registerRuleSet({ name: "Not A Slug" })).toThrow(ValidationError);
    expect(() => subject.registerRuleSet({ name: "x" })).toThrow(ValidationError);
    expect(() =>
      subject.registerRuleSet({
        name: "bad-rule",
        rules: [{ ...ruleSpecFor("latency"), dimension: "cost" }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      subject.registerRuleSet({
        name: "bad-key",
        rules: [{ ...ruleSpecFor("latency"), parameters: { rule: "vibes" } }],
      }),
    ).toThrow(/not one of/);
    expect(() =>
      subject.registerRuleSet({
        name: "dupes",
        rules: [ruleSpecFor("completion"), ruleSpecFor("completion")],
      }),
    ).toThrow(ConflictError);
    expect(() => subject.registerRuleSet({ name: "too-many", rules: manyRules() })).toThrow(
      ValidationError,
    );
    expect(() => subject.registerRuleSet({ name: "no-time", createdAt: "yesterday" })).toThrow(
      ValidationError,
    );
    expect(subject.size).toBe(1);
  });

  it("enforces capacity", () => {
    const subject = engine({ registerDefaults: false, maxRuleSets: 2 });
    subject.registerRuleSet({ name: "one" });
    subject.registerRuleSet({ name: "two" });
    expect(() => subject.registerRuleSet({ name: "three" })).toThrow(ConflictError);
    expect(subject.removeRuleSet("one")).toBe(true);
    expect(subject.removeRuleSet("one")).toBe(false);
    expect(() => subject.registerRuleSet({ name: "three" })).not.toThrow();
  });

  it("lists sets by name", () => {
    const subject = engine({ registerDefaults: false });
    subject.registerRuleSet({ name: "zebra" });
    subject.registerRuleSet({ name: "alpha" });
    expect(subject.listRuleSets().map((set) => set.name)).toEqual(["alpha", "zebra"]);
    expect(Object.isFrozen(subject.listRuleSets())).toBe(true);
  });
});

describe("editing a rule set", () => {
  it("increments the version and stamps the edit time", () => {
    let now = AT_MS;
    const subject = new InMemoryEvaluationEngine({ clock: () => now, registerDefaults: false });
    const first = subject.registerRuleSet({
      name: "gate",
      rules: [ruleSpecFor("completion")],
      createdAt: AT,
    });
    now = AT_MS + 60_000;
    const second = subject.setRules("gate", [ruleSpecFor("completion"), ruleSpecFor("cost")]);
    expect(second.version).toBe(2);
    expect(second.rules).toHaveLength(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe("2026-02-25T06:14:20.000Z");
    // The previously returned set is untouched: a reader holding it sees what it saw.
    expect(first.version).toBe(1);
    expect(first.rules).toHaveLength(1);
    expect(subject.requireRuleSet("gate")).toBe(second);
  });

  it("adds a new rule and replaces an existing one by identifier", () => {
    const subject = engine({ registerDefaults: false });
    subject.registerRuleSet({ name: "gate", rules: [ruleSpecFor("completion")] });
    const added = subject.upsertRule("gate", ruleSpecFor("cost"));
    expect(added.rules.map((rule) => rule.id)).toEqual(["completion", "cost"]);
    expect(added.version).toBe(2);

    const replaced = subject.upsertRule("gate", ruleSpecFor("cost", { weight: 9 }));
    expect(replaced.rules.map((rule) => rule.id)).toEqual(["completion", "cost"]);
    expect(replaced.version).toBe(3);
    expect(replaced.rules[1]?.weight).toBe(9);
  });

  it("refuses an edit that would exceed the rule limit", () => {
    const subject = engine({ registerDefaults: false });
    subject.registerRuleSet({ name: "gate", rules: manyRules(MAX_EVALUATION_RULES) });
    expect(() => subject.upsertRule("gate", ruleSpecFor("cost", { id: "one-too-many" }))).toThrow(
      ValidationError,
    );
    expect(() => subject.upsertRule("missing", ruleSpecFor("cost"))).toThrow(NotFoundError);
  });

  it("removes a rule and refuses an unknown identifier", () => {
    const subject = engine({ registerDefaults: false });
    subject.registerRuleSet({
      name: "gate",
      rules: [ruleSpecFor("completion"), ruleSpecFor("cost")],
    });
    const removed = subject.removeRule("gate", "cost");
    expect(removed.rules.map((rule) => rule.id)).toEqual(["completion"]);
    expect(removed.version).toBe(2);
    expect(() => subject.removeRule("gate", "cost")).toThrow(NotFoundError);
    expect(() => subject.removeRule("missing", "completion")).toThrow(NotFoundError);
  });

  it("re-validates every edit against the published contract", () => {
    const subject = engine({ registerDefaults: false });
    subject.registerRuleSet({ name: "gate", rules: [ruleSpecFor("completion")] });
    expect(() => subject.setRules("gate", [{ ...ruleSpecFor("completion"), weight: -1 }])).toThrow(
      ValidationError,
    );
    expect(() =>
      subject.setRules("gate", [
        { ...ruleSpecFor("completion"), passThreshold: 0.1, warnThreshold: 0.9 },
      ]),
    ).toThrow(ValidationError);
    // The failed edit left the stored set alone.
    expect(subject.requireRuleSet("gate").rules).toHaveLength(1);
    expect(subject.requireRuleSet("gate").version).toBe(1);
  });
});

/** A list of uniquely identified completion rules. */
function manyRules(count: number = MAX_EVALUATION_RULES + 1) {
  return Array.from({ length: count }, (_unused, index) =>
    ruleSpecFor("completion", { id: `completion-${String(index).padStart(2, "0")}` }),
  );
}
