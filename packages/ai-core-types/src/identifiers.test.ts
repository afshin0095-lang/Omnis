import { describe, expect, it } from "vitest";
import { asCausationId, createCommandId, parseIdentifier } from "@omnis/types";
import {
  createAiCoreIdentity,
  createBudgetId,
  createCorrelationId,
  createEvaluationId,
  createExecutionId,
  createModelId,
  createPlanId,
  createPolicyId,
  createProviderId,
  createReservationId,
  createToolId,
} from "./index.js";

const FACTORIES = {
  model: createModelId,
  provider: createProviderId,
  tool: createToolId,
  policy: createPolicyId,
  budget: createBudgetId,
  reservation: createReservationId,
  evaluation: createEvaluationId,
  plan: createPlanId,
} as const;

describe("AI Core identifiers", () => {
  it("mints one distinct identifier per kind, each with its own prefix", () => {
    const expectedPrefix: Record<keyof typeof FACTORIES, string> = {
      model: "mdl",
      provider: "prv",
      tool: "tol",
      policy: "pol",
      budget: "bud",
      reservation: "rsv",
      evaluation: "evl",
      plan: "pln",
    };
    const minted = new Set<string>();
    for (const kind of Object.keys(FACTORIES) as Array<keyof typeof FACTORIES>) {
      const id = FACTORIES[kind]();
      expect(id.startsWith(`${expectedPrefix[kind]}_`), kind).toBe(true);
      expect(parseIdentifier(kind, id)).toBe(id);
      minted.add(id);
    }
    expect(minted.size).toBe(Object.keys(FACTORIES).length);
  });

  it("never mints the same identifier twice", () => {
    const ids = new Set(Array.from({ length: 500 }, () => createModelId()));
    expect(ids.size).toBe(500);
  });

  it("rejects an identifier parsed under the wrong kind", () => {
    const modelId = createModelId();
    expect(() => parseIdentifier("provider", modelId)).toThrow();
  });
});

describe("createAiCoreIdentity", () => {
  it("carries the full correlation triple and freezes it", () => {
    const executionId = createExecutionId();
    const correlationId = createCorrelationId();
    const identity = createAiCoreIdentity(executionId, correlationId);
    expect(identity).toEqual({
      executionId,
      correlationId,
      causationId: null,
      traceId: null,
      parentSpanId: null,
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("records causation when the execution was caused by another message", () => {
    // Causation names the immediate cause, which is always a command or an event —
    // never another execution, so the role conversion is explicit here.
    const causationId = asCausationId(createCommandId());
    const identity = createAiCoreIdentity(createExecutionId(), createCorrelationId(), causationId);
    expect(identity.causationId).toBe(causationId);
  });
});
