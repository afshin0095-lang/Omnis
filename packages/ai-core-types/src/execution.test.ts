import { describe, expect, it } from "vitest";
import { createExecutionId, createPlanId } from "@omnis/types";
import {
  EXECUTION_PRIORITY_RANK,
  findPlanCycle,
  initialExecutionMetadata,
  isPreExecutionStatus,
  isStreamingMode,
  isTerminalExecutionStatus,
  MAX_PLAN_STEPS,
  MAX_STEP_DEPENDENCIES,
  planStepIds,
  topologicalStepOrder,
  validateExecutionPlan,
  type ExecutionPlan,
  type ExecutionStep,
} from "./index.js";

function step(
  id: string,
  dependsOn: readonly string[] = [],
  overrides: Partial<ExecutionStep> = {},
): ExecutionStep {
  return {
    id,
    name: id,
    kind: "model",
    dependsOn,
    timeoutMs: null,
    maxAttempts: 1,
    optional: false,
    input: {},
    modelId: null,
    providerId: null,
    toolId: null,
    metadata: {},
    ...overrides,
  };
}

function plan(steps: readonly ExecutionStep[]): ExecutionPlan {
  return {
    id: createPlanId(),
    executionId: createExecutionId(),
    steps,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("execution status vocabulary", () => {
  it("treats the four outcomes as terminal", () => {
    for (const status of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isTerminalExecutionStatus(status), status).toBe(true);
    }
    for (const status of [
      "created",
      "validated",
      "authorized",
      "reserved",
      "planned",
      "running",
      "waiting",
    ] as const) {
      expect(isTerminalExecutionStatus(status), status).toBe(false);
    }
  });

  it("places every governance state before running", () => {
    // Reaching `running` is the proof that policy and budget already approved.
    for (const status of ["created", "validated", "authorized", "reserved", "planned"] as const) {
      expect(isPreExecutionStatus(status), status).toBe(true);
    }
    expect(isPreExecutionStatus("running")).toBe(false);
    expect(isPreExecutionStatus("waiting")).toBe(false);
  });

  it("treats interactive and streaming modes as incremental", () => {
    expect(isStreamingMode("streaming")).toBe(true);
    expect(isStreamingMode("interactive")).toBe(true);
    expect(isStreamingMode("batch")).toBe(false);
    expect(isStreamingMode("background")).toBe(false);
  });

  it("orders priorities numerically", () => {
    expect(EXECUTION_PRIORITY_RANK.low).toBeLessThan(EXECUTION_PRIORITY_RANK.normal);
    expect(EXECUTION_PRIORITY_RANK.normal).toBeLessThan(EXECUTION_PRIORITY_RANK.high);
    expect(EXECUTION_PRIORITY_RANK.high).toBeLessThan(EXECUTION_PRIORITY_RANK.critical);
  });
});

describe("initialExecutionMetadata", () => {
  it("starts with no timing, no governance outcome and a frozen tag bag", () => {
    const metadata = initialExecutionMetadata("2026-01-01T00:00:30.000Z");
    expect(metadata).toEqual({
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      deadlineAt: "2026-01-01T00:00:30.000Z",
      attemptCount: 0,
      policyOutcome: null,
      policyId: null,
      budgetStatus: null,
      budgetId: null,
      tags: {},
    });
    expect(Object.isFrozen(metadata)).toBe(true);
  });
});

describe("validateExecutionPlan", () => {
  it("accepts a well-formed diamond plan", () => {
    const issues = validateExecutionPlan(
      plan([step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])]),
    );
    expect(issues).toEqual([]);
  });

  it("reports duplicate and empty step identifiers", () => {
    const issues = validateExecutionPlan(plan([step("a"), step("a"), step("")]));
    expect(issues.map((issue) => issue.code)).toEqual(["duplicate_step_id", "empty_step_id"]);
  });

  it("reports an unknown dependency and a self dependency", () => {
    const issues = validateExecutionPlan(plan([step("a", ["missing"]), step("b", ["b"])]));
    // A self dependency is reported twice, and correctly so: it is both a malformed
    // edge and a cycle. Reporting only the cycle would hide which step caused it.
    expect(issues.map((issue) => issue.code)).toEqual([
      "unknown_dependency",
      "self_dependency",
      "cycle",
    ]);
    expect(issues[0]?.stepId).toBe("a");
  });

  it("reports a cycle even when every step is individually well-formed", () => {
    const issues = validateExecutionPlan(
      plan([step("a", ["c"]), step("b", ["a"]), step("c", ["b"])]),
    );
    expect(issues.map((issue) => issue.code)).toEqual(["cycle"]);
    expect(issues[0]?.message).toContain("->");
  });

  it("enforces the step and dependency limits", () => {
    const tooManySteps = plan(
      Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => step(`s${String(index)}`)),
    );
    expect(validateExecutionPlan(tooManySteps).map((issue) => issue.code)).toContain(
      "too_many_steps",
    );

    const roots = Array.from({ length: MAX_STEP_DEPENDENCIES + 1 }, (_, index) =>
      step(`r${String(index)}`),
    );
    const tooManyDependencies = plan([
      ...roots,
      step(
        "leaf",
        roots.map((root) => root.id),
      ),
    ]);
    expect(validateExecutionPlan(tooManyDependencies).map((issue) => issue.code)).toContain(
      "too_many_dependencies",
    );
  });

  it("names the cycle path", () => {
    const cycle = findPlanCycle([step("a", ["b"]), step("b", ["a"])]);
    expect(cycle).not.toBeNull();
    expect(cycle?.length).toBeGreaterThanOrEqual(2);
    expect(findPlanCycle([step("a"), step("b", ["a"])])).toBeNull();
  });
});

describe("topologicalStepOrder", () => {
  it("runs dependencies before dependents", () => {
    const ordered = topologicalStepOrder(
      plan([step("d", ["b", "c"]), step("b", ["a"]), step("c", ["a"]), step("a")]),
    );
    const positions = new Map(ordered.map((entry, index) => [entry.id, index]));
    expect(positions.get("a")).toBeLessThan(positions.get("b") as number);
    expect(positions.get("a")).toBeLessThan(positions.get("c") as number);
    expect(positions.get("b")).toBeLessThan(positions.get("d") as number);
    expect(positions.get("c")).toBeLessThan(positions.get("d") as number);
  });

  it("breaks ties lexicographically so two runs produce the same order", () => {
    const steps = [step("zeta"), step("alpha"), step("mid"), step("beta", ["alpha"])];
    const first = topologicalStepOrder(plan(steps)).map((entry) => entry.id);
    const second = topologicalStepOrder(plan([...steps].reverse())).map((entry) => entry.id);
    expect(first).toEqual(["alpha", "beta", "mid", "zeta"]);
    expect(second).toEqual(first);
  });

  it("refuses to order an invalid plan", () => {
    // Ordering a cyclic plan would silently drop steps, and the execution would report
    // success for work it never attempted.
    expect(() => topologicalStepOrder(plan([step("a", ["b"]), step("b", ["a"])])).length).toThrow();
  });

  it("returns a frozen order", () => {
    const ordered = topologicalStepOrder(plan([step("a")]));
    expect(Object.isFrozen(ordered)).toBe(true);
  });
});

describe("planStepIds", () => {
  it("lists identifiers in declared order", () => {
    expect(planStepIds(plan([step("a"), step("b"), step("c")]))).toEqual(["a", "b", "c"]);
  });
});
