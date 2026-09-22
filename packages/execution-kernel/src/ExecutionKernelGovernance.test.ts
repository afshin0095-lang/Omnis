import { describe, expect, it } from "vitest";
import { createBudgetId, createExecutionId, createPolicyId } from "@omnis/types";
import { budgetHold, numericConstraint } from "@omnis/ai-core-types";
import type { ExecutionRecord, PolicyId, PolicyOutcome } from "@omnis/ai-core-types";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import type { BudgetLimitInput } from "@omnis/budget-engine";
import { InMemoryPolicyEngine } from "@omnis/policy-engine";
import type { PolicyEngine, PolicyRuleInput } from "@omnis/policy-engine";
import { ConflictError } from "@omnis/errors";
import { InMemoryExecutionKernel } from "./ExecutionKernel.js";
import { executionPlan } from "./plans.js";
import { stepExecutor, succeededOutcome } from "./StepExecutor.js";
import type { StepExecutor } from "./StepExecutor.js";
import {
  AT,
  AT_MS,
  allowAllPolicyEngine,
  budgetHarness,
  byDimension,
  denyAllPolicyEngine,
  executionRequest,
  flakyExecutor,
  okExecutor,
  usage,
} from "./testSupport.js";

/** A rule that matches everything and does one thing. */
function rule(
  id: string,
  outcome: PolicyOutcome,
  extra: Partial<PolicyRuleInput> = {},
): PolicyRuleInput {
  return { id, name: id, outcome, ...extra };
}

/** A policy engine holding one set with the given rules. */
function policyWith(
  rules: readonly PolicyRuleInput[],
  defaultOutcome: PolicyOutcome = "allow",
): { engine: PolicyEngine; policyId: PolicyId } {
  const engine = new InMemoryPolicyEngine({ clock: () => AT });
  const set = engine.registerPolicySet({
    name: "run-policy",
    defaultOutcome,
    rules,
    createdAt: AT,
  });
  return { engine, policyId: set.id };
}

/** A constraint a rule may impose. */
function constraint(kind: "max_duration_ms" | "max_retries" | "max_steps", value: number) {
  return { kind, value, source: "test-rule" } as const;
}

/** The failure a record ended with, or null when it did not fail. */
function failureOf(record: ExecutionRecord) {
  return record.result !== null && record.result.status !== "succeeded"
    ? record.result.failure
    : null;
}

/** The statuses a record passed through, with consecutive repeats collapsed. */
function statusTrail(record: ExecutionRecord): readonly string[] {
  const trail: string[] = [];
  for (const entry of record.timeline) {
    if (trail[trail.length - 1] !== entry.status) {
      trail.push(entry.status);
    }
  }
  return trail;
}

/** Every timeline note, for the suites that assert what the kernel said about itself. */
function notesOf(record: ExecutionRecord): readonly string[] {
  return record.timeline.map((entry) => entry.note ?? "");
}

/** A budget engine whose ledger refuses to accept a commit. */
class UnwritableBudgetEngine extends InMemoryBudgetEngine {
  override commit(): never {
    throw new Error("ledger unavailable");
  }
}

describe("policy gate", () => {
  it("denies before a single step runs", async () => {
    const { engine, policyId } = denyAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor("never reached")],
    });
    const record = await kernel.execute(executionRequest({ policyId }));

    expect(record.status).toBe("failed");
    expect(statusTrail(record)).toEqual(["created", "validated", "failed"]);
    expect(record.attempts).toEqual([]);
    expect(record.plan).toBeNull();
    expect(record.governance.policyOutcome).toBe("deny");
    expect(record.governance.policyId).toBe(policyId);
    expect(failureOf(record)?.class).toBe("policy_blocked");
    expect(failureOf(record)?.code).toBe("policy_violation");
    expect(notesOf(record).some((note) => note.startsWith("policy denied"))).toBe(true);
  });

  it("runs when policy allows, and records which set decided", async () => {
    const { engine, policyId } = allowAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest({ policyId }));

    expect(record.status).toBe("succeeded");
    expect(statusTrail(record)).toEqual([
      "created",
      "validated",
      "authorized",
      "planned",
      "running",
      "succeeded",
    ]);
    expect(record.governance.policyOutcome).toBe("allow");
    expect(record.governance.policyId).toBe(policyId);
    expect(notesOf(record)).toContain("policy allowed (1 set(s))");
  });

  it("refuses a run that needs an approval nobody gave", async () => {
    const { engine, policyId } = policyWith([rule("needs-sign-off", "require_approval")]);
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor("never reached")],
    });
    const record = await kernel.execute(executionRequest({ policyId }));

    expect(record.status).toBe("failed");
    expect(record.attempts).toEqual([]);
    expect(record.governance.policyOutcome).toBe("require_approval");
    expect(failureOf(record)?.code).toBe("policy_violation");
    expect(failureOf(record)?.message).toMatch(/requires approval/);
    expect(notesOf(record).some((note) => note.startsWith("approval required"))).toBe(true);
  });

  it("runs once the approval is granted, and refuses an approval that says no", async () => {
    const { engine, policyId } = policyWith([rule("needs-sign-off", "require_approval")]);
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });

    const approved = await kernel.execute(executionRequest(), {
      approval: { approved: true, approver: "operations", approvedAt: AT },
      policyIds: [policyId],
    });
    expect(approved.status).toBe("succeeded");

    const refused = await kernel.execute(executionRequest(), {
      approval: { approved: false, approver: "operations", approvedAt: AT },
      policyIds: [policyId],
    });
    expect(refused.status).toBe("failed");
    expect(refused.governance.policyOutcome).toBe("require_approval");
  });

  it("lets a deny in one set beat an allow in another", async () => {
    // One engine holds both sets: precedence is a property of the evaluation, not of the wiring.
    const engine = new InMemoryPolicyEngine({ clock: () => AT });
    const deny = engine.registerPolicySet({
      name: "deny-all",
      defaultOutcome: "deny",
      rules: [],
      createdAt: AT,
    });
    const allow = engine.registerPolicySet({
      name: "allow-all",
      defaultOutcome: "allow",
      rules: [],
      createdAt: AT,
    });
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest(), { policyIds: [allow.id, deny.id] });

    expect(record.status).toBe("failed");
    expect(record.governance.policyOutcome).toBe("deny");
    expect(record.governance.policyId).toBe(deny.id);
  });

  it("bounds a step's duration when policy constrains it", async () => {
    const { engine, policyId } = policyWith([
      rule("short-leash", "constrain", { constraints: [constraint("max_duration_ms", 20)] }),
    ]);
    const slow: StepExecutor = stepExecutor(
      "model",
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(succeededOutcome("too late")), 200);
        }),
    );
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [slow],
    });
    const record = await kernel.execute(executionRequest({ policyId }));

    expect(record.status).toBe("timed_out");
    expect(record.attempts[0]?.status).toBe("timed_out");
    expect(failureOf(record)?.class).toBe("deadline_exceeded");
    expect(failureOf(record)?.message).toMatch(/exceeded its 20ms timeout/);
  });

  it("caps retries, so a policy can stop a run from spending every attempt", async () => {
    const { engine, policyId } = policyWith([
      rule("no-retries", "constrain", { constraints: [constraint("max_retries", 0)] }),
    ]);
    const failing = flakyExecutor(9);
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [failing],
    });
    const request = executionRequest({ policyId });
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 3 }], createdAt: AT },
        () => AT_MS,
      ),
    });

    expect(failing.attempts).toBe(1);
    expect(record.attempts).toHaveLength(1);
    expect(record.status).toBe("failed");
  });

  it("refuses a plan with more steps than policy allows", async () => {
    const { engine, policyId } = policyWith([
      rule("one-step", "constrain", { constraints: [constraint("max_steps", 1)] }),
    ]);
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    const request = executionRequest({ policyId });
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "a" }, { id: "b" }], createdAt: AT },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("failed");
    expect(record.attempts).toEqual([]);
    expect(notesOf(record).some((note) => note.includes("policy allows at most 1 step"))).toBe(
      true,
    );
  });

  it("publishes the constraints it read, so a caller can see the same numbers the kernel used", () => {
    const { engine, policyId } = policyWith([
      rule("one-step", "constrain", { constraints: [constraint("max_steps", 4)] }),
    ]);
    const gate = engine.gate(
      {
        executionId: createExecutionId(),
        action: "execution.run",
        subject: "model",
        resource: "model",
        riskLevel: "low",
        environment: "test",
        tenantId: null,
        agentId: null,
        toolId: null,
        modelId: null,
        providerId: null,
        budgetId: null,
        attributes: {},
      },
      [policyId],
    );
    expect(gate.outcome).toBe("constrain");
    expect(numericConstraint(gate.constraints, "max_steps")).toBe(4);
    expect(numericConstraint(gate.constraints, "max_retries")).toBeNull();
  });

  it("resolves a policy named by registered name, not only by identifier", async () => {
    const { engine, policyId } = allowAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest({ policyId: "allow-all" }));
    expect(record.status).toBe("succeeded");
    expect(record.governance.policyId).toBe(policyId);
  });

  it("applies the kernel's default policy sets to a request that names none", async () => {
    const { engine, policyId } = denyAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      defaultPolicyIds: [policyId],
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest());
    expect(record.status).toBe("failed");
    expect(record.governance.policyId).toBe(policyId);
  });

  it("ignores a policy name that is not registered, rather than guessing at one", async () => {
    const { engine } = allowAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest({ policyId: "does-not-exist" }));
    expect(record.status).toBe("succeeded");
    expect(record.governance.policyOutcome).toBeNull();
    expect(notesOf(record)).toContain("no policy set applies");
  });

  it("fails closed when the policy engine itself throws", async () => {
    const broken = {
      gateWithContext: () => {
        throw new Error("policy store unreachable");
      },
    } as unknown as PolicyEngine;
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: broken,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest({ policyId: createPolicyId() }));
    expect(record.status).toBe("failed");
    expect(record.attempts).toEqual([]);
    expect(notesOf(record).some((note) => note.startsWith("policy evaluation failed"))).toBe(true);
  });

  it("authorizes without an engine, and says that it did", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    const record = await kernel.execute(executionRequest());
    expect(record.status).toBe("succeeded");
    expect(notesOf(record)).toContain("no policy engine configured");
    expect(record.governance.policyOutcome).toBeNull();
  });
});

describe("budget gate", () => {
  it("reserves before the work runs and commits what was actually consumed", async () => {
    const { engine, budgetId } = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [
        okExecutor({ answer: 1 }, usage({ requests: 2, totalTokens: 150, costMicro: 2_000 })),
      ],
    });
    const request = executionRequest({ budgetId });
    const record = await kernel.execute(request);

    expect(record.status).toBe("succeeded");
    expect(statusTrail(record)).toEqual([
      "created",
      "validated",
      "authorized",
      "reserved",
      "planned",
      "running",
      "succeeded",
    ]);
    expect(record.governance.budgetId).toBe(budgetId);
    expect(record.governance.budgetStatus).toBe("committed");

    const reservations = engine.reservationsForExecution(request.id);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.state).toBe("committed");
    expect(reservations[0]?.key).toBe(request.id);
    expect(byDimension(reservations[0]?.committed ?? [])).toEqual(
      byDimension([
        budgetHold("requests", 2),
        budgetHold("tokens", 150),
        budgetHold("cost_micro_usd", 2_000),
      ]),
    );
  });

  it("releases the reservation when the run consumed nothing", async () => {
    const { engine, budgetId } = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [stepExecutor("model", () => succeededOutcome("free"))],
    });
    const request = executionRequest({ budgetId });
    const record = await kernel.execute(request);

    expect(record.status).toBe("succeeded");
    expect(record.governance.budgetStatus).toBe("released");
    expect(engine.reservationsForExecution(request.id)[0]?.state).toBe("released");
    expect(engine.reservationsForExecution(request.id)[0]?.committed).toEqual([]);
  });

  it("refuses a reservation that exceeds the budget, before any work happens", async () => {
    const { engine, budgetId } = budgetHarness([
      { dimension: "requests", window: "execution", limit: 1 },
    ]);
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [okExecutor("never reached")],
    });
    const record = await kernel.execute(executionRequest({ budgetId }), {
      holds: [budgetHold("requests", 5)],
    });

    expect(record.status).toBe("failed");
    expect(statusTrail(record)).toEqual(["created", "validated", "authorized", "failed"]);
    expect(record.attempts).toEqual([]);
    expect(record.plan).toBeNull();
    expect(failureOf(record)?.class).toBe("budget_blocked");
    expect(record.governance.budgetStatus).toBeNull();
    expect(notesOf(record).some((note) => note.startsWith("budget refused the reservation"))).toBe(
      true,
    );
  });

  it("holds what the kernel's estimator says, and names the hold in the timeline", async () => {
    const { engine, budgetId } = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [okExecutor()],
      estimateHolds: () => [budgetHold("requests", 3), budgetHold("tokens", 900)],
    });
    const record = await kernel.execute(executionRequest({ budgetId }));
    expect(notesOf(record)).toContain(`reserved requests=3, tokens=900 against ${budgetId}`);
    expect(byDimension(engine.reservationsForExecution(record.request.id)[0]?.holds ?? [])).toEqual(
      byDimension([budgetHold("requests", 3), budgetHold("tokens", 900)]),
    );
  });

  it("charges the run's budget override rather than the request's", async () => {
    const chosen = budgetHarness();
    const ignored = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: chosen.engine,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest({ budgetId: ignored.budgetId }), {
      budgetId: chosen.budgetId,
    });
    expect(record.governance.budgetId).toBe(chosen.budgetId);
    expect(chosen.engine.reservationsForExecution(record.request.id)).toHaveLength(1);
    expect(ignored.engine.reservationsForExecution(record.request.id)).toEqual([]);
  });

  it("applies the kernel's default budget to a request that names none", async () => {
    const { engine, budgetId } = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      defaultBudgetId: budgetId,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest());
    expect(record.governance.budgetId).toBe(budgetId);
    expect(record.governance.budgetStatus).toBe("committed");
  });

  it("reserves nothing when no budget applies, and does not claim otherwise", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    const record = await kernel.execute(executionRequest());
    expect(statusTrail(record)).not.toContain("reserved");
    expect(record.governance.budgetStatus).toBeNull();
    expect(record.governance.budgetId).toBeNull();
    expect(record.result?.metadata).toMatchObject({ budgetStatus: null });
  });

  it("records a settlement failure without erasing the result of work that already happened", async () => {
    // The budget has to exist on the engine that refuses to write to it, or the run would fail at
    // the reservation gate for an unrelated reason.
    const { engine, budgetId } = budgetHarness(
      [{ dimension: "requests", window: "execution", limit: 10 }],
      new UnwritableBudgetEngine({ clock: () => AT }),
    );
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [okExecutor("done", usage())],
    });
    const record = await kernel.execute(executionRequest({ budgetId }));

    expect(record.status).toBe("succeeded");
    expect(
      record.result !== null && record.result.status === "succeeded" ? record.result.output : null,
    ).toBe("done");
    expect(notesOf(record).some((note) => note.startsWith("budget settlement failed"))).toBe(true);
    expect(notesOf(record).some((note) => note.includes("ledger unavailable"))).toBe(true);
  });

  it("settles once, even though the run terminates and then wraps up", async () => {
    const { engine, budgetId } = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [okExecutor("done", usage({ requests: 1, totalTokens: 10, costMicro: 100 }))],
    });
    const record = await kernel.execute(executionRequest({ budgetId }));
    const reservations = engine.reservationsForExecution(record.request.id);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.state).toBe("committed");
    expect(byDimension(reservations[0]?.committed ?? [])).toEqual(
      byDimension([
        budgetHold("requests", 1),
        budgetHold("tokens", 10),
        budgetHold("cost_micro_usd", 100),
      ]),
    );
  });

  it("keeps money in integer micro-USD all the way to the ledger", async () => {
    const { engine, budgetId } = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [okExecutor("done", usage({ costMicro: 1_234 }))],
    });
    const record = await kernel.execute(executionRequest({ budgetId }));
    const cost = (engine.reservationsForExecution(record.request.id)[0]?.committed ?? []).find(
      (hold) => hold.dimension === "cost_micro_usd",
    );
    expect(cost?.amount).toBe(1_234);
    expect(Number.isInteger(cost?.amount)).toBe(true);
  });

  it("accepts limits declared per dimension and window, and reports an unknown budget as absent", () => {
    const engine = new InMemoryBudgetEngine({ clock: () => AT });
    const limits: readonly BudgetLimitInput[] = [
      { dimension: "requests", window: "execution", limit: 4 },
      { dimension: "tokens", window: "day", limit: 1_000 },
      { dimension: "cost_micro_usd", window: "total", limit: 500_000, enforcement: "soft" },
    ];
    const budget = engine.registerBudget({ name: "limits", limits, createdAt: AT });
    expect(engine.requireBudget(budget.id).limits).toHaveLength(3);
    expect(engine.has(budget.id)).toBe(true);
    expect(engine.getBudget(createBudgetId())).toBeNull();
  });
});

describe("governance ordering", () => {
  it("asks policy before it asks budget, and both before any step runs", async () => {
    const policy = denyAllPolicyEngine();
    const budget = budgetHarness();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: policy.engine,
      budgetEngine: budget.engine,
      executors: [okExecutor()],
    });
    const request = executionRequest({ policyId: policy.policyId, budgetId: budget.budgetId });
    const record = await kernel.execute(request);

    expect(record.status).toBe("failed");
    expect(record.governance.policyOutcome).toBe("deny");
    // A denied execution must not leave a hold behind: it never got as far as reserving.
    expect(budget.engine.reservationsForExecution(request.id)).toEqual([]);
  });

  it("asks budget before planning, so an unaffordable run is refused without a plan", async () => {
    const { engine, budgetId } = budgetHarness([
      { dimension: "requests", window: "execution", limit: 1 },
    ]);
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      budgetEngine: engine,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest({ budgetId }), {
      holds: [budgetHold("requests", 9)],
    });
    expect(record.plan).toBeNull();
    expect(record.governance.budgetStatus).toBeNull();
  });

  it("refuses to run the same execution twice, even when the first was denied", async () => {
    const { engine, policyId } = denyAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    const request = executionRequest({ policyId });
    await kernel.execute(request);
    await expect(kernel.execute(request)).rejects.toThrow(ConflictError);
  });

  it("stores exactly one record per execution, whichever gate stopped it", async () => {
    const { engine, policyId } = denyAllPolicyEngine();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      policyEngine: engine,
      executors: [okExecutor()],
    });
    await kernel.execute(executionRequest({ policyId }));
    expect(kernel.size).toBe(1);
    expect(kernel.listExecutions()).toHaveLength(1);
  });
});
