/**
 * What a composition says about itself.
 *
 * The interesting half of a health snapshot is not the counts — a registry can count itself.
 * It is the derived flags, because they are the difference between "we have three models" and
 * "we can call one". These tests therefore spend most of their effort breaking a composition
 * in one specific way and checking that the snapshot stops claiming the thing it can no
 * longer do, rather than testing that arithmetic works.
 */

import { describe, expect, it } from "vitest";
import { agentBySlug, assertJsonSafe, modelById } from "@omnis/ai-core-types";
import type { EventBus } from "@omnis/events";
import { createAiCoreRuntime } from "./AiCoreRuntime.js";
import { aiCoreHealth, describeAiCoreRuntime } from "./runtimeHealth.js";
import { AT, AT_MS, aiCoreFixture } from "./testSupport.js";

/** A bus that fails every publish, to prove a publish failure is contained and counted. */
function throwingBus(): EventBus {
  return {
    publish(): Promise<void> {
      throw new Error("the bus is not accepting events");
    },
    subscribe: () => ({ unsubscribe: (): void => {} }),
    subscribeAll: () => ({ unsubscribe: (): void => {} }),
    subscriberCount: () => 0,
  } as unknown as EventBus;
}

describe("an empty composition", () => {
  it("reports zero of everything, and claims it can do nothing", () => {
    const health = aiCoreHealth(createAiCoreRuntime({ clock: () => AT_MS }), AT);

    expect(health).toMatchObject({
      models: 0,
      providers: 0,
      tools: 0,
      agents: 0,
      policySets: 0,
      budgets: 0,
      executions: 0,
      agentInstances: 0,
      publishFailures: 0,
      publishing: false,
      canCallModels: false,
      canInvokeTools: false,
      canRunAgents: false,
      checkedAt: AT,
    });
  });

  it("counts a default rule set, because grading works before anything is registered", () => {
    const health = aiCoreHealth(createAiCoreRuntime({ clock: () => AT_MS }), AT);
    expect(health.ruleSets).toBeGreaterThan(0);
  });
});

describe("a composed fixture", () => {
  it("reports what was registered, and that all three kinds of work are possible", () => {
    const fixture = aiCoreFixture();
    const health = aiCoreHealth(fixture.runtime, AT);

    expect(health).toMatchObject({
      models: 1,
      providers: 1,
      tools: 1,
      agents: 1,
      publishing: true,
    });
    expect(health.canCallModels).toBe(true);
    expect(health.canInvokeTools).toBe(true);
    expect(health.canRunAgents).toBe(true);
  });

  it("is what runtime.health() returns, so there is one snapshot and not two", () => {
    const fixture = aiCoreFixture();
    expect(fixture.runtime.health()).toMatchObject({
      models: 1,
      providers: 1,
      tools: 1,
      agents: 1,
    });
  });

  it("is frozen and JSON-safe, because it is meant to be logged and served", () => {
    const health = aiCoreHealth(aiCoreFixture().runtime, AT);
    expect(Object.isFrozen(health)).toBe(true);
    expect(() => assertJsonSafe(health, "aiCoreHealth")).not.toThrow();
    expect(JSON.parse(JSON.stringify(health))).toEqual({ ...health });
  });

  it("counts a policy set, a budget and a rule set as they are registered", () => {
    const runtime = aiCoreFixture().runtime;
    expect(aiCoreHealth(runtime, AT)).toMatchObject({ policySets: 0, budgets: 0 });

    runtime.registerPolicySet({
      name: "counted-set",
      description: "Exists so a health snapshot has something to count.",
      rules: [{ id: "always-allow", name: "always allow", outcome: "allow" }],
      defaultOutcome: "allow",
      createdAt: AT,
    });
    runtime.registerBudget({
      name: "counted-budget",
      limits: [{ dimension: "requests", window: "execution", limit: 10 }],
      createdAt: AT,
    });
    runtime.registerRuleSet({
      name: "counted-rules",
      description: "Counted.",
      rules: [],
      createdAt: AT,
    });

    const after = aiCoreHealth(runtime, AT);
    expect(after).toMatchObject({ policySets: 1, budgets: 1, ruleSets: 2 });
  });
});

describe("the derived flags", () => {
  it("stops claiming it can call models when the only provider is disabled", () => {
    const fixture = aiCoreFixture();
    expect(aiCoreHealth(fixture.runtime, AT).canCallModels).toBe(true);

    fixture.runtime.providers.setStatus(fixture.primary.provider.id, "disabled");
    const health = aiCoreHealth(fixture.runtime, AT);
    // Counting the provider would still say one; a disabled provider cannot serve a call,
    // and a snapshot that said otherwise would be the green light that gets paged.
    expect(health.providers).toBe(1);
    expect(health.canCallModels).toBe(false);
  });

  it("stops claiming it can call models when the model is gone but the provider remains", () => {
    const fixture = aiCoreFixture();
    fixture.runtime.models.remove(fixture.primary.model.id);

    const health = aiCoreHealth(fixture.runtime, AT);
    expect(health.models).toBe(0);
    expect(health.providers).toBe(1);
    expect(health.canCallModels).toBe(false);
  });

  it("stops claiming it can invoke tools when the only tool is disabled", () => {
    const fixture = aiCoreFixture();
    expect(aiCoreHealth(fixture.runtime, AT).canInvokeTools).toBe(true);

    fixture.runtime.tools.setStatus(fixture.tool.id, "disabled");
    const health = aiCoreHealth(fixture.runtime, AT);
    expect(health.tools).toBe(1);
    expect(health.canInvokeTools).toBe(false);
  });

  it("stops claiming it can run agents when the only agent is retired", () => {
    const fixture = aiCoreFixture();
    fixture.runtime.agents.setStatus(fixture.agent.id, "retired");

    const health = aiCoreHealth(fixture.runtime, AT);
    expect(health.agents).toBe(1);
    expect(health.canRunAgents).toBe(false);
  });

  it("reports no event bus when the composition was built without one", () => {
    const health = aiCoreHealth(aiCoreFixture({ withoutEvents: true }).runtime, AT);
    expect(health.publishing).toBe(false);
  });
});

describe("what a run adds to the snapshot", () => {
  it("counts the executions the kernel ran, and not the calls it did not run", async () => {
    const fixture = aiCoreFixture();

    // A bare model call is governed by the orchestrator: it opens an execution of its own and
    // never enters the kernel, so the kernel has no record to hold. Counting it would make an
    // operator look for a step plan that was never there.
    await fixture.runtime.executeModel({
      model: modelById(fixture.primary.model.id),
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }], name: null, metadata: {} },
      ],
    });
    expect(aiCoreHealth(fixture.runtime, AT).executions).toBe(0);

    await fixture.runtime.executeAgent(agentBySlug(fixture.agent.slug), { goal: "answer briefly" });
    const after = aiCoreHealth(fixture.runtime, AT);
    expect(after.executions).toBe(1);
    expect(after.executions).toBe(fixture.runtime.listExecutions().length);
  });

  it("counts the agent instances the agent runtime is tracking", async () => {
    const fixture = aiCoreFixture();
    const result = await fixture.runtime.executeAgent(agentBySlug(fixture.agent.slug), {
      goal: "answer briefly",
    });

    const health = aiCoreHealth(fixture.runtime, AT);
    expect(result.status).toBe("succeeded");
    expect(health.agentInstances).toBe(fixture.runtime.agentRuntime.size);
    expect(health.agentInstances).toBeGreaterThan(0);
    expect(health.publishFailures).toBe(0);
    expect(health.executions).toBeGreaterThan(0);
  });

  it("counts events that could not be published, without failing the run that published them", async () => {
    const fixture = aiCoreFixture({ runtime: { events: throwingBus() } });
    const result = await fixture.runtime.executeAgent(agentBySlug(fixture.agent.slug), {
      goal: "answer briefly",
    });

    const health = aiCoreHealth(fixture.runtime, AT);
    // The run succeeded: a bus that refuses events is an observability problem, and turning
    // it into an execution failure would make monitoring able to break production.
    expect(result.status).toBe("succeeded");
    expect(health.publishing).toBe(true);
    expect(health.publishFailures).toBeGreaterThan(0);
    expect(health.publishFailures).toBe(fixture.runtime.agentRuntime.publishFailures().length);
  });
});

describe("the one-line rendering", () => {
  it("names the counts and the bus state", () => {
    const line = describeAiCoreRuntime(aiCoreFixture().runtime);
    expect(line).toContain("ai-core: 1 model(s), 1 provider(s), 1 tool(s), 1 agent(s)");
    expect(line).toContain("publishing events");
  });

  it("says plainly when there is no bus", () => {
    expect(describeAiCoreRuntime(aiCoreFixture({ withoutEvents: true }).runtime)).toContain(
      "no event bus",
    );
  });
});
