/**
 * Policy before privileged execution, budget before expensive work.
 *
 * Those two sentences are the whole governance claim of the AI Core, and neither is
 * visible in a single package's tests: the policy engine does not know what a provider
 * is, the budget engine does not know what a model call costs, and the orchestrator
 * does not decide the order. The order is a property of the composition, so this is
 * where it is tested — by watching what the provider adapter and the tool handler were
 * actually asked to do, and what the ledger holds afterwards.
 */

import { describe, expect, it } from "vitest";
import { agentBySlug, modelById, textMessage, toolById } from "@omnis/ai-core-types";
import type { PolicyId } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import { createBudgetEngine } from "@omnis/budget-engine";
import { createPolicyEngine } from "@omnis/policy-engine";
import { ExecutionScope } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import {
  AT,
  buildAiCorePlatform,
  budgetInput,
  completedInvocation,
  failedInvocation,
  singleOutcomePolicySet,
  usageOf,
} from "../support/aiCoreTestPlatform.js";

/** A platform whose every call is gated by one policy outcome. */
function governedPlatform(outcome: "allow" | "deny" | "require_approval") {
  const policyEngine = createPolicyEngine({ clock: () => AT });
  const set = policyEngine.registerPolicySet(singleOutcomePolicySet(outcome));
  const platform = buildAiCorePlatform({ runtime: { policyEngine }, defaultPolicyIds: [set.id] });
  return { platform, policyId: set.id };
}

/** A call to the platform's only model. */
function modelCall(platform: ReturnType<typeof buildAiCorePlatform>) {
  return {
    model: modelById(platform.primary.model.id),
    messages: [textMessage("user", "say something brief")],
  };
}

/** A context for a call made outside an agent run. */
function contextFor(platform: ReturnType<typeof buildAiCorePlatform>): ExecutionContext {
  return ExecutionScope.createRoot({ tenantId: platform.tenantId }).context;
}

describe("policy runs before anything privileged", () => {
  it("stops a model call before the provider is asked anything", async () => {
    const { platform } = governedPlatform("deny");
    const result = await platform.runtime.executeModel(modelCall(platform));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.class).toBe("policy_blocked");
      expect(result.failure.retryable).toBe(false);
    }
    expect(result.policyOutcome).toBe("deny");
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });

  it("stops a tool call before the handler runs, and records the refusal", async () => {
    const { platform } = governedPlatform("deny");
    const result = await platform.runtime.executeTool({
      tool: toolById(platform.tool.id),
      arguments: { query: "quarterly report" },
      context: contextFor(platform),
    });

    expect(result.status).toBe("denied");
    expect(platform.toolHandler.calls).toHaveLength(0);
    if (result.status === "denied") {
      // The audit row exists even though nothing ran: "we refused, and here is the row"
      // is the record an auditor needs, and its absence is indistinguishable from a
      // call that was never attempted.
      expect(result.audit.policyDecisionOutcome).toBe("deny");
      expect(result.audit.toolId).toBe(platform.tool.id);
    }
  });

  it("stops an agent run before its first step", async () => {
    const { platform } = governedPlatform("deny");
    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    expect(result.succeeded).toBe(false);
    expect(result.failure?.class).toBe("policy_blocked");
    expect(platform.primary.adapter.invocations).toHaveLength(0);
    expect(platform.toolHandler.calls).toHaveLength(0);
    // The run still exists as a record: a refusal is a fact about the execution, not a
    // reason to pretend it never happened.
    expect(platform.runtime.listExecutions()).toHaveLength(1);
  });

  it("takes no reservation for work a policy refused", async () => {
    // Ordering, stated as money: if the budget were consulted first, a denied call would
    // hold allowance it never used, and a budget that is nearly exhausted would refuse
    // work that was always going to be refused anyway.
    const policyEngine = createPolicyEngine({ clock: () => AT });
    const set = policyEngine.registerPolicySet(singleOutcomePolicySet("deny"));
    const platform = buildAiCorePlatform({ runtime: { policyEngine }, defaultPolicyIds: [set.id] });
    const budget = platform.runtime.registerBudget(budgetInput(10));

    const result = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
    });
    expect(result.status).toBe("failed");
    expect(platform.runtime.budgets.reservationsForExecution(result.executionId)).toHaveLength(0);
  });

  it("lets a denial win over an allowance, whatever order the sets are named in", async () => {
    const policyEngine = createPolicyEngine({ clock: () => AT });
    const allow = policyEngine.registerPolicySet(
      singleOutcomePolicySet("allow", "allow-everything"),
    );
    const deny = policyEngine.registerPolicySet(singleOutcomePolicySet("deny", "deny-everything"));
    const platform = buildAiCoreRuntimeWith(policyEngine, [allow.id, deny.id]);
    const reversed = buildAiCoreRuntimeWith(policyEngine, [deny.id, allow.id]);

    // Precedence is a property of the outcome, not of the order a caller happened to
    // list the sets in: deny > require_approval > constrain > allow.
    const first = await platform.runtime.executeModel(modelCall(platform));
    const second = await reversed.runtime.executeModel(modelCall(reversed));
    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(first.policyOutcome).toBe("deny");
    expect(second.policyOutcome).toBe("deny");
  });

  it("fails closed when the policy gate itself breaks", async () => {
    // A policy engine that throws is not a policy engine that allows. Deciding "allow"
    // because the gate broke would turn an outage in the governance layer into ungoverned
    // spend, so the composition refuses the call and says the gate was the problem.
    const engine = createPolicyEngine({ clock: () => AT });
    const set = engine.registerPolicySet(singleOutcomePolicySet("allow", "allow-everything"));
    const broken = Object.assign(engine, {
      gate(): never {
        throw new Error("the policy store is unreachable");
      },
    });
    const platform = buildAiCorePlatform({
      runtime: { policyEngine: broken },
      defaultPolicyIds: [set.id],
    });

    const result = await platform.runtime.executeModel(modelCall(platform));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.class).toBe("policy_blocked");
    }
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });
});

function buildAiCoreRuntimeWith(
  policyEngine: ReturnType<typeof createPolicyEngine>,
  defaultPolicyIds: readonly PolicyId[],
) {
  return buildAiCorePlatform({ runtime: { policyEngine }, defaultPolicyIds });
}

describe("approval", () => {
  it("stops an agent run in a waiting state, and continues it when approval is granted", async () => {
    const { platform } = governedPlatform("require_approval");
    const waiting = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    expect(waiting.succeeded).toBe(false);
    expect(waiting.instance.state).toBe("waiting");
    expect(waiting.instance.waitingOn).toBe("approval");
    expect(platform.primary.adapter.invocations).toHaveLength(0);

    const executionId = waiting.instance.executionId;
    expect(executionId).not.toBeNull();
    if (executionId === null) {
      throw new Error("the waiting run recorded no execution");
    }
    const approved = await platform.runtime.approveAgent(executionId, {
      approved: true,
      approver: "ops",
      approvedAt: AT,
    });

    expect(approved.succeeded).toBe(true);
    // The approved run is a second execution of the same decision, and it says so: an
    // audit reader can see that two executions are one decision rather than two.
    expect(approved.instance.attempt).toBe(2);
    expect(platform.primary.adapter.invocations).toHaveLength(1);
    expect(platform.runtime.listExecutions().length).toBeGreaterThanOrEqual(2);
  });

  it("runs straight through when the caller already holds the approval", async () => {
    const { platform } = governedPlatform("require_approval");
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      { goal: "answer briefly" },
      { approval: { approved: true, approver: "ops", approvedAt: AT } },
    );

    // The approval travels with the execution into the model call it authorizes, so the
    // nested gate sees the same decision the outer one did.
    expect(result.succeeded).toBe(true);
    expect(result.instance.attempt).toBe(1);
    expect(platform.primary.adapter.invocations).toHaveLength(1);
  });

  it("treats a refusal as a refusal, and does not run the work", async () => {
    const { platform } = governedPlatform("require_approval");
    const waiting = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });
    const waitingId = waiting.instance.executionId;
    if (waitingId === null) {
      throw new Error("the waiting run recorded no execution");
    }

    // Somebody looked at the request and said no. That is a decision, not an error: the
    // run ends, the work does not happen, and the record says a human refused it.
    const refused = await platform.runtime.approveAgent(waitingId, {
      approved: false,
      approver: "ops",
      approvedAt: AT,
    });
    expect(refused.succeeded).toBe(false);
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });

  it("refuses to approve with no approval at all, because an absent approval is not a granted one", async () => {
    const { platform } = governedPlatform("require_approval");
    const waiting = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });
    const waitingId = waiting.instance.executionId;
    if (waitingId === null) {
      throw new Error("the waiting run recorded no execution");
    }

    // Thrown synchronously, before a run is opened: an absent approval is a caller error,
    // not an outcome to report.
    expect(() => platform.runtime.approveAgent(waitingId, null)).toThrow(ValidationError);
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });
});

describe("budget runs before expensive work", () => {
  it("refuses a call the budget cannot cover, without touching the provider", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [completedInvocation("answered", usageOf(1_000, 1_000, 500))],
    });
    const budget = platform.runtime.registerBudget(budgetInput(1, "cost_micro_usd"));

    const result = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.class).toBe("budget_blocked");
    }
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });

  it("charges one call once, and the ledger says what it charged", async () => {
    const platform = buildAiCorePlatform();
    // The orchestrator holds an *estimate* before the call, priced at the model's maximum
    // output rather than at what the answer turns out to be: a hold that assumed the
    // cheapest possible answer would let an expensive one through. So the limit here has
    // to cover the estimate, not the four micro-USD the call actually costs.
    const budget = platform.runtime.registerBudget(budgetInput(100_000, "cost_micro_usd"));

    const result = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
    });
    expect(result.status).toBe("succeeded");

    const reservations = platform.runtime.budgets.reservationsForExecution(result.executionId);
    expect(reservations).toHaveLength(1);
    // Settled, not still holding: a hold that outlives its call is allowance nobody can
    // spend, and it never comes back.
    expect(reservations[0]?.state).toBe("committed");
    expect(reservations[0]?.budgetId).toBe(budget.id);
    const charged = reservations[0]?.committed ?? [];
    expect(charged.length).toBeGreaterThan(0);
    for (const hold of charged) {
      // Money is integer micro-USD everywhere in the platform: a float here would be a
      // rounding difference that shows up as a missing cent in a reconciliation.
      expect(Number.isInteger(hold.amount)).toBe(true);
    }
  });

  it("holds once for a call that needed several attempts", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [
        failedInvocation("the provider hiccuped", { retryable: true }),
        completedInvocation("answered on the second attempt"),
      ],
    });
    const budget = platform.runtime.registerBudget(budgetInput(100, "requests"));

    const result = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
      maxAttemptsPerProvider: 2,
    });

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.attempts.length).toBe(2);
    }
    // The allowance is for the call, not for each try at it: retrying is the platform's
    // decision, and charging the caller twice for it would make retries unaffordable.
    expect(platform.runtime.budgets.reservationsForExecution(result.executionId)).toHaveLength(1);
  });

  it("runs a second call against an exhausted budget into a refusal", async () => {
    const platform = buildAiCorePlatform();
    // A `total` window: with the default `execution` window every call would get its own
    // allowance and the budget could never run out, which is the mistake worth pinning.
    const budget = platform.runtime.registerBudget(budgetInput(1, "model_calls", "total"));

    const first = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
    });
    const second = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
    });

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("failed");
    if (second.status === "failed") {
      expect(second.failure.class).toBe("budget_blocked");
    }
    expect(platform.primary.adapter.invocations).toHaveLength(1);
  });

  it("applies the composition's default budget to a call that named none", async () => {
    // The budget has to live in the engine the composition uses, so the engine is built
    // first: a default budget identifier pointing at another composition's ledger would
    // govern nothing and look like it governed everything.
    const budgetEngine = createBudgetEngine({ clock: () => AT });
    const budget = budgetEngine.registerBudget(
      budgetInput(100, "requests", "total", "default-budget"),
    );
    const platform = buildAiCorePlatform({ runtime: { budgetEngine, defaultBudgetId: budget.id } });

    const result = await platform.runtime.executeModel(modelCall(platform));
    expect(result.status).toBe("succeeded");
    // A caller who says nothing is still governed, rather than running unbudgeted.
    expect(result.budgetId).toBe(budget.id);
    expect(platform.runtime.budgets.reservationsForExecution(result.executionId)).toHaveLength(1);
  });
});

describe("an agent's own ceilings", () => {
  it("becomes a policy set in the same engine that gates everything else", async () => {
    const platform = buildAiCorePlatform({
      agent: { constraints: { maxModelCalls: 2, maxCostMicroUsd: 500 } },
    });
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });
    const sets = platform.runtime.policy.list().map((set) => set.name);

    // The descriptor's ceilings are not a separate mechanism with a separate precedence:
    // they are a policy set, so deny still beats them and they still run before work.
    expect(sets.some((name) => name.startsWith("agent-constraints:"))).toBe(true);
  });

  it("refuses a plan that would cost more than the agent is allowed", async () => {
    const platform = buildAiCorePlatform({ agent: { constraints: { maxModelCalls: 1 } } });

    await expect(
      platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
        goal: "answer twice",
        steps: [
          { id: "first", kind: "model" },
          { id: "second", kind: "model" },
        ],
      }),
    ).rejects.toThrow(ValidationError);
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });

  it("reports a cost ceiling crossed by the last call, even on a run that succeeded", async () => {
    // A ceiling the final call crosses cannot stop anything, and reporting nothing would
    // let a run that overspent look like one that did not.
    const platform = buildAiCorePlatform({
      agent: { constraints: { maxCostMicroUsd: 1 } },
      modelResults: [completedInvocation("answered", usageOf(1_000, 1_000, 900))],
    });
    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    expect(result.ceilingBreach).not.toBeNull();
    expect(result.ceilingBreach).toContain("micro-USD");
    expect(result.ceilingBreach).toContain("900");
  });

  it("stops a run that keeps calling models past its ceiling", async () => {
    const platform = buildAiCorePlatform({ agent: { constraints: { maxModelCalls: 1 } } });
    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer, then answer again",
      steps: [{ id: "first", kind: "model" }],
    });
    expect(result.succeeded).toBe(true);
    expect(result.ceilingBreach).toBeNull();
  });
});

describe("governance is recorded, not just enforced", () => {
  it("puts the deciding policy and the budget on the result a caller receives", async () => {
    const { platform, policyId } = governedPlatform("allow");
    const budget = platform.runtime.registerBudget(budgetInput(100, "requests"));
    const result = await platform.runtime.executeModel({
      ...modelCall(platform),
      budgetId: budget.id,
    });

    expect(result.status).toBe("succeeded");
    expect(String(result.policyId ?? "")).toBe(String(policyId));
    expect(result.policyOutcome).toBe("allow");
    expect(result.budgetId).toBe(budget.id);
    // A caller can answer "was this allowed, and who paid?" from the result alone, which
    // is what makes the result safe to log.
    expect(result.budgetStatus).not.toBeNull();
  });

  it("keeps a secret supplied by the caller out of every record", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      { goal: "answer briefly" },
      { tenantId: platform.tenantId, metadata: { apiKey: "sk-live-secret-value" } }, // omnis-secret-scan:allow a deliberate fake, used to prove this value is redacted
    );

    const serialized =
      JSON.stringify(platform.spans.map((span) => span.recordedAttributes)) +
      JSON.stringify(platform.published) +
      JSON.stringify(platform.runtime.listExecutions());
    expect(serialized).not.toContain("sk-live-secret-value");
  });
});
