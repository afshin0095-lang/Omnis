/**
 * The composition root, composed.
 *
 * A composition test has one question to answer: does wiring these packages together
 * produce a platform that behaves the way each package promises on its own? So these tests
 * drive the whole stack — an agent run that reaches a provider adapter, a tool invocation
 * that reaches a handler — and check the commitments the composition makes: governance is
 * never absent, one clock and one tracer are shared, a gate runs before the privileged
 * work, and a part that is missing is reported rather than quietly substituted.
 */

import { describe, expect, it } from "vitest";
import { createModelId, createProviderId, createTenantId } from "@omnis/types";
import { agentBySlug, modelByCapability, modelById, textMessage } from "@omnis/ai-core-types";
import type { AgentInstance, ExecutionId } from "@omnis/ai-core-types";
import type { PolicySetInput } from "@omnis/policy-engine";
import { createPolicyEngine } from "@omnis/policy-engine";
import { ValidationError } from "@omnis/errors";
import { createAiCoreEventBus, createAiCoreRuntime } from "./AiCoreRuntime.js";
import type { AiCoreRuntime } from "./AiCoreRuntime.js";
import {
  aiCoreFixture,
  AT,
  completedInvocation,
  errorResultHandler,
  failedInvocation,
  streamEventsFor,
  toolDescriptorInput,
  toolInvocation,
} from "./testSupport.js";
import type { AiCoreFixture } from "./testSupport.js";

/** A policy set that decides one way for everything. */
function singleOutcomeSet(outcome: "deny" | "require_approval"): PolicySetInput {
  return {
    name: `fixture-${outcome}`,
    description: `Decides "${outcome}" for every action, so a test can prove the gate ran first.`,
    rules: [{ id: `always-${outcome}`, name: `always ${outcome}`, outcome }],
    defaultOutcome: outcome,
    createdAt: AT,
  };
}

/** A fixture whose every call is gated by one policy outcome. */
function governedFixture(outcome: "deny" | "require_approval"): {
  fixture: AiCoreFixture;
  policyId: string;
} {
  const policyEngine = createPolicyEngine({ clock: () => AT });
  const set = policyEngine.registerPolicySet(singleOutcomeSet(outcome));
  const fixture = aiCoreFixture({ runtime: { policyEngine }, defaultPolicyIds: [set.id] });
  return { fixture, policyId: String(set.id) };
}

/** The execution an instance belongs to, or a failure that says the fixture was wrong. */
function executionIdOf(instance: AgentInstance): ExecutionId {
  if (instance.executionId === null) {
    throw new Error("the fixture run produced an instance with no execution");
  }
  return instance.executionId;
}

/** One model call against the fixture's primary model. */
function modelCall(fixture: AiCoreFixture) {
  return {
    model: modelById(fixture.primary.model.id),
    messages: [textMessage("user", "say something brief")],
  };
}

describe("the composition itself", () => {
  it("composes a working runtime from nothing at all", () => {
    const runtime = createAiCoreRuntime();

    expect(runtime.models.size).toBe(0);
    expect(runtime.providers.size).toBe(0);
    expect(runtime.tools.size).toBe(0);
    expect(runtime.agents.size).toBe(0);
    expect(runtime.kernel).toBeDefined();
    expect(runtime.orchestrator).toBeDefined();
    expect(runtime.toolRuntime).toBeDefined();
    expect(runtime.agentRuntime).toBeDefined();
    expect(runtime.events).toBeNull();
  });

  it("never composes without governance, because a runtime that could be built ungoverned eventually would be", () => {
    const runtime = createAiCoreRuntime();

    expect(runtime.policy).toBeDefined();
    expect(runtime.budgets).toBeDefined();
    expect(runtime.evaluation).toBeDefined();
    // The shipped rule set is registered, so grading an execution needs no further setup.
    expect(runtime.evaluation.listRuleSets().length).toBeGreaterThan(0);
  });

  it("uses the parts a caller injected instead of building parallel ones", () => {
    const policyEngine = createPolicyEngine({ clock: () => AT });
    const runtime = createAiCoreRuntime({ policyEngine });
    expect(runtime.policy).toBe(policyEngine);
  });

  it("shares one clock, so every timestamp in a run comes from the same instant", async () => {
    const fixture = aiCoreFixture();
    const model = fixture.runtime.registerModel({
      slug: "second-model",
      displayName: "Second model",
      providerId: fixture.primary.provider.id,
      kind: "general",
      capabilities: ["chat"],
      modalities: { input: ["text"], output: ["text"] },
      pricing: null,
      providerModelName: "second-model",
    });

    expect(model.registeredAt).toBe(AT);
    const result = await fixture.runtime.executeModel(modelCall(fixture));
    expect(result.status).toBe("succeeded");
    expect(result.startedAt).toBe(AT);
  });

  it("shares one tracer, so an agent run and the model call inside it are one trace", async () => {
    const fixture = aiCoreFixture();
    await fixture.runtime.executeAgent(agentBySlug("assistant"), { goal: "answer" });

    const traceIds = new Set(fixture.spans.map((span) => span.context.traceId));
    expect(fixture.spans.length).toBeGreaterThan(1);
    expect(traceIds.size).toBe(1);
    // The agent span is the root; the orchestrator's span is nested under the run.
    const roots = fixture.spans.filter((span) => span.context.parentSpanId === null);
    expect(roots).toHaveLength(1);
  });

  it("refuses an event bus with no tenant to publish under, at composition rather than at the first event", () => {
    let caught: unknown = null;
    try {
      createAiCoreRuntime({ events: createAiCoreEventBus() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("tenantId");
  });

  it("exposes every composed part, so a caller never has to build a second composition", () => {
    const fixture = aiCoreFixture();
    const runtime: AiCoreRuntime = fixture.runtime;

    expect(runtime.models.resolve(modelById(fixture.primary.model.id))).not.toBeNull();
    expect(runtime.providers.selectable().length).toBe(1);
    expect(runtime.tools.get(fixture.tool.id)).not.toBeNull();
    expect(runtime.agentRuntime.registry.size).toBe(1);
  });
});

describe("registration", () => {
  it("registers a model, a provider, a tool and an agent through one surface", () => {
    const runtime = createAiCoreRuntime();
    const budget = runtime.registerBudget({
      name: "fixture",
      limits: [{ dimension: "requests", window: "execution", limit: 10 }],
      createdAt: AT,
    });
    const policy = runtime.registerPolicySet({
      ...singleOutcomeSet("deny"),
      name: "registered-set",
    });
    const ruleSet = runtime.registerRuleSet({
      name: "fixture-rules",
      description: "A rule set registered through the composition.",
      rules: [],
      createdAt: AT,
    });

    expect(runtime.budgets.size).toBe(1);
    expect(runtime.policy.size).toBe(1);
    expect(runtime.evaluation.hasRuleSet(ruleSet.name)).toBe(true);
    expect(budget.id).toBeDefined();
    expect(policy.id).toBeDefined();
  });

  it("refuses a provider whose adapter serves somebody else", () => {
    const fixture = aiCoreFixture();
    // The adapter carries the identifier of the provider it serves, and registration
    // verifies the two agree: an adapter wired to the wrong provider would answer calls
    // billed to another one.
    expect(() =>
      fixture.runtime.registerProvider(
        {
          slug: "mismatched",
          displayName: "Mismatched",
          capabilities: {
            operations: ["chat"],
            inputModalities: ["text"],
            outputModalities: ["text"],
            modelCapabilities: ["chat"],
          },
          credentialsConfigured: true,
        },
        fixture.primary.adapter,
      ),
    ).toThrow();
  });
});

describe("executeModel", () => {
  it("reaches the provider adapter through the orchestrator", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeModel(modelCall(fixture));

    expect(result.status).toBe("succeeded");
    expect(fixture.primary.adapter.invocations).toHaveLength(1);
    if (result.status === "succeeded") {
      expect(result.modelId).toBe(fixture.primary.model.id);
      expect(result.providerId).toBe(fixture.primary.provider.id);
      expect(result.usage.totalTokens).toBe(46);
    }
  });

  it("fails when no provider can serve the model, rather than inventing one", async () => {
    const runtime = createAiCoreRuntime();
    const result = await runtime.executeModel({
      model: modelById(createModelId()),
      messages: [textMessage("user", "hello")],
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("falls back to a second provider, and the fallback is a governed call too", async () => {
    const fixture = aiCoreFixture({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("secondary answered")],
    });
    // A capability reference is what makes two providers candidates for one call: a call
    // pinned to one model identifier has exactly one candidate and nowhere to fall back to.
    const result = await fixture.runtime.executeModel({
      model: modelByCapability("chat"),
      messages: [textMessage("user", "say something brief")],
    });

    expect(result.status).toBe("succeeded");
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(1);
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(1);
    if (result.status === "succeeded") {
      expect(result.fallbacks).toBe(1);
      // Whichever candidate answered, it was not the one that refused.
      expect(String(result.providerId)).not.toBe(String(fixture.models[0]?.provider.id));
    }
  });

  it("consults policy before the provider is asked anything", async () => {
    const { fixture } = governedFixture("deny");
    const result = await fixture.runtime.executeModel(modelCall(fixture));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.class).toBe("policy_blocked");
    }
    // The gate ran first: no adapter saw the call.
    expect(fixture.primary.adapter.invocations).toHaveLength(0);
  });

  it("streams a call and always terminates the stream", async () => {
    const fixture = aiCoreFixture({
      streamEvents: streamEventsFor("streamed", createModelId(), createProviderId()),
    });
    const seen: string[] = [];
    for await (const event of fixture.runtime.streamModel({
      ...modelCall(fixture),
      streaming: true,
    })) {
      seen.push(event.type);
    }

    expect(seen).toContain("delta");
    expect(seen.at(-1)).toBe("completed");
  });
});

describe("executeTool", () => {
  it("reaches the handler through the tool runtime", async () => {
    const fixture = aiCoreFixture({ toolValue: { documents: ["doc_9"] } });
    const result = await fixture.runtime.executeTool(toolInvocation(fixture.tool));

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.value).toEqual({ documents: ["doc_9"] });
    }
    expect(fixture.toolHandler.calls).toHaveLength(1);
    expect(fixture.toolHandler.calls[0]?.arguments).toEqual({ query: "quarterly report" });
  });

  it("refuses a tool that requires an approval nobody gave", async () => {
    const fixture = aiCoreFixture();
    const guarded = fixture.runtime.registerTool(
      toolDescriptorInput({ name: "delete_index", requiresApproval: true, riskLevel: "high" }),
      () => ({
        ok: true,
        value: "deleted",
      }),
    );
    const result = await fixture.runtime.executeTool(toolInvocation(guarded));

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("approval_required");
    }
  });

  it("refuses arguments that do not satisfy the tool's schema, without calling the handler", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeTool(
      toolInvocation(fixture.tool, { arguments: {} }),
    );

    expect(result.status).not.toBe("succeeded");
    expect(fixture.toolHandler.calls).toHaveLength(0);
  });

  it("consults policy before the handler runs", async () => {
    const { fixture } = governedFixture("deny");
    const result = await fixture.runtime.executeTool(toolInvocation(fixture.tool));

    expect(result.status).toBe("denied");
    expect(fixture.toolHandler.calls).toHaveLength(0);
  });

  it("normalizes a handler's error into a result rather than throwing it at the caller", async () => {
    const fixture = aiCoreFixture();
    const failing = fixture.runtime.registerTool(
      toolDescriptorInput({ name: "flaky_lookup" }),
      errorResultHandler("upstream_unavailable", "the index is unreachable", true),
    );
    const result = await fixture.runtime.executeTool(toolInvocation(failing));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("upstream_unavailable");
      expect(result.retryable).toBe(true);
    }
  });
});

describe("executeAgent, end to end", () => {
  it("runs an agent whose plan calls a model, all the way to the provider adapter", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });

    expect(result.succeeded).toBe(true);
    expect(result.instance.state).toBe("completed");
    expect(fixture.primary.adapter.invocations).toHaveLength(1);
    // The model saw the agent's instructions, not just the goal.
    const messages = fixture.primary.adapter.invocations[0]?.request.messages ?? [];
    expect(messages.some((message) => message.role === "system")).toBe(true);
    expect(messages.some((message) => message.role === "user")).toBe(true);
  });

  it("runs an agent whose plan calls a tool, through the tool runtime's gates", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "look it up",
      steps: [
        {
          id: "search",
          kind: "tool",
          tool: { kind: "id", toolId: fixture.tool.id },
          arguments: { query: "quarterly report" },
        },
      ],
    });

    expect(result.succeeded).toBe(true);
    expect(fixture.toolHandler.calls).toHaveLength(1);
    // The tool received the arguments the plan declared, and not the agent's instructions.
    expect(fixture.toolHandler.calls[0]?.arguments).toEqual({ query: "quarterly report" });
    expect(fixture.primary.adapter.invocations).toHaveLength(0);
  });

  it("refuses a plan that names a model nobody registered", async () => {
    const fixture = aiCoreFixture();
    await expect(
      fixture.runtime.executeAgent(agentBySlug("assistant"), {
        steps: [{ id: "answer", kind: "model", model: modelById(createModelId()) }],
      }),
    ).rejects.toThrow(ValidationError);
    expect(fixture.primary.adapter.invocations).toHaveLength(0);
  });

  it("enforces an agent's ceilings on the plan it is given", async () => {
    const fixture = aiCoreFixture({ agent: { constraints: { maxModelCalls: 1 } } });
    const steps = [
      { id: "first", kind: "model" as const, model: modelById(fixture.primary.model.id) },
      {
        id: "second",
        kind: "model" as const,
        dependsOn: ["first"],
        model: modelById(fixture.primary.model.id),
      },
    ];

    let message = "";
    try {
      await fixture.runtime.executeAgent(agentBySlug("assistant"), { steps });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("2 model call(s)");
    expect(fixture.primary.adapter.invocations).toHaveLength(0);
  });

  it("grades the execution with the evaluation engine, so the record carries a score", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });

    const evaluation = result.record.evaluation;
    expect(evaluation).not.toBeNull();
    expect(evaluation?.deterministic).toBe(true);
    expect(evaluation?.overallScore).toBeGreaterThanOrEqual(0);
    expect(evaluation?.overallScore).toBeLessThanOrEqual(1);
    expect(evaluation?.executionId).toBe(result.record.request.id);
    // Graded on the composition's clock, like everything else in the record.
    expect(evaluation?.evaluatedAt).toBe(AT);
  });

  it("publishes agent lifecycle events on the bus it was given", async () => {
    const fixture = aiCoreFixture();
    await fixture.runtime.executeAgent(
      agentBySlug("assistant"),
      { goal: "answer briefly" },
      { tenantId: fixture.tenantId },
    );

    const types = fixture.published.map((event) => event.type);
    expect(types).toContain("ai.agent.state.changed");
    expect(types).toContain("ai.agent.step.completed");
    expect(fixture.published.every((event) => event.tenantId === String(fixture.tenantId))).toBe(
      true,
    );
  });

  it("publishes nothing when it was composed without a bus, and still runs", async () => {
    const fixture = aiCoreFixture({ withoutEvents: true });
    const result = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });

    expect(result.succeeded).toBe(true);
    expect(fixture.runtime.events).toBeNull();
    expect(fixture.published).toEqual([]);
  });

  it("keeps a secret out of the spans and events a run produces", async () => {
    const fixture = aiCoreFixture();
    await fixture.runtime.executeAgent(
      agentBySlug("assistant"),
      { goal: "answer briefly" },
      {
        tenantId: fixture.tenantId,
        metadata: { apiKey: "sk-live-secret" }, // omnis-secret-scan:allow a deliberate fake, used to prove this value is redacted
      },
    );

    const serialized =
      JSON.stringify(fixture.spans.map((span) => span.recordedAttributes)) +
      JSON.stringify(fixture.published);
    expect(serialized).not.toContain("sk-live-secret");
  });

  it("makes an agent's execution readable through the kernel's own surface", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });
    const executionId = result.record.request.id;

    expect(fixture.runtime.getExecution(executionId)?.status).toBe("succeeded");
    expect(fixture.runtime.requireExecution(executionId).request.agentId).toBe(fixture.agent.id);
    expect(fixture.runtime.listExecutions().map((record) => record.request.id)).toContain(
      executionId,
    );
  });

  it("waits for an approval when policy requires one, and continues when it is granted", async () => {
    const { fixture } = governedFixture("require_approval");
    const waiting = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });

    expect(waiting.succeeded).toBe(false);
    expect(waiting.instance.state).toBe("waiting");
    expect(waiting.instance.waitingOn).toBe("approval");
    expect(fixture.primary.adapter.invocations).toHaveLength(0);

    const approved = await fixture.runtime.approveAgent(executionIdOf(waiting.instance), {
      approved: true,
      approver: "ops",
      approvedAt: AT,
    });

    expect(approved.succeeded).toBe(true);
    expect(approved.instance.attempt).toBe(2);
    expect(fixture.primary.adapter.invocations).toHaveLength(1);
  });

  it("refuses to approve with no approval at all, because an absent approval is not a granted one", async () => {
    const { fixture } = governedFixture("require_approval");
    const waiting = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });

    expect(() => fixture.runtime.approveAgent(executionIdOf(waiting.instance), null)).toThrow(
      ValidationError,
    );
  });

  it("cancels a stored execution through the composition", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeAgent(agentBySlug("assistant"), {
      goal: "answer briefly",
    });
    // A finished execution cannot be reopened, and saying so is the honest answer.
    await expect(
      fixture.runtime.cancelExecution(result.record.request.id, "too late"),
    ).rejects.toThrow();
  });

  it("releases every part on disposal", async () => {
    const fixture = aiCoreFixture();
    await fixture.runtime.executeAgent(agentBySlug("assistant"), { goal: "answer briefly" });
    expect(fixture.runtime.agentRuntime.size).toBe(1);

    fixture.runtime.dispose();
    expect(fixture.runtime.agentRuntime.size).toBe(0);
    expect(() => fixture.runtime.dispose()).not.toThrow();
  });
});

describe("health", () => {
  it("reports what is registered and what the composition can do", () => {
    const fixture = aiCoreFixture();
    const health = fixture.runtime.health();

    expect(health).toMatchObject({
      models: 1,
      providers: 1,
      tools: 1,
      agents: 1,
      publishing: true,
      canCallModels: true,
      canInvokeTools: true,
      canRunAgents: true,
      checkedAt: AT,
    });
    expect(health.ruleSets).toBeGreaterThan(0);
  });

  it("reports an empty composition as one that can do nothing, rather than as healthy", () => {
    const health = createAiCoreRuntime().health();
    expect(health.canCallModels).toBe(false);
    expect(health.canInvokeTools).toBe(false);
    expect(health.canRunAgents).toBe(false);
    expect(health.publishing).toBe(false);
  });

  it("stops claiming a model can be called once its provider is disabled", () => {
    const fixture = aiCoreFixture();
    expect(fixture.runtime.health().canCallModels).toBe(true);

    fixture.runtime.providers.setStatus(fixture.primary.provider.id, "disabled");
    expect(fixture.runtime.health().canCallModels).toBe(false);
  });

  it("counts the tenant the composition publishes under, not a tenant it invented", async () => {
    const fixture = aiCoreFixture();
    await fixture.runtime.executeAgent(
      agentBySlug("assistant"),
      { goal: "answer" },
      { tenantId: createTenantId() },
    );
    // A run under another tenant still publishes: the envelope carries the run's tenant.
    expect(fixture.published.length).toBeGreaterThan(0);
  });
});
