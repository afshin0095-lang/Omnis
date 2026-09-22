/**
 * The runtime's input contracts.
 *
 * These tests pin two things: that a well-formed registration or run input is
 * accepted with its defaults visible, and that the near-misses a caller actually
 * makes are refused rather than silently corrected — an unknown key, a negative
 * ceiling, an agent step inside an agent plan.
 */

import { describe, expect, it } from "vitest";
import {
  createAgentId,
  createBudgetId,
  createModelId,
  createPolicyId,
  createToolId,
} from "@omnis/types";
import { modelBySlug } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import { validate } from "@omnis/validation";
import {
  AGENT_PLAN_STEP_CONTRACT,
  AGENT_REGISTRATION_CONTRACT,
  AGENT_RUN_INPUT_CONTRACT,
  agentPlanStepInputSchema,
  agentRegistrationInputSchema,
  agentRunInputSchema,
  isAgentCapabilityValue,
  isAgentKindValue,
  isAgentMemoryKindValue,
  isAgentStatusValue,
} from "./agentValidation.js";
import { createAgentRegistry } from "./AgentRegistry.js";

function parseRegistration(input: unknown) {
  return validate(agentRegistrationInputSchema, input, AGENT_REGISTRATION_CONTRACT);
}

describe("the registration contract", () => {
  it("names the contracts it publishes, so a validation error says which one broke", () => {
    expect(AGENT_REGISTRATION_CONTRACT).toBe("AgentRegistrationInput");
    expect(AGENT_RUN_INPUT_CONTRACT).toBe("AgentRunInput");
    expect(AGENT_PLAN_STEP_CONTRACT).toBe("AgentPlanStepInput");

    let message = "";
    try {
      parseRegistration({ kind: "reactive" });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain(AGENT_REGISTRATION_CONTRACT);
  });

  it("accepts a full registration and keeps every supplied fact", () => {
    const parsed = parseRegistration({
      id: createAgentId(),
      slug: "assistant",
      displayName: "Assistant",
      description: "Answers briefly.",
      kind: "planner",
      status: "active",
      version: "1.2.0",
      capabilities: ["planning", "tool_use", "streaming"],
      instructions: {
        system: "Answer briefly.",
        developer: null,
        prohibitions: ["no legal advice"],
      },
      defaultModel: modelBySlug("fast-model"),
      tools: [
        {
          toolId: createToolId(),
          timeoutMsOverride: 2_000,
          maxCallsPerExecution: 3,
          required: true,
        },
      ],
      memory: [{ kind: "short_term", storeId: "store-1", scope: "tenant-a", writable: true }],
      constraints: {
        maxSteps: 4,
        maxModelCalls: 8,
        allowedTools: [createToolId()],
        preferredModels: [modelBySlug("fast-model")],
      },
      policyId: createPolicyId(),
      budgetId: createBudgetId(),
      metadata: { team: "growth" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.slug).toBe("assistant");
    expect(parsed.kind).toBe("planner");
    expect(parsed.tools?.[0]?.maxCallsPerExecution).toBe(3);
    expect(parsed.constraints?.maxSteps).toBe(4);
    expect(parsed.memory?.[0]?.writable).toBe(true);
  });

  it("refuses an unknown key rather than ignoring what a caller meant", () => {
    // `contraints` is a typo a caller cannot see the effect of: the ceiling they
    // believed they set would never apply.
    expect(() =>
      parseRegistration({ slug: "assistant", kind: "reactive", contraints: { maxSteps: 2 } }),
    ).toThrow(ValidationError);
  });

  it("refuses a ceiling that could not bound anything", () => {
    expect(() =>
      parseRegistration({ slug: "assistant", kind: "reactive", constraints: { maxSteps: 0 } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseRegistration({ slug: "assistant", kind: "reactive", constraints: { maxSteps: -1 } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseRegistration({
        slug: "assistant",
        kind: "reactive",
        constraints: { maxDurationMs: 1.5 },
      }),
    ).toThrow(ValidationError);
  });

  it("accepts a null ceiling, which means the runtime default applies", () => {
    const parsed = parseRegistration({
      slug: "assistant",
      kind: "reactive",
      constraints: { maxSteps: null, maxCostMicroUsd: null },
    });
    expect(parsed.constraints?.maxSteps).toBeNull();
  });

  it("refuses a slug that is too short or blank, and trims one that is padded", () => {
    expect(() => parseRegistration({ slug: "a", kind: "reactive" })).toThrow(ValidationError);
    expect(() => parseRegistration({ slug: " ".repeat(3), kind: "reactive" })).toThrow(
      ValidationError,
    );
    // Trimming is the platform convention for every branded string. The consequence
    // — two slugs that differ only by whitespace are one agent — is asserted by the
    // registry's duplicate test rather than left to surprise anybody.
    expect(parseRegistration({ slug: "assistant ", kind: "reactive" }).slug).toBe("assistant");
  });

  it("trims free text, because nobody means the spaces around a display name", () => {
    const parsed = parseRegistration({
      slug: "assistant",
      kind: "reactive",
      displayName: " padded ",
    });
    expect(parsed.displayName).toBe("padded");
  });

  it("refuses a kind, status, capability or memory kind outside the declared vocabularies", () => {
    expect(() => parseRegistration({ slug: "assistant", kind: "sentient" })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseRegistration({ slug: "assistant", kind: "reactive", status: "paused" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseRegistration({ slug: "assistant", kind: "reactive", capabilities: ["consciousness"] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseRegistration({
        slug: "assistant",
        kind: "reactive",
        memory: [{ kind: "collective", storeId: "s" }],
      }),
    ).toThrow(ValidationError);
  });

  it("refuses an identifier of the wrong kind", () => {
    expect(() =>
      parseRegistration({ slug: "assistant", kind: "reactive", policyId: createBudgetId() }),
    ).toThrow(ValidationError);
    expect(() =>
      parseRegistration({
        slug: "assistant",
        kind: "reactive",
        tools: [{ toolId: createModelId() }],
      }),
    ).toThrow(ValidationError);
  });

  it("agrees with the guards the types package publishes", () => {
    expect(isAgentKindValue("reactive")).toBe(true);
    expect(isAgentKindValue("sentient")).toBe(false);
    expect(isAgentStatusValue("active")).toBe(true);
    expect(isAgentStatusValue("paused")).toBe(false);
    expect(isAgentCapabilityValue("tool_use")).toBe(true);
    expect(isAgentCapabilityValue("telepathy")).toBe(false);
    expect(isAgentMemoryKindValue("episodic")).toBe(true);
    expect(isAgentMemoryKindValue("collective")).toBe(false);
  });

  it("is what the registry parses with, so the two cannot drift", () => {
    const registry = createAgentRegistry();
    // The registry accepts the same shapes the schema accepts, and refuses the same
    // ones it refuses: one contract, two call sites.
    expect(() => registry.register({ slug: "assistant", kind: "reactive" })).not.toThrow();
    expect(() => registry.register({ slug: "second", kind: "sentient" } as never)).toThrow(
      ValidationError,
    );
  });
});

describe("the run input contract", () => {
  it("accepts a goal, data and an explicit plan", () => {
    const parsed = validate(
      agentRunInputSchema,
      {
        goal: "summarise the brief",
        data: { briefId: "brief_1", words: 200 },
        steps: [
          { id: "retrieve", kind: "tool", tool: { kind: "name", name: "search" } },
          {
            id: "answer",
            kind: "model",
            dependsOn: ["retrieve"],
            model: modelBySlug("fast-model"),
            maxAttempts: 2,
          },
        ],
      },
      AGENT_RUN_INPUT_CONTRACT,
    );
    expect(parsed.goal).toBe("summarise the brief");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps?.[1]?.dependsOn).toEqual(["retrieve"]);
  });

  it("accepts an empty run input, which means the descriptor decides", () => {
    expect(() => validate(agentRunInputSchema, {}, AGENT_RUN_INPUT_CONTRACT)).not.toThrow();
  });

  it("refuses an agent step inside an agent plan", () => {
    // A step that ran another agent would make the runtime recursive with no depth
    // bound, no cycle detection across agents and no delegation policy.
    expect(() =>
      validate(agentPlanStepInputSchema, { id: "nested", kind: "agent" }, AGENT_PLAN_STEP_CONTRACT),
    ).toThrow(ValidationError);
  });

  it("refuses a step with no identifier, or an attempt count that is not bounded", () => {
    expect(() =>
      validate(agentPlanStepInputSchema, { kind: "model" }, AGENT_PLAN_STEP_CONTRACT),
    ).toThrow(ValidationError);
    expect(() =>
      validate(
        agentPlanStepInputSchema,
        { id: "s", kind: "model", maxAttempts: 0 },
        AGENT_PLAN_STEP_CONTRACT,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      validate(
        agentPlanStepInputSchema,
        { id: "s", kind: "model", maxAttempts: 9 },
        AGENT_PLAN_STEP_CONTRACT,
      ),
    ).toThrow(ValidationError);
  });

  it("refuses an unknown key in a run input, for the same reason it refuses one in a registration", () => {
    expect(() =>
      validate(agentRunInputSchema, { goal: "x", steps_: [] }, AGENT_RUN_INPUT_CONTRACT),
    ).toThrow(ValidationError);
  });

  it("bounds a goal, so a run input cannot become an unbounded payload", () => {
    expect(() =>
      validate(agentRunInputSchema, { goal: "a".repeat(8_193) }, AGENT_RUN_INPUT_CONTRACT),
    ).toThrow(ValidationError);
    expect(() =>
      validate(agentRunInputSchema, { goal: "a".repeat(8_192) }, AGENT_RUN_INPUT_CONTRACT),
    ).not.toThrow();
  });
});
