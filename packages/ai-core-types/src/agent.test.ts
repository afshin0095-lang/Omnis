import { describe, expect, it } from "vitest";
import { createAgentId, createToolId } from "@omnis/types";
import {
  agentById,
  agentBySlug,
  agentToolBinding,
  agentToolIds,
  AGENT_STATES,
  assertAgentDescriptorShape,
  describeAgentReference,
  isActiveAgentState,
  isAgentCapability,
  isExecutableAgentStatus,
  isTerminalAgentState,
  MAX_REQUEST_TOOLS,
  UNCONSTRAINED_AGENT,
  type AgentDescriptor,
  type AgentToolBinding,
} from "./index.js";

function binding(toolId: ReturnType<typeof createToolId>): AgentToolBinding {
  return { toolId, timeoutMsOverride: null, maxCallsPerExecution: 0, required: false };
}

function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    id: createAgentId(),
    slug: "researcher",
    displayName: "Researcher",
    description: "Researches a topic and returns sourced notes.",
    kind: "autonomous",
    status: "active",
    version: "1.0.0",
    capabilities: ["planning", "tool_use"],
    instructions: {
      system: "Research carefully.",
      developer: null,
      prohibitions: ["never invent a citation"],
    },
    defaultModel: null,
    tools: [],
    memory: [],
    constraints: UNCONSTRAINED_AGENT,
    policyId: null,
    budgetId: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("agent states", () => {
  it("declares the nine lifecycle states", () => {
    expect(AGENT_STATES).toEqual([
      "created",
      "ready",
      "planning",
      "running",
      "waiting",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("treats completed, failed and cancelled as terminal", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalAgentState(state), state).toBe(true);
    }
    for (const state of ["created", "ready", "planning", "running", "waiting", "paused"] as const) {
      expect(isTerminalAgentState(state), state).toBe(false);
    }
  });

  it("counts planning, running and waiting as consuming budget", () => {
    // A waiting agent still holds a budget reservation: it is mid-execution, blocked on
    // a tool result or an approval, and will resume.
    expect(isActiveAgentState("planning")).toBe(true);
    expect(isActiveAgentState("running")).toBe(true);
    expect(isActiveAgentState("waiting")).toBe(true);
    expect(isActiveAgentState("paused")).toBe(false);
    expect(isActiveAgentState("ready")).toBe(false);
    expect(isActiveAgentState("completed")).toBe(false);
  });
});

describe("agent status", () => {
  it("executes only active agents", () => {
    expect(isExecutableAgentStatus("active")).toBe(true);
    // A draft agent is still being authored; running it would execute unreviewed
    // instructions with real tools.
    expect(isExecutableAgentStatus("draft")).toBe(false);
    expect(isExecutableAgentStatus("disabled")).toBe(false);
    expect(isExecutableAgentStatus("retired")).toBe(false);
  });
});

describe("agent references", () => {
  it("builds and describes both reference kinds", () => {
    const agentId = createAgentId();
    expect(agentById(agentId)).toEqual({ kind: "id", agentId });
    expect(agentBySlug("researcher")).toEqual({ kind: "slug", slug: "researcher" });
    expect(describeAgentReference(agentById(agentId))).toBe(`id:${agentId}`);
    expect(describeAgentReference(agentBySlug("researcher"))).toBe("slug:researcher");
  });
});

describe("capabilities", () => {
  it("recognizes only declared agent capabilities", () => {
    expect(isAgentCapability("planning")).toBe(true);
    expect(isAgentCapability("tool_use")).toBe(true);
    // A model capability is not an agent capability: the vocabularies are separate.
    expect(isAgentCapability("chat")).toBe(false);
  });
});

describe("assertAgentDescriptorShape", () => {
  it("accepts a coherent descriptor", () => {
    const toolId = createToolId();
    expect(() =>
      assertAgentDescriptorShape(descriptor({ tools: [binding(toolId)] })),
    ).not.toThrow();
  });

  it("rejects a duplicate tool binding", () => {
    // Two bindings for one tool would make the per-execution call limit ambiguous.
    const toolId = createToolId();
    expect(() =>
      assertAgentDescriptorShape(descriptor({ tools: [binding(toolId), binding(toolId)] })),
    ).toThrow(RangeError);
  });

  it("rejects more bindings than the contract allows", () => {
    const tools = Array.from({ length: MAX_REQUEST_TOOLS + 1 }, () => binding(createToolId()));
    expect(() => assertAgentDescriptorShape(descriptor({ tools }))).toThrow(RangeError);
  });
});

describe("tool binding lookups", () => {
  it("lists bound tool identifiers in binding order", () => {
    const first = createToolId();
    const second = createToolId();
    expect(agentToolIds(descriptor({ tools: [binding(first), binding(second)] }))).toEqual([
      first,
      second,
    ]);
  });

  it("finds one binding or returns null", () => {
    const bound = createToolId();
    const subject = descriptor({ tools: [binding(bound)] });
    expect(agentToolBinding(subject, bound)?.toolId).toBe(bound);
    expect(agentToolBinding(subject, createToolId())).toBeNull();
  });
});

describe("unconstrained defaults", () => {
  it("imposes nothing so the runtime default applies", () => {
    expect(UNCONSTRAINED_AGENT).toEqual({
      maxSteps: null,
      maxModelCalls: null,
      maxToolCalls: null,
      maxDurationMs: null,
      maxCostMicroUsd: null,
      maxRetriesPerStep: null,
      allowedTools: [],
      deniedTools: [],
      approvalRequiredAtRisk: [],
      preferredModels: [],
    });
    expect(Object.isFrozen(UNCONSTRAINED_AGENT)).toBe(true);
  });
});
