import { describe, expect, it } from "vitest";
import {
  createAgentId,
  createExecutionId,
  createModelId,
  createPlanId,
  createProviderId,
  createToolId,
} from "@omnis/types";
import {
  MAX_PLAN_STEPS,
  MAX_RETRY_ATTEMPTS,
  MAX_STEP_DEPENDENCIES,
  modelByCapability,
  modelById,
  modelBySlug,
  toolById,
  toolByName,
} from "@omnis/ai-core-types";
import type { AiCoreMetadata, ExecutionPlan, ExecutionStep } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import {
  assertValidPlan,
  describeStepName,
  executionPlan,
  executionStep,
  planIssues,
  runOrder,
  singleStepPlan,
  stepInputFromRequest,
} from "./plans.js";
import type { ExecutionStepInput } from "./plans.js";
import { planRejected } from "./errors.js";
import { AT, AT_MS, executionRequest } from "./testSupport.js";

/** A plan built on the fixed clock, which refuses anything unsound. */
function plan(
  steps: readonly ExecutionStepInput[],
  overrides: Partial<{
    executionId: ReturnType<typeof createExecutionId>;
    id: ReturnType<typeof createPlanId>;
  }> = {},
): ExecutionPlan {
  return executionPlan(
    { executionId: createExecutionId(), steps, createdAt: AT, ...overrides },
    () => AT_MS,
  );
}

/**
 * A plan assembled without validation.
 *
 * `executionPlan` refuses to build an unsound plan — that is its job — but the validator itself
 * has to be exercised against unsound plans. These suites assemble them directly; nothing inside
 * the package can produce one by accident.
 */
function unsafePlan(steps: readonly ExecutionStepInput[]): ExecutionPlan {
  return Object.freeze({
    id: createPlanId(),
    executionId: createExecutionId(),
    steps: Object.freeze(steps.map((step) => executionStep(step))),
    createdAt: AT,
  });
}

/** The issue codes a plan carries, in the order the validator reports them. */
function codesOf(built: ExecutionPlan): readonly string[] {
  return planIssues(built).map((issue) => issue.code);
}

describe("executionStep", () => {
  it("defaults every field to the least-surprising value", () => {
    const step = executionStep();
    expect(step).toMatchObject({
      id: "step-1",
      name: "step-1",
      kind: "model",
      dependsOn: [],
      timeoutMs: null,
      maxAttempts: 1,
      optional: false,
      input: {},
      modelId: null,
      providerId: null,
      toolId: null,
      metadata: {},
    });
    expect(Object.isFrozen(step)).toBe(true);
    expect(Object.isFrozen(step.dependsOn)).toBe(true);
    expect(Object.isFrozen(step.input)).toBe(true);
    expect(Object.isFrozen(step.metadata)).toBe(true);
  });

  it("keeps the fields a planner supplied", () => {
    const modelId = createModelId();
    const toolId = createToolId();
    const step = executionStep({
      id: "fetch",
      name: "fetch the report",
      kind: "tool",
      dependsOn: ["prepare"],
      timeoutMs: 250,
      maxAttempts: 2,
      optional: true,
      input: { url: "https://example.invalid/report" },
      modelId,
      toolId,
      metadata: { source: "test" },
    });
    expect(step).toMatchObject({
      id: "fetch",
      name: "fetch the report",
      kind: "tool",
      dependsOn: ["prepare"],
      timeoutMs: 250,
      maxAttempts: 2,
      optional: true,
    });
    expect(step.input).toEqual({ url: "https://example.invalid/report" });
    expect(step.modelId).toBe(modelId);
    expect(step.toolId).toBe(toolId);
    expect(step.metadata).toEqual({ source: "test" });
  });

  it("clamps attempts to one at least and to the published maximum at most", () => {
    expect(executionStep({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(executionStep({ maxAttempts: -5 }).maxAttempts).toBe(1);
    expect(executionStep({ maxAttempts: 2 }).maxAttempts).toBe(2);
    expect(executionStep({ maxAttempts: MAX_RETRY_ATTEMPTS }).maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
    // An unbounded retry count in a plan is an unbounded cost.
    expect(executionStep({ maxAttempts: 999 }).maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
  });

  it("rejects a non-integer attempt count rather than rounding it silently", () => {
    expect(() => executionStep({ maxAttempts: 1.5 })).toThrow(ValidationError);
    expect(() => executionStep({ maxAttempts: Number.NaN })).toThrow(/non-integer maxAttempts/);
  });

  it("rejects an empty step identifier and a non-positive timeout", () => {
    expect(() => executionStep({ id: "" })).toThrow(/must not be empty/);
    expect(() => executionStep({ timeoutMs: 0 })).toThrow(/non-positive timeoutMs/);
    expect(() => executionStep({ timeoutMs: -1 })).toThrow(ValidationError);
    expect(() => executionStep({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow(ValidationError);
  });

  it("rejects more dependencies than the published maximum", () => {
    const dependsOn = Array.from(
      { length: MAX_STEP_DEPENDENCIES + 1 },
      (_unused, index) => `step-${String(index)}`,
    );
    expect(() => executionStep({ dependsOn })).toThrow(
      new RegExp(`maximum is ${String(MAX_STEP_DEPENDENCIES)}`),
    );
  });

  it("rejects input and metadata that could not be serialized", () => {
    // A step's input ends up in an audit row; a function or a cycle would serialize into something
    // other than what the planner meant, in a row nobody could re-run.
    expect(() => executionStep({ input: { handler: () => "no" } })).toThrow(ValidationError);
    const cyclic: Record<string, unknown> = {};
    cyclic["loop"] = cyclic;
    // The cast is the point of the test: a caller that lies about JSON-safety must still be caught.
    expect(() => executionStep({ metadata: cyclic as unknown as AiCoreMetadata })).toThrow(
      ValidationError,
    );
    expect(() => executionStep({ metadata: { depth: { allowed: true } } })).not.toThrow();
  });
});

describe("executionPlan", () => {
  it("builds a frozen plan from step inputs", () => {
    const built = plan([{ id: "one" }, { id: "two", dependsOn: ["one"] }]);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.steps)).toBe(true);
    expect(built.steps.map((step) => step.id)).toEqual(["one", "two"]);
    expect(built.createdAt).toBe(AT);
  });

  it("passes an already-built step through unchanged", () => {
    const step: ExecutionStep = executionStep({ id: "prepared", kind: "tool" });
    const built = plan([step]);
    expect(built.steps[0]).toBe(step);
    expect(built.steps[0]?.kind).toBe("tool");
  });

  it("mints an identifier and timestamp when the planner supplies neither", () => {
    const built = executionPlan({ executionId: createExecutionId(), steps: [] }, () => AT_MS);
    expect(built.id).toMatch(/^pln_/);
    expect(built.createdAt).toBe(AT);
  });

  it("reports the execution it belongs to", () => {
    const executionId = createExecutionId();
    expect(plan([], { executionId }).executionId).toBe(executionId);
  });

  it("refuses to build a plan the validator would reject", () => {
    expect(() => plan([{ id: "a", dependsOn: ["missing"] }])).toThrow(ValidationError);
    expect(() => plan([{ id: "a" }, { id: "a" }])).toThrow(/duplicate step identifier/);
  });
});

describe("plan validation", () => {
  it("accepts an empty plan", () => {
    const empty = unsafePlan([]);
    expect(planIssues(empty)).toEqual([]);
    expect(() => assertValidPlan(empty)).not.toThrow();
    expect(runOrder(empty)).toEqual([]);
  });

  it("accepts a chain of dependent steps", () => {
    const chained = unsafePlan([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    expect(planIssues(chained)).toEqual([]);
    expect(runOrder(chained).map((step) => step.id)).toEqual(["a", "b", "c"]);
  });

  it("reports duplicate identifiers, naming the step", () => {
    const duplicate = unsafePlan([{ id: "a" }, { id: "a" }]);
    expect(codesOf(duplicate)).toContain("duplicate_step_id");
    expect(planIssues(duplicate).find((issue) => issue.code === "duplicate_step_id")?.stepId).toBe(
      "a",
    );
    expect(() => assertValidPlan(duplicate)).toThrow(ValidationError);
  });

  it("reports an unknown dependency", () => {
    const issues = planIssues(unsafePlan([{ id: "a", dependsOn: ["missing"] }]));
    expect(issues.map((issue) => issue.code)).toEqual(["unknown_dependency"]);
    expect(issues[0]?.stepId).toBe("a");
    expect(issues[0]?.message).toMatch(/unknown step "missing"/);
  });

  it("reports a self-dependency rather than calling it a cycle", () => {
    expect(codesOf(unsafePlan([{ id: "a", dependsOn: ["a"] }]))).toContain("self_dependency");
  });

  it("reports a cycle between two individually well-formed steps", () => {
    const issues = planIssues(
      unsafePlan([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    );
    const cycle = issues.find((issue) => issue.code === "cycle");
    expect(cycle).toBeDefined();
    expect(cycle?.message).toMatch(/cycle/);
    expect(cycle?.stepId).toBeNull();
  });

  it("reports too many steps", () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_unused, index) => ({
      id: `step-${String(index)}`,
    }));
    expect(codesOf(unsafePlan(steps))).toContain("too_many_steps");
  });

  it("reports every problem at once, so a planner does not fix them one round trip at a time", () => {
    const codes = codesOf(
      unsafePlan([{ id: "a", dependsOn: ["a"] }, { id: "a" }, { id: "c", dependsOn: ["gone"] }]),
    );
    expect(codes).toContain("self_dependency");
    expect(codes).toContain("duplicate_step_id");
    expect(codes).toContain("unknown_dependency");
  });

  it("throws a rejection that lists every issue", () => {
    const issues = planIssues(
      unsafePlan([
        { id: "a", dependsOn: ["missing"] },
        { id: "b", dependsOn: ["a", "missing"] },
      ]),
    );
    const error = planRejected(issues, createExecutionId());
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues).toHaveLength(issues.length);
    expect(error.issues[0]?.path).toBe("plan.steps.a");
    expect(error.message).toMatch(/unknown step "missing"/);
  });

  it("describes an empty issue list rather than inventing a problem", () => {
    expect(() => assertValidPlan(unsafePlan([{ id: "only" }]))).not.toThrow();
    expect(() => {
      throw planRejected([], null);
    }).toThrowError(/no issues/);
  });
});

describe("runOrder", () => {
  it("runs independent steps in identifier order, whatever order they were declared in", () => {
    const declared = unsafePlan([{ id: "zeta" }, { id: "alpha" }, { id: "mid" }]);
    expect(runOrder(declared).map((step) => step.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns the same order every time for the same plan", () => {
    const declared = unsafePlan([{ id: "c", dependsOn: ["a"] }, { id: "b" }, { id: "a" }]);
    const first = runOrder(declared).map((step) => step.id);
    const second = runOrder(declared).map((step) => step.id);
    expect(first).toEqual(second);
    expect(first).toEqual(["a", "b", "c"]);
  });

  it("puts a dependent step after every step it waits for", () => {
    const diamond = unsafePlan([
      { id: "top" },
      { id: "left", dependsOn: ["top"] },
      { id: "right", dependsOn: ["top"] },
      { id: "join", dependsOn: ["left", "right"] },
    ]);
    const order = runOrder(diamond).map((step) => step.id);
    expect(order).toHaveLength(4);
    expect(order.indexOf("join")).toBe(order.length - 1);
    expect(order.indexOf("left")).toBeGreaterThan(order.indexOf("top"));
    expect(order.indexOf("right")).toBeGreaterThan(order.indexOf("top"));
  });

  it("refuses to order an invalid plan", () => {
    const cyclic = unsafePlan([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]);
    expect(() => runOrder(cyclic)).toThrow(ValidationError);
  });
});

describe("singleStepPlan and stepInputFromRequest", () => {
  it("turns a model request into one step carrying the model identifier", () => {
    const modelId = createModelId();
    const request = executionRequest({ kind: "model", model: modelById(modelId), tool: null });
    const built = singleStepPlan(request, () => AT_MS);
    expect(built.steps).toHaveLength(1);
    expect(built.steps[0]).toMatchObject({
      id: "model-step",
      kind: "model",
      modelId,
      toolId: null,
      maxAttempts: 1,
      optional: false,
    });
    expect(built.steps[0]?.input).toEqual(request.input);
    expect(built.executionId).toBe(request.id);
  });

  it("carries a provider identifier when the request names a model by slug", () => {
    const providerId = createProviderId();
    const step = stepInputFromRequest(
      executionRequest({ kind: "model", model: modelBySlug("gpt-small", providerId) }),
    );
    expect(step.providerId).toBe(providerId);
    expect(step.modelId).toBeNull();
    expect(step.metadata?.["modelReference"]).toBe(`slug:gpt-small@${providerId}`);
  });

  it("records a capability reference verbatim, so an auditor sees what was asked for", () => {
    const step = stepInputFromRequest(
      executionRequest({ kind: "model", model: modelByCapability("structured_output") }),
    );
    expect(step.metadata?.["modelReference"]).toBe("capability:structured_output");
  });

  it("carries the tool identifier for a tool request", () => {
    const toolId = createToolId();
    const step = stepInputFromRequest(
      executionRequest({ kind: "tool", model: null, tool: toolById(toolId) }),
    );
    expect(step.toolId).toBe(toolId);
    expect(step.kind).toBe("tool");
    expect(step.metadata?.["toolReference"]).toBe(toolId);
  });

  it("copies the request deadline onto the step, so the executor sees the same bound", () => {
    expect(stepInputFromRequest(executionRequest({ deadlineMs: 5_000 })).timeoutMs).toBe(5_000);
    expect(stepInputFromRequest(executionRequest({ deadlineMs: null })).timeoutMs).toBeNull();
  });

  it("copies the request metadata onto the step", () => {
    const step = stepInputFromRequest(executionRequest({ metadata: { surface: "studio" } }));
    expect(step.metadata).toMatchObject({ surface: "studio" });
  });
});

describe("describeStepName", () => {
  it("prefers the model reference", () => {
    const modelId = createModelId();
    expect(describeStepName(executionRequest({ kind: "model", model: modelById(modelId) }))).toBe(
      `model:id:${modelId}`,
    );
  });

  it("falls back to the tool", () => {
    expect(
      describeStepName(
        executionRequest({ kind: "tool", model: null, tool: toolByName("read-file") }),
      ),
    ).toBe("tool:read-file");
  });

  it("falls back to the agent, then to the bare kind", () => {
    const agentId = createAgentId();
    expect(
      describeStepName(executionRequest({ kind: "agent", model: null, tool: null, agentId })),
    ).toBe(`agent:${agentId}`);
    expect(
      describeStepName(
        executionRequest({ kind: "evaluation", model: null, tool: null, agentId: null }),
      ),
    ).toBe("evaluation");
  });
});
