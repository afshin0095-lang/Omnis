import { describe, expect, it } from "vitest";
import { createExecutionId, createPolicyId } from "@omnis/types";
import { MATCH_ALL_TARGET, MAX_POLICY_RULES, numericConstraint } from "@omnis/ai-core-types";
import { ConflictError, NotFoundError, PolicyViolationError, ValidationError } from "@omnis/errors";
import { createExecutionContext } from "@omnis/execution-context";
import { InMemoryPolicyEngine, assertValidPolicySet } from "./InMemoryPolicyEngine.js";
import {
  AT,
  constraint,
  evaluationInput,
  FIXTURE_IDS,
  policySet,
  policySetInput,
  rule,
  ruleInput,
} from "./testSupport.js";
import type { ConstraintSpecInput } from "./policyValidation.js";

function engine(maxPolicySets = 32): InMemoryPolicyEngine {
  return new InMemoryPolicyEngine({ clock: () => AT, maxPolicySets });
}

describe("registration", () => {
  it("stores a frozen, versioned set and fills in the rule defaults", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        name: "governance",
        rules: [
          {
            id: "first.rule",
            name: "First rule",
            outcome: "constrain",
            constraints: [constraint("max_steps", 4, "first.rule")],
          },
        ],
        defaultOutcome: "deny",
      }),
    );

    expect(set.id.startsWith("pol_")).toBe(true);
    expect(set.version).toBe(1);
    expect(set.name).toBe("governance");
    expect(set.description).toBe("A registration input built by the fixture.");
    expect(set.createdAt).toBe(AT);
    expect(set.rules).toHaveLength(1);

    const built = set.rules[0];
    expect(built).toBeDefined();
    if (built === undefined) {
      return;
    }
    expect(built.description).toBe("");
    expect(built.target).toEqual(MATCH_ALL_TARGET);
    expect(built.conditions).toEqual([]);
    expect(built.priority).toBe(100);
    expect(built.enabled).toBe(true);
    expect(built.metadata).toEqual({});
    // A constraint supplied without a reason is stored with one, so every reader sees the
    // same shape.
    expect(built.constraints[0]).toEqual({
      kind: "max_steps",
      value: 4,
      source: "first.rule",
      reason: null,
    });

    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.rules)).toBe(true);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.target)).toBe(true);
    expect(Object.isFrozen(built.constraints[0])).toBe(true);
    expect(Object.isFrozen(set.metadata)).toBe(true);
    expect(eng.size).toBe(1);
  });

  it("keeps a caller-supplied identifier", () => {
    const eng = engine();
    const policyId = createPolicyId();
    expect(eng.registerPolicySet(policySetInput({ id: policyId })).id).toBe(policyId);
  });

  it("normalizes a partial rule target against the match-all target", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        rules: [
          { id: "scoped", name: "Scoped", outcome: "deny", target: { action: "tool.invoke" } },
        ],
      }),
    );
    const built = set.rules[0];
    expect(built?.target.action).toBe("tool.invoke");
    expect(built?.target.subject).toBeNull();
    expect(built?.target.minimumRiskLevel).toBeNull();
  });

  it("rejects a duplicate policy identifier", () => {
    const eng = engine();
    const policyId = createPolicyId();
    eng.registerPolicySet(policySetInput({ id: policyId, name: "first" }));
    expect(() => eng.registerPolicySet(policySetInput({ id: policyId, name: "second" }))).toThrow(
      ConflictError,
    );
    expect(eng.size).toBe(1);
    expect(eng.requirePolicySet(policyId).name).toBe("first");
  });

  it("rejects duplicate rule identifiers inside one set", () => {
    const eng = engine();
    expect(() =>
      eng.registerPolicySet(
        policySetInput({
          rules: [ruleInput({ id: "same" }), ruleInput({ id: "same", name: "Other" })],
        }),
      ),
    ).toThrow(ConflictError);
    expect(eng.size).toBe(0);
  });

  it("enforces capacity", () => {
    const eng = engine(2);
    eng.registerPolicySet(policySetInput({ name: "one" }));
    eng.registerPolicySet(policySetInput({ name: "two" }));
    expect(() => eng.registerPolicySet(policySetInput({ name: "three" }))).toThrow(ConflictError);
    expect(eng.size).toBe(2);
  });

  it("rejects an invalid capacity", () => {
    expect(() => new InMemoryPolicyEngine({ maxPolicySets: 0 })).toThrow(RangeError);
    expect(() => new InMemoryPolicyEngine({ maxPolicySets: 2.5 })).toThrow(RangeError);
  });

  it("validates the shape of a set and its rules", () => {
    const eng = engine();
    expect(() => eng.registerPolicySet(policySetInput({ name: "" }))).toThrow(ValidationError);
    expect(() =>
      eng.registerPolicySet(policySetInput({ rules: [ruleInput({ id: "Bad Id" })] })),
    ).toThrow(ValidationError);
    const bogusConstraint = [
      { kind: "not_a_kind", value: 1, source: "x" },
    ] as unknown as readonly ConstraintSpecInput[];
    expect(() =>
      eng.registerPolicySet(
        policySetInput({ rules: [ruleInput({ constraints: bogusConstraint })] }),
      ),
    ).toThrow(ValidationError);
    expect(() => eng.registerPolicySet(policySetInput({ createdAt: "yesterday" }))).toThrow(
      ValidationError,
    );
    expect(() =>
      eng.registerPolicySet(
        policySetInput({
          rules: Array.from({ length: MAX_POLICY_RULES + 1 }, (_, index) =>
            ruleInput({ id: `rule.${String(index)}` }),
          ),
        }),
      ),
    ).toThrow(ValidationError);
    expect(eng.size).toBe(0);
  });

  it("redacts secret-looking metadata instead of storing it", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        metadata: { apiKey: "AIza" + "A".repeat(35), owner: "platform" },
        rules: [ruleInput({ metadata: { token: "sk-" + "b".repeat(40) } })],
      }),
    );
    expect(String(set.metadata["apiKey"])).not.toContain("AIza");
    expect(set.metadata["owner"]).toBe("platform");
    expect(String(set.rules[0]?.metadata["token"])).not.toContain("sk-");
  });
});

describe("lookup and listing", () => {
  it("finds, requires and reports absence", () => {
    const eng = engine();
    const set = eng.registerPolicySet(policySetInput({ name: "stored" }));
    expect(eng.getPolicySet(set.id)).toBe(set);
    expect(eng.requirePolicySet(set.id)).toBe(set);
    expect(eng.has(set.id)).toBe(true);

    const missing = createPolicyId();
    expect(eng.getPolicySet(missing)).toBeNull();
    expect(eng.has(missing)).toBe(false);
    expect(() => eng.requirePolicySet(missing)).toThrow(NotFoundError);
    expect(() => eng.evaluate(missing, evaluationInput())).toThrow(NotFoundError);
  });

  it("removes a set", () => {
    const eng = engine();
    const set = eng.registerPolicySet(policySetInput({ name: "gone" }));
    expect(eng.remove(set.id)).toBe(true);
    expect(eng.remove(set.id)).toBe(false);
    expect(eng.has(set.id)).toBe(false);
  });

  it("lists by name then identifier", () => {
    const eng = engine();
    eng.registerPolicySet(policySetInput({ name: "zulu" }));
    eng.registerPolicySet(policySetInput({ name: "alpha" }));
    eng.registerPolicySet(policySetInput({ name: "alpha" }));
    expect(eng.list().map((candidate) => candidate.name)).toEqual(["alpha", "alpha", "zulu"]);
    expect(Object.isFrozen(eng.list())).toBe(true);
  });
});

describe("revision", () => {
  it("increments the version and leaves the previous set untouched", () => {
    const eng = engine();
    const v1 = eng.registerPolicySet(
      policySetInput({ name: "versioned", rules: [ruleInput({ id: "one", outcome: "allow" })] }),
    );
    const v2 = eng.addRule(v1.id, ruleInput({ id: "two", outcome: "constrain" }));
    expect(v2.version).toBe(2);
    expect(v1.version).toBe(1);
    expect(v1.rules).toHaveLength(1);
    expect(v2.rules.map((candidate) => candidate.id)).toEqual(["one", "two"]);
    expect(eng.requirePolicySet(v1.id)).toBe(v2);
  });

  it("replaces, adds and removes rules", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({ rules: [ruleInput({ id: "a" }), ruleInput({ id: "b" })] }),
    );
    expect(
      eng.setRules(set.id, [ruleInput({ id: "c" })]).rules.map((candidate) => candidate.id),
    ).toEqual(["c"]);
    expect(eng.requirePolicySet(set.id).version).toBe(2);
    expect(eng.removeRule(set.id, "c").rules).toEqual([]);
    expect(eng.requirePolicySet(set.id).version).toBe(3);
    // Removing a rule that is not there is still a revision: the caller asked for a change
    // and the engine records that the set was rewritten.
    expect(eng.removeRule(set.id, "absent").version).toBe(4);
  });

  it("changes the default outcome and the baseline constraints", () => {
    const eng = engine();
    const set = eng.registerPolicySet(policySetInput({ defaultOutcome: "deny" }));
    expect(eng.setDefaultOutcome(set.id, "constrain").defaultOutcome).toBe("constrain");
    const constrained = eng.setBaselineConstraints(set.id, [
      constraint("max_retries", 1, "baseline", "one retry only"),
    ]);
    expect(constrained.baselineConstraints).toEqual([
      { kind: "max_retries", value: 1, source: "baseline", reason: "one retry only" },
    ]);
    expect(constrained.version).toBe(3);
  });

  it("validates a revision before storing it", () => {
    const eng = engine();
    const set = eng.registerPolicySet(policySetInput({}));
    expect(() => eng.addRule(set.id, ruleInput({ id: "dup" }))).not.toThrow();
    expect(() => eng.addRule(set.id, ruleInput({ id: "dup", name: "Duplicate" }))).toThrow(
      ConflictError,
    );
    expect(() =>
      eng.setRules(
        set.id,
        Array.from({ length: MAX_POLICY_RULES + 1 }, (_, index) =>
          ruleInput({ id: `rule.${String(index)}` }),
        ),
      ),
    ).toThrow();
    // A rejected revision leaves the stored set exactly as it was.
    expect(eng.requirePolicySet(set.id).version).toBe(2);
    expect(eng.requirePolicySet(set.id).rules.map((candidate) => candidate.id)).toEqual(["dup"]);
  });

  it("throws for an unknown policy", () => {
    const missing = createPolicyId();
    expect(() => engine().addRule(missing, ruleInput({}))).toThrow(NotFoundError);
    expect(() => engine().setDefaultOutcome(missing, "allow")).toThrow(NotFoundError);
  });
});

describe("assertValidPolicySet", () => {
  it("accepts a well-formed set", () => {
    expect(() => assertValidPolicySet(policySet({ rules: [rule({ id: "a" })] }))).not.toThrow();
    expect(() =>
      assertValidPolicySet(
        policySet({ defaultOutcome: "allow", rules: [rule({ id: "a", outcome: "allow" })] }),
      ),
    ).not.toThrow();
  });

  it("refuses an empty set that allows everything", () => {
    expect(() => assertValidPolicySet(policySet({ defaultOutcome: "allow", rules: [] }))).toThrow(
      ValidationError,
    );
  });

  it("refuses duplicate rule identifiers and an oversized set", () => {
    expect(() =>
      assertValidPolicySet(policySet({ rules: [rule({ id: "a" }), rule({ id: "a" })] })),
    ).toThrow(ConflictError);
    expect(() =>
      assertValidPolicySet(
        policySet({
          rules: Array.from({ length: MAX_POLICY_RULES + 1 }, (_, index) =>
            rule({ id: `r${String(index)}` }),
          ),
        }),
      ),
    ).toThrow(RangeError);
  });
});

describe("evaluation through the engine", () => {
  it("stamps decisions with the engine clock", () => {
    const eng = new InMemoryPolicyEngine({ clock: () => "2026-06-06T06:06:06.000Z" });
    const set = eng.registerPolicySet(policySetInput({ defaultOutcome: "allow" }));
    expect(eng.evaluate(set.id, evaluationInput()).evaluatedAt).toBe("2026-06-06T06:06:06.000Z");
  });

  it("honors the includeDisabledRules option", () => {
    const quiet = engine();
    const verbose = new InMemoryPolicyEngine({ clock: () => AT, includeDisabledRules: true });
    const input = policySetInput({
      rules: [ruleInput({ id: "off", enabled: false })],
      defaultOutcome: "allow",
    });
    expect(
      quiet.evaluate(quiet.registerPolicySet(input).id, evaluationInput()).rulesEvaluated,
    ).toEqual([]);
    expect(
      verbose
        .evaluate(verbose.registerPolicySet(input).id, evaluationInput())
        .rulesEvaluated.map((entry) => entry.ruleId),
    ).toEqual(["off"]);
  });

  it("derives an input from an execution context", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        defaultOutcome: "allow",
        rules: [
          ruleInput({
            id: "prod",
            name: "Production",
            outcome: "deny",
            target: { environment: "production" },
          }),
        ],
      }),
    );
    const context = createExecutionContext({
      tenantId: FIXTURE_IDS.tenantId,
      metadata: { environment: "production" },
    });
    const decision = eng.evaluateWithContext(set.id, context, {
      action: "tool.invoke",
      subject: "agent",
    });
    expect(decision.outcome).toBe("deny");
    expect(decision.executionId).toBe(context.executionId);
  });

  it("enforces a decision with assertPermitted", () => {
    const eng = engine();
    const allow = eng.registerPolicySet(policySetInput({ defaultOutcome: "allow" }));
    const deny = eng.registerPolicySet(
      policySetInput({ name: "deny-set", defaultOutcome: "deny" }),
    );
    expect(eng.assertPermitted(allow.id, evaluationInput()).outcome).toBe("allow");
    expect(() => eng.assertPermitted(deny.id, evaluationInput())).toThrow(PolicyViolationError);
  });
});

describe("gate", () => {
  it("takes the most restrictive outcome across sets and accumulates constraints", () => {
    const eng = engine();
    const permissive = eng.registerPolicySet(
      policySetInput({
        name: "permissive",
        defaultOutcome: "allow",
        rules: [ruleInput({ id: "allow-all", outcome: "allow" })],
        baselineConstraints: [constraint("max_retries", 5, "permissive")],
      }),
    );
    const strict = eng.registerPolicySet(
      policySetInput({
        name: "strict",
        defaultOutcome: "constrain",
        rules: [
          ruleInput({
            id: "limit",
            outcome: "constrain",
            constraints: [constraint("max_steps", 3, "strict.limit")],
          }),
        ],
        baselineConstraints: [constraint("max_retries", 1, "strict")],
      }),
    );

    const gate = eng.gate(evaluationInput(), [permissive.id, strict.id]);
    expect(gate.outcome).toBe("constrain");
    expect(gate.decidedByPolicyId).toBe(strict.id);
    expect(gate.decidedByRuleId).toBe("limit");
    expect(gate.reason).toBeNull();
    expect(gate.deterministic).toBe(true);
    expect(gate.decisions).toHaveLength(2);
    // Order follows the caller's policy id order, so constraints are reproducible.
    expect(gate.constraints.map((entry) => entry.source)).toEqual([
      "permissive",
      "strict",
      "strict.limit",
    ]);
    expect(numericConstraint(gate.constraints, "max_retries")).toBe(1);
    expect(Object.isFrozen(gate)).toBe(true);
  });

  it("names the first set that produced the winning outcome", () => {
    const eng = engine();
    const first = eng.registerPolicySet(policySetInput({ name: "first", defaultOutcome: "deny" }));
    const second = eng.registerPolicySet(
      policySetInput({ name: "second", defaultOutcome: "deny" }),
    );
    const gate = eng.gate(evaluationInput(), [second.id, first.id]);
    expect(gate.decidedByPolicyId).toBe(second.id);
    expect(gate.reason).toContain("no rule matched");
  });

  it("evaluates a repeated identifier once", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        defaultOutcome: "constrain",
        baselineConstraints: [constraint("max_steps", 3, "baseline")],
      }),
    );
    const gate = eng.gate(evaluationInput(), [set.id, set.id, set.id]);
    expect(gate.decisions).toHaveLength(1);
    expect(gate.constraints).toHaveLength(1);
  });

  it("fails closed when no policy set is supplied", () => {
    const gate = engine().gate(evaluationInput(), []);
    expect(gate.outcome).toBe("deny");
    expect(gate.decidedByPolicyId).toBeNull();
    expect(gate.reason).toContain("no policy sets");
    expect(gate.decisions).toEqual([]);
  });

  it("throws for an unknown identifier in the list", () => {
    const eng = engine();
    const set = eng.registerPolicySet(policySetInput({}));
    expect(() => eng.gate(evaluationInput(), [set.id, createPolicyId()])).toThrow(NotFoundError);
  });

  it("gates an action derived from an execution context", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        defaultOutcome: "allow",
        rules: [ruleInput({ id: "prod", outcome: "deny", target: { environment: "production" } })],
      }),
    );
    const context = createExecutionContext({ metadata: { environment: "production" } });
    const gate = eng.gateWithContext(context, { action: "model.call", subject: "orchestrator" }, [
      set.id,
    ]);
    expect(gate.outcome).toBe("deny");
    expect(gate.executionId).toBe(context.executionId);
  });

  it("is deterministic across repeated calls", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        defaultOutcome: "constrain",
        rules: [ruleInput({ id: "a", outcome: "allow" })],
      }),
    );
    const input = evaluationInput({ executionId: createExecutionId() });
    expect(eng.gate(input, [set.id])).toEqual(eng.gate(input, [set.id]));
  });
});

describe("stored rules", () => {
  it("keeps a hand-built rule's identity when it is registered through the engine", () => {
    const eng = engine();
    const set = eng.registerPolicySet(
      policySetInput({
        rules: [ruleInput({ id: "kept", name: "Kept", outcome: "deny", priority: 3 })],
      }),
    );
    expect(set.rules[0]).toMatchObject({
      id: "kept",
      name: "Kept",
      outcome: "deny",
      priority: 3,
      enabled: true,
    });
    expect(rule({ id: "unused" }).id).toBe("unused");
  });
});
