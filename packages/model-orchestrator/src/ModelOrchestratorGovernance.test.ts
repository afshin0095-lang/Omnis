import { describe, expect, it } from "vitest";
import { modelByCapability, modelById } from "@omnis/ai-core-types";
import type { BudgetHold } from "@omnis/ai-core-types";
import { budgetHold } from "@omnis/ai-core-types";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import type { PolicyEngine } from "@omnis/policy-engine";
import type { ConstraintSpecInput } from "@omnis/policy-engine";
import type { ModelCallResult } from "./ModelCall.js";
import {
  AT,
  allowAllPolicy,
  budgetFixture,
  completedInvocation,
  constrainedPolicy,
  denyAllPolicy,
  failedInvocation,
  governedOrchestrator,
  modelCall,
  orchestratorFixture,
  policyFixture,
  usageOf,
} from "./testSupport.js";
import type { FixtureModel, OrchestratorFixture } from "./testSupport.js";

/** The one model a default fixture registers, asserted present so a test can name it. */
function primaryOf(fixture: OrchestratorFixture): FixtureModel {
  const model = fixture.primary;
  expect(model).not.toBeNull();
  return model as FixtureModel;
}

function succeeded(result: ModelCallResult): Extract<ModelCallResult, { status: "succeeded" }> {
  if (result.status !== "succeeded") {
    expect.unreachable(
      `the call failed: ${result.failure.class}(${result.failure.code}): ${result.failure.message}`,
    );
  }
  return result;
}

function failed(result: ModelCallResult): Extract<ModelCallResult, { status: "failed" }> {
  if (result.status !== "failed") {
    expect.unreachable("the call was expected to fail");
  }
  return result;
}

/** One baseline constraint, with the source a registered constraint must name. */
function constraint(
  kind: ConstraintSpecInput["kind"],
  value: ConstraintSpecInput["value"],
): ConstraintSpecInput {
  return { kind, value, source: "test" };
}

/** The amount held or committed in one dimension. */
function amount(holds: readonly BudgetHold[], dimension: string): number | null {
  return holds.find((hold) => hold.dimension === dimension)?.amount ?? null;
}

describe("policy decides before a provider is asked", () => {
  it("refuses a call a policy set denies, without invoking anything", async () => {
    const policy = denyAllPolicy();
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.failure.code).toBe("policy_violation");
    expect(result.policyOutcome).toBe("deny");
    expect(result.policyId).toBe(policy.policyId);
    expect(result.attempts).toHaveLength(0);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });

  it("reports which set decided, on the result and on the span", async () => {
    const policy = denyAllPolicy();
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [policy.policyId] }),
    );
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.policy.id"]).toBe(policy.policyId);
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.policy.outcome"]).toBe("deny");
  });

  it("lets an allowed call through and says so", async () => {
    const policy = allowAllPolicy();
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.policyOutcome).toBe("allow");
    expect(result.policyId).toBe(policy.policyId);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
  });

  it("accepts a policy by registered name, because a caller may hold either form", async () => {
    const policy = denyAllPolicy();
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: ["deny-all"] }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.policyId).toBe(policy.policyId);
  });

  it("applies the orchestrator's default policy sets to a call that names none", async () => {
    const policy = denyAllPolicy();
    const fixture = orchestratorFixture({
      policyEngine: policy.engine,
      defaultPolicyIds: [policy.policyId],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.policyOutcome).toBe("deny");
  });

  it("does not evaluate a policy name nothing is registered under", async () => {
    const policy = allowAllPolicy();
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: ["no-such-policy"] }),
      ),
    );
    expect(result.policyOutcome).toBeNull();
    expect(result.policyId).toBeNull();
    expect(policy.policyId).toBeTruthy();
  });

  it("requires an approval when policy asks for one, and accepts one that was granted", async () => {
    const policy = policyFixture({ name: "approval", defaultOutcome: "require_approval" });
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    const reference = modelById(primaryOf(fixture).model.id);

    const refused = failed(
      await fixture.orchestrator.call(
        modelCall({ model: reference, policyIds: [policy.policyId] }),
      ),
    );
    expect(refused.failure.class).toBe("policy_blocked");
    expect(refused.failure.details).toMatchObject({ approvalRequired: true });
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);

    const approved = succeeded(
      await fixture.orchestrator.call(
        modelCall({
          model: reference,
          policyIds: [policy.policyId],
          approval: { approved: true, approver: "ops", approvedAt: AT },
        }),
      ),
    );
    expect(approved.policyOutcome).toBe("require_approval");
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
  });

  it("does not accept an approval that was withheld", async () => {
    const policy = policyFixture({ name: "approval", defaultOutcome: "require_approval" });
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          policyIds: [policy.policyId],
          approval: { approved: false, approver: null, approvedAt: null },
        }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });

  it("evaluates policy against the model, so a rule can deny one candidate by identifier", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "allowed-model", priority: 5, results: [failedInvocation("down")] },
        { slug: "blocked-model", priority: 10 },
      ],
    });
    const blockedId = fixture.models[1]?.model.id;
    const policy = policyFixture({
      name: "block-one-model",
      defaultOutcome: "allow",
      rules: [
        {
          id: "block-model",
          name: "block one model",
          outcome: "deny",
          target: { modelId: blockedId },
        },
      ],
    });
    const governed = governedOrchestrator(fixture, { policyEngine: policy.engine });

    const result = failed(
      await governed.call(
        modelCall({ model: modelByCapability("chat"), policyIds: [policy.policyId] }),
      ),
    );
    // The first candidate failed on its own; the denial of the second is what stops the call.
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.fallbacks).toBe(1);
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
  });

  it("re-evaluates policy for each candidate, because a fallback changes the model and the provider", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 5, results: [failedInvocation("down")] },
        { slug: "second", priority: 10 },
      ],
    });
    const policy = policyFixture({
      name: "no-fallbacks",
      defaultOutcome: "allow",
      rules: [
        {
          id: "block-fallback",
          name: "block a fallback",
          outcome: "deny",
          conditions: [{ field: "attributes.fallbackDepth", operator: "gt", value: 0 }],
        },
      ],
    });
    const governed = governedOrchestrator(fixture, { policyEngine: policy.engine });

    const result = failed(
      await governed.call(
        modelCall({ model: modelByCapability("chat"), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.fallbacks).toBe(1);
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
  });

  it("fails closed when a policy engine cannot answer, and says why", async () => {
    const broken = {
      gateWithContext: () => {
        throw new Error("the policy store is unreachable");
      },
      list: () => [],
    } as unknown as PolicyEngine;
    const fixture = orchestratorFixture({ policyEngine: broken });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          policyIds: ["pol_01J00000000000000000000000"],
        }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.failure.message).toContain("policy could not be evaluated");
    expect(result.failure.message).toContain("the policy store is unreachable");
    expect(result.failure.details).toMatchObject({ policyEvaluationFailed: true });
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });
});

describe("policy constrains what a call may do", () => {
  it("bounds retries with max_retries", async () => {
    const policy = constrainedPolicy([constraint("max_retries", 0)]);
    const fixture = orchestratorFixture({
      policyEngine: policy.engine,
      models: [{ slug: "flaky", results: [failedInvocation("rate limited")] }],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.attempts).toHaveLength(1);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
  });

  it("bounds the whole call with max_model_calls", async () => {
    const policy = constrainedPolicy([constraint("max_model_calls", 1)]);
    const fixture = orchestratorFixture({
      policyEngine: policy.engine,
      models: [
        { slug: "first", priority: 5, results: [failedInvocation("down")] },
        { slug: "second", priority: 10 },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelByCapability("chat"), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.failure.message).toContain("at most 1 model call");
    // Both attempts belong to the one model that was allowed: retries are not model calls.
    expect(
      result.attempts.every((attempt) => attempt.modelId === fixture.models[0]?.model.id),
    ).toBe(true);
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
  });

  it("bounds one invocation with max_duration_ms", async () => {
    const policy = constrainedPolicy([constraint("max_duration_ms", 250)]);
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        policyIds: [policy.policyId],
        timeoutMs: 9_000,
      }),
    );
    expect(primaryOf(fixture).adapter.invocations[0]?.context.timeoutMs).toBe(250);
  });

  it("bounds generated tokens with max_output_tokens, clamping rather than refusing", async () => {
    const policy = constrainedPolicy([constraint("max_output_tokens", 64)]);
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        policyIds: [policy.policyId],
        parameters: { maxOutputTokens: 4_096 },
      }),
    );
    expect(primaryOf(fixture).adapter.invocations[0]?.request.parameters.maxOutputTokens).toBe(64);
  });

  it("leaves a smaller caller limit alone when policy allows more", async () => {
    const policy = constrainedPolicy([constraint("max_output_tokens", 4_096)]);
    const fixture = orchestratorFixture({ policyEngine: policy.engine });
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        policyIds: [policy.policyId],
        parameters: { maxOutputTokens: 32 },
      }),
    );
    expect(primaryOf(fixture).adapter.invocations[0]?.request.parameters.maxOutputTokens).toBe(32);
  });

  it("passes over a provider policy does not allow, and reports that when nothing else can serve", async () => {
    const fixture = orchestratorFixture({ models: [{ slug: "primary" }] });
    const policy = constrainedPolicy([
      constraint("denied_providers", [primaryOf(fixture).provider.id]),
    ]);
    const governed = governedOrchestrator(fixture, { policyEngine: policy.engine });

    const result = failed(
      await governed.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.failure.message).toContain("does not allow provider");
    expect(result.attempts[0]?.status).toBe("skipped");
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });

  it("falls back to a provider policy does allow", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 5 },
        { slug: "second", priority: 10 },
      ],
    });
    const denied = fixture.models[0]?.provider.id;
    const policy = constrainedPolicy([constraint("denied_providers", [denied as string])]);
    const governed = governedOrchestrator(fixture, { policyEngine: policy.engine });

    const result = succeeded(
      await governed.call(
        modelCall({ model: modelByCapability("chat"), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.modelId).toBe(fixture.models[1]?.model.id);
    expect(result.attempts[0]?.status).toBe("skipped");
    expect(result.attempts[1]?.status).toBe("succeeded");
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(0);
  });

  it("passes over a model policy denies while still serving an allowed one", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "denied", priority: 5 },
        { slug: "allowed", priority: 10 },
      ],
    });
    const policy = policyFixture({
      name: "allowed-models",
      defaultOutcome: "constrain",
      baselineConstraints: [constraint("allowed_models", [fixture.models[1]?.model.id as string])],
    });
    const governed = governedOrchestrator(fixture, { policyEngine: policy.engine });

    const result = succeeded(
      await governed.call(
        modelCall({ model: modelByCapability("chat"), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.modelId).toBe(fixture.models[1]?.model.id);
    expect(result.attempts[0]?.status).toBe("skipped");
    expect(result.attempts[0]?.failure?.message).toContain("does not allow model");
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(0);
  });

  it("passes over a call that is estimated to cost more than policy allows", async () => {
    const policy = constrainedPolicy([constraint("max_cost_micro_usd", 1)]);
    const fixture = orchestratorFixture({
      policyEngine: policy.engine,
      models: [
        {
          slug: "pricey",
          pricing: {
            currency: "micro_usd",
            inputPerThousandTokens: 10_000,
            outputPerThousandTokens: 10_000,
            cachedInputPerThousandTokens: null,
            perRequestMicro: null,
          },
        },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [policy.policyId] }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(result.failure.message).toContain("micro-USD");
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });
});

describe("budget is held before the call and settled after it", () => {
  it("reserves an estimate before invoking and commits what was measured", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({ budgetEngine: budget.engine });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          budgetId: budget.budgetId,
          parameters: { maxOutputTokens: 100 },
        }),
      ),
    );

    expect(result.budgetId).toBe(budget.budgetId);
    expect(result.budgetStatus).toBe("committed");
    const reservations = budget.engine.reservationsForExecution(result.executionId);
    expect(reservations).toHaveLength(1);
    // Held: 2 estimated prompt tokens plus the 100 the caller allowed. Committed: what arrived.
    expect(amount(reservations[0]?.holds ?? [], "tokens")).toBe(102);
    expect(amount(reservations[0]?.committed ?? [], "tokens")).toBe(46);
    expect(amount(reservations[0]?.committed ?? [], "cost_micro_usd")).toBe(6);
    expect(reservations[0]?.committedAt).toBe(AT);
  });

  it("releases the hold when the call fails, so a failed call costs nothing", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [
        { slug: "down", results: [failedInvocation("the provider is down", { retryable: false })] },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    expect(result.budgetStatus).toBe("released");
    const reservations = budget.engine.reservationsForExecution(result.executionId);
    expect(reservations[0]?.state).toBe("released");
    expect(reservations[0]?.releasedAt).toBe(AT);
    const ledger = budget.engine.usage(
      budget.budgetId,
      { executionId: result.executionId, sessionId: null },
      "execution",
    );
    expect(amount(ledger.committed, "tokens") ?? 0).toBe(0);
    expect(amount(ledger.reserved, "tokens") ?? 0).toBe(0);
  });

  it("refuses a call the budget cannot cover, before a provider is asked", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 10 }]);
    const fixture = orchestratorFixture({ budgetEngine: budget.engine });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    expect(result.failure.class).toBe("budget_blocked");
    expect(result.budgetStatus).toBeNull();
    expect(result.attempts).toHaveLength(0);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });

  it("refuses unpriced work against a budget that limits cost", async () => {
    const budget = budgetFixture([
      { dimension: "cost_micro_usd", window: "execution", limit: 1_000 },
    ]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [{ slug: "local", pricing: null }],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    expect(result.failure.class).toBe("budget_blocked");
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });

  it("accepts unpriced work against a budget that limits tokens", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [{ slug: "local", pricing: null }],
    });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    expect(result.budgetStatus).toBe("committed");
    const reservation = budget.engine.reservationsForExecution(result.executionId)[0];
    expect(amount(reservation?.committed ?? [], "tokens")).toBe(46);
    expect(amount(reservation?.committed ?? [], "cost_micro_usd")).toBeNull();
  });

  it("takes the budget from the call when it names one, and from the orchestrator when it does not", async () => {
    const engine = new InMemoryBudgetEngine({ clock: () => AT });
    const callBudget = budgetFixture(
      [{ dimension: "tokens", window: "execution", limit: 100_000 }],
      engine,
    );
    const defaultBudget = budgetFixture(
      [{ dimension: "requests", window: "execution", limit: 100_000 }],
      engine,
    );
    const fixture = orchestratorFixture({
      budgetEngine: defaultBudget.engine,
      defaultBudgetId: defaultBudget.budgetId,
    });
    const reference = modelById(primaryOf(fixture).model.id);

    const withDefault = succeeded(await fixture.orchestrator.call(modelCall({ model: reference })));
    expect(withDefault.budgetId).toBe(defaultBudget.budgetId);

    const withOwn = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: reference, budgetId: callBudget.budgetId }),
      ),
    );
    expect(withOwn.budgetId).toBe(callBudget.budgetId);
    expect(callBudget.engine.reservationsForExecution(withOwn.executionId)).toHaveLength(1);
  });

  it("holds one reservation for the whole call, however many providers it tries", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [
        { slug: "first", priority: 5, results: [failedInvocation("down")] },
        { slug: "second", priority: 10 },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelByCapability("chat"), budgetId: budget.budgetId }),
      ),
    );
    expect(result.fallbacks).toBe(1);
    expect(budget.engine.reservationsForExecution(result.executionId)).toHaveLength(1);
  });

  it("re-validates the budget before spending on another provider", async () => {
    // Room for one hold and no more: the first provider fails, the second cannot be afforded, and
    // the call stops at the budget rather than at the provider.
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 4_200 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [
        { slug: "first", priority: 5, results: [failedInvocation("down")] },
        { slug: "second", priority: 10 },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelByCapability("chat"), budgetId: budget.budgetId }),
      ),
    );
    expect(result.failure.class).toBe("budget_blocked");
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
    expect(result.attempts.at(-1)?.status).toBe("failed");
  });

  it("uses a caller-supplied estimate when one is configured", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({ budgetEngine: budget.engine });
    const governed = governedOrchestrator(fixture, {
      budgetEngine: budget.engine,
      estimateHolds: () => [budgetHold("tokens", 5)],
    });
    const result = succeeded(
      await governed.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    const reservation = budget.engine.reservationsForExecution(result.executionId)[0];
    expect(amount(reservation?.holds ?? [], "tokens")).toBe(5);
    // The commit still reports what was measured, not what was estimated.
    expect(amount(reservation?.committed ?? [], "tokens")).toBe(46);
  });

  it("reports no budget at all when the call names none and the orchestrator has no default", async () => {
    const fixture = orchestratorFixture();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.budgetId).toBeNull();
    expect(result.budgetStatus).toBeNull();
  });

  it("keeps a settlement failure from erasing a response the caller already has", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const refusing = new Proxy(budget.engine, {
      get(target, property, receiver) {
        if (property === "commit") {
          return () => {
            throw new Error("the ledger is read-only");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const fixture = orchestratorFixture({ budgetEngine: refusing });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    expect(result.status).toBe("succeeded");
    expect(result.budgetStatus).toBe("held");
  });

  it("puts the reservation on the span, where an operator can follow the money", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({ budgetEngine: budget.engine });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    const reservation = budget.engine.reservationsForExecution(result.executionId)[0];
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.reservation.id"]).toBe(reservation?.id);
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.budget.id"]).toBe(budget.budgetId);
  });
});

describe("policy and budget together", () => {
  it("asks policy first, so a denied call never touches the ledger", async () => {
    const policy = denyAllPolicy();
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      policyEngine: policy.engine,
      budgetEngine: budget.engine,
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          policyIds: [policy.policyId],
          budgetId: budget.budgetId,
        }),
      ),
    );
    expect(result.failure.class).toBe("policy_blocked");
    expect(budget.engine.reservationsForExecution(result.executionId)).toHaveLength(0);
  });

  it("holds budget only after policy allows, and not at all when the budget refuses", async () => {
    const policy = allowAllPolicy();
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 5 }]);
    const fixture = orchestratorFixture({
      policyEngine: policy.engine,
      budgetEngine: budget.engine,
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          policyIds: [policy.policyId],
          budgetId: budget.budgetId,
        }),
      ),
    );
    expect(result.policyOutcome).toBe("allow");
    expect(result.failure.class).toBe("budget_blocked");
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(0);
  });

  it("charges the whole call, including what a failed provider really consumed", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [
        {
          slug: "first",
          priority: 5,
          results: [failedInvocation("down", { usage: usageOf(500, 500, null) })],
        },
        {
          slug: "second",
          priority: 10,
          results: [completedInvocation("second answered", usageOf(20, 30, null))],
        },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({
          model: modelByCapability("chat"),
          budgetId: budget.budgetId,
          maxAttemptsPerProvider: 1,
        }),
      ),
    );
    expect(result.usage.totalTokens).toBe(1_050);
    const reservation = budget.engine.reservationsForExecution(result.executionId)[0];
    expect(amount(reservation?.committed ?? [], "tokens")).toBe(1_050);
  });
});
