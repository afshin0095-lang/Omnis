/**
 * How a run becomes a plan.
 *
 * The planner is the only place an agent's intentions turn into steps the kernel can
 * run, so these tests pin both halves: what it builds, and what it refuses to build.
 * A plan that quietly ignored an agent's ceilings would be a ceiling that only exists
 * in documentation.
 */

import { describe, expect, it } from "vitest";
import { createExecutionId, createModelId, createToolId } from "@omnis/types";
import { modelById, toolById } from "@omnis/ai-core-types";
import type { AgentDescriptor, ModelId, ToolId } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import { MAX_AGENT_PLAN_STEPS, planAgentRun } from "./agentPlanning.js";
import type { AgentPlanResolvers } from "./agentPlanning.js";
import { createAgentRegistry } from "./AgentRegistry.js";
import { agentRun, AT, executionRequest, registerAgent, testClock } from "./testSupport.js";
import type { AgentRunInput } from "./agentValidation.js";

/** Resolvers that accept any identifier reference and refuse anything else. */
const resolvers: AgentPlanResolvers = {
  modelId: (reference) =>
    reference.kind === "id" ? reference.modelId : (createModelId() as ModelId),
  toolId: (reference) => (reference.kind === "id" ? reference.toolId : (createToolId() as ToolId)),
};

function plan(
  descriptor: AgentDescriptor,
  input: AgentRunInput = agentRun(),
  planResolvers: AgentPlanResolvers = resolvers,
) {
  return planAgentRun(
    { descriptor, request: executionRequest(), input, resolvers: planResolvers },
    () => Date.parse(AT),
  );
}

function agent(overrides: Parameters<typeof registerAgent>[1] = {}): AgentDescriptor {
  return registerAgent(createAgentRegistry(), {
    defaultModel: modelById(createModelId()),
    ...overrides,
  });
}

describe("a plan derived from the descriptor", () => {
  it("produces one model step against the agent's preferred model", () => {
    const modelId = createModelId();
    const built = plan(agent({ defaultModel: modelById(modelId) }));

    expect(built.steps).toHaveLength(1);
    expect(built.steps[0]?.kind).toBe("model");
    expect(built.steps[0]?.modelId).toBe(modelId);
    expect(built.steps[0]?.toolId).toBeNull();
    expect(built.steps[0]?.dependsOn).toEqual([]);
    expect(built.steps[0]?.optional).toBe(false);
  });

  it("names the step after the agent, so an audit row says whose work it was", () => {
    const built = plan(agent({ slug: "brief-writer", displayName: "Brief writer" }));
    expect(built.steps[0]?.id).toBe("brief-writer-answer");
    expect(built.steps[0]?.name).toBe("Brief writer answers");
  });

  it("carries the execution's identifier and the clock's instant", () => {
    const executionId = createExecutionId();
    const built = planAgentRun(
      {
        descriptor: agent(),
        request: executionRequest({ id: executionId }),
        input: agentRun(),
        resolvers,
      },
      testClock(Date.parse(AT)),
    );
    expect(built.executionId).toBe(executionId);
    expect(built.createdAt).toBe(AT);
    expect(built.steps.length).toBeGreaterThan(0);
  });

  it("prefers a declared model preference over the default model", () => {
    const preferred = createModelId();
    const built = plan(
      agent({
        defaultModel: modelById(createModelId()),
        constraints: { preferredModels: [modelById(preferred)] },
      }),
    );
    expect(built.steps[0]?.modelId).toBe(preferred);
  });

  it("refuses to invent a step for an agent that declares no model", () => {
    let caught: unknown = null;
    try {
      plan(agent({ defaultModel: null }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("no default model");
  });

  it("refuses a model reference nobody can resolve, and says who was missing", () => {
    let message = "";
    try {
      plan(agent(), agentRun(), {});
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("no model resolver");

    const refusing: AgentPlanResolvers = { modelId: () => null };
    let unresolved = "";
    try {
      plan(agent(), agentRun(), refusing);
    } catch (error) {
      unresolved = (error as ValidationError).message;
    }
    expect(unresolved).toContain("is not registered");
  });
});

describe("a plan supplied by the caller", () => {
  it("keeps the caller's steps, order and dependencies", () => {
    const built = plan(agent(), {
      goal: "answer with evidence",
      steps: [
        { id: "retrieve", kind: "tool", tool: toolById(createToolId()) },
        { id: "answer", kind: "model", dependsOn: ["retrieve"], model: modelById(createModelId()) },
      ],
    });

    expect(built.steps.map((step) => step.id)).toEqual(["retrieve", "answer"]);
    expect(built.steps[0]?.kind).toBe("tool");
    expect(built.steps[1]?.dependsOn).toEqual(["retrieve"]);
  });

  it("hands every step the goal and the run data, unless the step declares its own", () => {
    const built = plan(agent(), {
      goal: "summarise",
      data: { briefId: "brief_1" },
      steps: [
        { id: "inherited", kind: "model", model: modelById(createModelId()) },
        {
          id: "specific",
          kind: "model",
          model: modelById(createModelId()),
          input: { briefId: "brief_2" },
        },
      ],
    });

    expect(built.steps[0]?.input).toEqual({
      goal: "summarise",
      briefId: "brief_1",
      // The descriptor's instructions travel with a model step: without them the agent's
      // behaviour contract would never reach the model that is supposed to follow it.
      instructions: {
        system: "Answer briefly.",
        developer: null,
        prohibitions: ["never invent a citation"],
      },
    });
    // A step's own input wins, key by key, rather than replacing the whole bag.
    expect(built.steps[1]?.input).toMatchObject({ goal: "summarise", briefId: "brief_2" });
  });

  it("gives a tool step no instructions, because a tool has no use for a system prompt", () => {
    const built = plan(agent(), {
      goal: "look it up",
      steps: [{ id: "search", kind: "tool", tool: toolById(createToolId()) }],
    });
    expect(built.steps[0]?.input).toEqual({ goal: "look it up" });
  });

  it("omits the instructions key entirely for an agent that declared none", () => {
    const built = plan(agent({ instructions: { developer: null, prohibitions: [] } }));
    expect(built.steps[0]?.input).not.toHaveProperty("instructions");
  });

  it("refuses a step that calls a tool the agent denies", () => {
    const denied = createToolId();
    let message = "";
    try {
      plan(agent({ constraints: { deniedTools: [denied] } }), {
        steps: [{ id: "call", kind: "tool", tool: toolById(denied) }],
      });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("denies");
  });

  it("refuses a step that calls a tool outside the agent's allowed list", () => {
    const allowed = createToolId();
    let message = "";
    try {
      plan(agent({ constraints: { allowedTools: [allowed] } }), {
        steps: [{ id: "call", kind: "tool", tool: toolById(createToolId()) }],
      });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("not in the agent's allowed tools");
  });

  it("accepts a step that calls an allowed tool", () => {
    const allowed = createToolId();
    const built = plan(agent({ constraints: { allowedTools: [allowed] } }), {
      steps: [{ id: "call", kind: "tool", tool: toolById(allowed) }],
    });
    expect(built.steps[0]?.toolId).toBe(allowed);
  });

  it("gives a model step that names no model the agent's own default", () => {
    // "The agent's default model" means every model step the agent runs, not only the one
    // the planner derives. A plan that had to restate it would make the default decorative.
    const defaultModelId = createModelId();
    const built = plan(agent({ defaultModel: modelById(defaultModelId) }), {
      goal: "answer",
      steps: [{ id: "answer", kind: "model" }],
    });

    expect(built.steps[0]?.modelId).toBe(defaultModelId);
  });

  it("prefers the model a step named over the agent's default", () => {
    const stepModelId = createModelId();
    const built = plan(agent({ defaultModel: modelById(createModelId()) }), {
      goal: "answer",
      steps: [{ id: "answer", kind: "model", model: modelById(stepModelId) }],
    });

    expect(built.steps[0]?.modelId).toBe(stepModelId);
  });

  it("prefers a declared model preference over the default, for a supplied step too", () => {
    const preferredId = createModelId();
    const built = plan(
      agent({
        defaultModel: modelById(createModelId()),
        constraints: { preferredModels: [modelById(preferredId)] },
      }),
      { goal: "answer", steps: [{ id: "answer", kind: "model" }] },
    );

    expect(built.steps[0]?.modelId).toBe(preferredId);
  });

  it("refuses a model step with no model and no default, and names the step", () => {
    // Refused at planning, with the step named: an executor that received it would have to
    // choose a model, and then the audit row would describe work nobody asked for.
    let raised: unknown = null;
    try {
      plan(agent({ defaultModel: null }), {
        goal: "answer",
        steps: [{ id: "answer", kind: "model" }],
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ValidationError);
    expect((raised as ValidationError).message).toContain('"answer"');
    expect((raised as ValidationError).message).toContain("declares no default");
  });

  it("leaves a tool step with no model, because a tool has no use for one", () => {
    const built = plan(agent(), {
      goal: "look it up",
      steps: [{ id: "search", kind: "tool", tool: toolById(createToolId()) }],
    });

    expect(built.steps[0]?.kind).toBe("tool");
    expect(built.steps[0]?.modelId).toBeNull();
  });

  it("refuses a plan that names the same step twice", () => {
    let message = "";
    try {
      plan(agent(), {
        steps: [
          { id: "same", kind: "model", model: modelById(createModelId()) },
          { id: "same", kind: "model", model: modelById(createModelId()) },
        ],
      });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("more than once");
  });

  it("refuses a plan with a cycle, because the kernel could never run it", () => {
    expect(() =>
      plan(agent(), {
        steps: [
          { id: "a", kind: "model", dependsOn: ["b"], model: modelById(createModelId()) },
          { id: "b", kind: "model", dependsOn: ["a"], model: modelById(createModelId()) },
        ],
      }),
    ).toThrow();
  });

  it("reports every problem with a plan at once, not one rebuild at a time", () => {
    const denied = createToolId();
    let message = "";
    try {
      plan(agent({ constraints: { deniedTools: [denied], maxSteps: 1 } }), {
        steps: [
          { id: "call", kind: "tool", tool: toolById(denied) },
          { id: "call", kind: "tool", tool: toolById(denied) },
        ],
      });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("denies");
    expect(message).toContain("more than once");
    expect(message).toContain("allows 1");
  });
});

describe("the descriptor's ceilings applied to a plan", () => {
  it("refuses a plan longer than the agent's maxSteps", () => {
    let message = "";
    try {
      plan(agent({ constraints: { maxSteps: 2 } }), {
        steps: [
          { id: "one", kind: "model", model: modelById(createModelId()) },
          { id: "two", kind: "model", model: modelById(createModelId()) },
          { id: "three", kind: "model", model: modelById(createModelId()) },
        ],
      });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("3 steps");
    expect(message).toContain("allows 2");
  });

  it("refuses a plan longer than the platform maximum", () => {
    const steps = Array.from({ length: MAX_AGENT_PLAN_STEPS + 1 }, (_unused, index) => ({
      id: `step-${String(index)}`,
      kind: "model" as const,
      model: modelById(createModelId()),
    }));
    let message = "";
    try {
      plan(agent(), { steps });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("the platform allows");
  });

  it("bounds each step's attempts by the agent's retries-per-step ceiling", () => {
    const built = plan(agent({ constraints: { maxRetriesPerStep: 1 } }), {
      steps: [{ id: "answer", kind: "model", maxAttempts: 3, model: modelById(createModelId()) }],
    });
    // `maxRetriesPerStep: 1` means one retry, which is two attempts including the first.
    expect(built.steps[0]?.maxAttempts).toBe(2);
  });

  it("never bounds a step below one attempt, which would be a step that cannot run", () => {
    const built = plan(agent({ constraints: { maxRetriesPerStep: 0 } }), {
      steps: [{ id: "answer", kind: "model", maxAttempts: 3, model: modelById(createModelId()) }],
    });
    expect(built.steps[0]?.maxAttempts).toBe(1);
  });

  it("bounds a step timeout by the agent's duration ceiling", () => {
    const built = plan(agent({ constraints: { maxDurationMs: 5_000 } }), {
      steps: [
        { id: "answer", kind: "model", timeoutMs: 60_000, model: modelById(createModelId()) },
      ],
    });
    expect(built.steps[0]?.timeoutMs).toBe(5_000);
  });

  it("gives a step with no timeout the agent's ceiling rather than an unbounded one", () => {
    const built = plan(agent({ constraints: { maxDurationMs: 5_000 } }), {
      steps: [{ id: "answer", kind: "model", model: modelById(createModelId()) }],
    });
    expect(built.steps[0]?.timeoutMs).toBe(5_000);
  });

  it("leaves a step unbounded when the agent declares no duration ceiling", () => {
    const built = plan(agent(), {
      steps: [{ id: "answer", kind: "model", model: modelById(createModelId()) }],
    });
    expect(built.steps[0]?.timeoutMs).toBeNull();
  });
});
