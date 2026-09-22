import { describe, expect, it } from "vitest";
import { createExecutionId, createPlanId } from "@omnis/types";
import { MAX_RETRY_ATTEMPTS } from "@omnis/ai-core-types";
import type { ExecutionRecord } from "@omnis/ai-core-types";
import { ExecutionScope } from "@omnis/execution-context";
import { ConflictError, NotFoundError } from "@omnis/errors";
import { InMemoryExecutionKernel } from "./ExecutionKernel.js";
import { collectingHooks } from "./ExecutionHooks.js";
import { executionPlan, executionStep } from "./plans.js";
import { stepExecutor, succeededOutcome } from "./StepExecutor.js";
import type { StepEnvironment, StepExecutor } from "./StepExecutor.js";
import {
  AT,
  AT_MS,
  cancellableExecutor,
  executionRequest,
  flakyExecutor,
  okExecutor,
  slowExecutor,
  throwingExecutor,
} from "./testSupport.js";

/** A clock a test moves by hand, so a deadline can be crossed without waiting for one. */
function manualClock(start = AT_MS) {
  let now = start;
  return {
    clock: (): number => now,
    advance(ms: number): void {
      now += ms;
    },
  };
}

/** A kernel with one executor, on the fixed clock unless a test says otherwise. */
function runKernel(
  executors: readonly StepExecutor[],
  clock: () => number = () => AT_MS,
  extra: ConstructorParameters<typeof InMemoryExecutionKernel>[0] = {},
) {
  return new InMemoryExecutionKernel({ clock, executors, ...extra });
}

/** The statuses a record passed through, with consecutive repeats collapsed. */
function statusTrail(record: ExecutionRecord): readonly string[] {
  const trail: string[] = [];
  for (const entry of record.timeline) {
    if (trail[trail.length - 1] !== entry.status) {
      trail.push(entry.status);
    }
  }
  return trail;
}

/** Every timeline note. */
function notesOf(record: ExecutionRecord): readonly string[] {
  return record.timeline.map((entry) => entry.note ?? "");
}

/** The failure a record ended with, or null. */
function failureOf(record: ExecutionRecord) {
  return record.result !== null && record.result.status !== "succeeded"
    ? record.result.failure
    : null;
}

/** Waits for real time to pass, for the suites that measure a delay. */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("plans and dependencies", () => {
  it("runs steps in dependency order, whatever order the plan declares them in", async () => {
    const order: string[] = [];
    const executor = stepExecutor("model", (step) => {
      order.push(step.id);
      return succeededOutcome(step.id);
    });
    const kernel = runKernel([executor]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        {
          executionId: request.id,
          steps: [
            { id: "join", dependsOn: ["left", "right"] },
            { id: "left", dependsOn: ["top"] },
            { id: "top" },
            { id: "right", dependsOn: ["top"] },
          ],
          createdAt: AT,
        },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("succeeded");
    expect(order.indexOf("top")).toBe(0);
    expect(order.indexOf("join")).toBe(3);
    expect(record.attempts.map((row) => row.stepId)).toEqual(["top", "left", "right", "join"]);
  });

  it("keeps the plan it ran on the record", async () => {
    const kernel = runKernel([okExecutor()]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", kind: "model" }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(record.plan?.steps.map((step) => step.id)).toEqual(["only"]);
    expect(record.plan?.executionId).toBe(request.id);
  });

  it("succeeds with no output when the plan has no steps", async () => {
    const kernel = runKernel([okExecutor()]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan({ executionId: request.id, steps: [], createdAt: AT }, () => AT_MS),
    });
    expect(record.status).toBe("succeeded");
    expect(record.attempts).toEqual([]);
    expect(
      record.result !== null && record.result.status === "succeeded"
        ? record.result.output
        : "unset",
    ).toBeNull();
    expect(notesOf(record).at(-1)).toBe("all 0 step(s) succeeded");
  });

  it("refuses a plan with a dependency cycle before running anything", async () => {
    const kernel = runKernel([okExecutor()]);
    const request = executionRequest();
    // Assembled by hand: `executionPlan` would have refused to build it.
    const cyclic = Object.freeze({
      id: createPlanId(),
      executionId: request.id,
      steps: Object.freeze([
        executionStep({ id: "a", dependsOn: ["b"] }),
        executionStep({ id: "b", dependsOn: ["a"] }),
      ]),
      createdAt: AT,
    });
    const record = await kernel.execute(request, { plan: cyclic });

    expect(record.status).toBe("failed");
    expect(record.attempts).toEqual([]);
    expect(record.plan).toBeNull();
    expect(failureOf(record)?.code).toBe("validation_failed");
    expect(notesOf(record).some((note) => note.startsWith("plan rejected"))).toBe(true);
    expect(notesOf(record).some((note) => note.includes("cycle"))).toBe(true);
  });

  it("uses the kernel's planner, and falls back to the one-step plan when it declines", async () => {
    const request = executionRequest();
    const planned = runKernel([okExecutor()], () => AT_MS, {
      planFor: (incoming) =>
        executionPlan(
          {
            executionId: incoming.id,
            steps: [{ id: "planned-a" }, { id: "planned-b" }],
            createdAt: AT,
          },
          () => AT_MS,
        ),
    });
    const fromPlanner = await planned.execute(request);
    expect(fromPlanner.plan?.steps.map((step) => step.id)).toEqual(["planned-a", "planned-b"]);

    const declining = runKernel([okExecutor()], () => AT_MS, { planFor: () => null });
    const fallback = await declining.execute(executionRequest());
    expect(fallback.plan?.steps.map((step) => step.id)).toEqual(["model-step"]);
  });

  it("lets a run's plan win over the kernel's planner", async () => {
    const request = executionRequest();
    const kernel = runKernel([okExecutor()], () => AT_MS, {
      planFor: (incoming) =>
        executionPlan(
          { executionId: incoming.id, steps: [{ id: "from-planner" }], createdAt: AT },
          () => AT_MS,
        ),
    });
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "from-run" }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(record.plan?.steps.map((step) => step.id)).toEqual(["from-run"]);
  });

  it("fails the run when a required step has no executor, and says which kind was missing", async () => {
    const kernel = runKernel([stepExecutor("tool", () => succeededOutcome("tool work"))]);
    const record = await kernel.execute(executionRequest({ kind: "model" }));
    expect(record.status).toBe("failed");
    expect(record.attempts[0]?.status).toBe("failed");
    expect(failureOf(record)?.class).toBe("validation");
    expect(failureOf(record)?.message).toMatch(/no step executor is registered for kind "model"/);
  });

  it("skips an optional step that has no executor and still succeeds", async () => {
    const kernel = runKernel([stepExecutor("model", () => succeededOutcome("model work"))]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        {
          executionId: request.id,
          steps: [{ id: "first" }, { id: "second", kind: "tool", optional: true }],
          createdAt: AT,
        },
        () => AT_MS,
      ),
    });
    expect(record.status).toBe("succeeded");
    expect(record.attempts.map((row) => [row.stepId, row.status])).toEqual([
      ["first", "succeeded"],
      ["second", "failed"],
    ]);
    expect(notesOf(record).some((note) => note.includes('optional step "second" failed'))).toBe(
      true,
    );
  });

  it("stops at a required step that failed, and skips what depended on it", async () => {
    const failing = stepExecutor("model", (step) =>
      step.id === "b"
        ? { ...succeededOutcome(), status: "failed" as const }
        : succeededOutcome(step.id),
    );
    const kernel = runKernel([failing]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        {
          executionId: request.id,
          steps: [{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["b"] }],
          createdAt: AT,
        },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("failed");
    expect(record.attempts.map((row) => row.stepId)).toEqual(["a", "b"]);
    expect(failureOf(record)?.message).toMatch(/step "b" failed/);
  });

  it("stops the run at a required step that failed, and never reaches what depended on it", async () => {
    const failing = stepExecutor("model", (step) =>
      step.id === "a"
        ? { ...succeededOutcome(), status: "failed" as const }
        : succeededOutcome(step.id),
    );
    const kernel = runKernel([failing]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        {
          executionId: request.id,
          steps: [{ id: "a" }, { id: "b", dependsOn: ["a"] }],
          createdAt: AT,
        },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("failed");
    // A required failure ends the run: there is no attempt row for a step that was never reached.
    expect(record.attempts.map((row) => row.stepId)).toEqual(["a"]);
    expect(failureOf(record)?.message).toMatch(/step "a" failed/);
    expect(record.result?.metadata).toMatchObject({
      steps: 2,
      attempts: 1,
      stepStatuses: { a: "failed" },
    });
  });

  it("skips an optional dependent step and still succeeds", async () => {
    const failing = stepExecutor("model", (step) =>
      step.id === "a"
        ? { ...succeededOutcome(), status: "failed" as const }
        : succeededOutcome(step.id),
    );
    const kernel = runKernel([failing]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        {
          executionId: request.id,
          steps: [
            { id: "a", optional: true },
            { id: "b", dependsOn: ["a"], optional: true },
            { id: "c" },
          ],
          createdAt: AT,
        },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("succeeded");
    expect(record.attempts.map((row) => [row.stepId, row.status])).toEqual([
      ["a", "failed"],
      ["b", "skipped"],
      ["c", "succeeded"],
    ]);
    expect(notesOf(record).some((note) => note.startsWith("optional step skipped"))).toBe(true);
  });
});

describe("retries", () => {
  it("retries a retryable failure and records both attempts", async () => {
    const flaky = flakyExecutor(1);
    const hooks = collectingHooks();
    const request = executionRequest();
    const kernel = runKernel([flaky], () => AT_MS, { hooks });
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 3 }], createdAt: AT },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("succeeded");
    expect(flaky.attempts).toBe(2);
    expect(record.attempts.map((row) => [row.attempt, row.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    expect(record.governance.attemptCount).toBe(2);
    expect(hooks.retries).toHaveLength(1);
    expect(hooks.retries[0]).toMatchObject({
      stepId: "only",
      attempt: 1,
      nextAttempt: 2,
      delayMs: 0,
      failureCode: "provider_failure",
      failureClass: "retryable",
    });
  });

  it("does not retry a failure classified as non-retryable", async () => {
    const failing = stepExecutor("model", () => ({
      ...succeededOutcome(),
      status: "failed" as const,
      failure: failureFixture({ retryable: false, class: "non_retryable" }),
    }));
    const kernel = runKernel([failing]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 3 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(record.attempts).toHaveLength(1);
    expect(record.status).toBe("failed");
  });

  it("stops at the step's attempt limit", async () => {
    const flaky = flakyExecutor(99);
    const kernel = runKernel([flaky]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 2 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(flaky.attempts).toBe(2);
    expect(record.attempts).toHaveLength(2);
    expect(record.status).toBe("failed");
  });

  it("never spends more attempts than the published maximum, however the plan was written", async () => {
    const flaky = flakyExecutor(99);
    const kernel = runKernel([flaky]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 50 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(record.attempts).toHaveLength(MAX_RETRY_ATTEMPTS);
    expect(flaky.attempts).toBe(MAX_RETRY_ATTEMPTS);
  });

  it("waits the delay the failure asked for before the next attempt", async () => {
    const flaky = flakyExecutor(1, { delayMs: 40 });
    const kernel = runKernel([flaky]);
    const request = executionRequest();
    const started = Date.now();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 2 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    const elapsed = Date.now() - started;
    expect(record.status).toBe("succeeded");
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("clamps a retry delay to the kernel's maximum, so a hostile hint cannot stall a run", async () => {
    const flaky = flakyExecutor(1, { delayMs: 60_000 });
    const hooks = collectingHooks();
    const kernel = runKernel([flaky], () => AT_MS, { hooks, maxRetryDelayMs: 5 });
    const request = executionRequest();
    const started = Date.now();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 2 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(record.status).toBe("succeeded");
    expect(hooks.retries[0]?.delayMs).toBe(5);
  });

  it("ends the run cancelled when cancellation arrives during a retry wait", async () => {
    const flaky = flakyExecutor(9, { delayMs: 500 });
    const kernel = runKernel([flaky]);
    const request = executionRequest();
    const running = kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 3 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    await tick(20);
    await kernel.cancel(request.id, "operator stopped the run");
    const record = await running;

    expect(record.status).toBe("cancelled");
    expect(failureOf(record)?.class).toBe("cancelled");
    expect(notesOf(record).some((note) => note.startsWith("cancelled during the retry wait"))).toBe(
      true,
    );
  });

  it("ends the run timed out when the deadline passes during a retry wait", async () => {
    const time = manualClock();
    const flaky = flakyExecutor(9, { delayMs: 10 });
    const executor: StepExecutor = {
      kind: "model",
      execute: () => {
        time.advance(100);
        return flaky.execute(executionStep({ id: "only" }), environmentFixture());
      },
    };
    const kernel = runKernel([executor], time.clock);
    const request = executionRequest({ deadlineMs: 50 });
    const record = await kernel.execute(request, {
      // The one-step plan a request implies allows a single attempt, which would never retry.
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", maxAttempts: 3 }], createdAt: AT },
        () => time.clock(),
      ),
    });

    expect(record.status).toBe("timed_out");
    expect(failureOf(record)?.class).toBe("deadline_exceeded");
    expect(
      notesOf(record).some((note) => note.startsWith("deadline passed during the retry wait")),
    ).toBe(true);
  });
});

describe("timeouts and deadlines", () => {
  it("bounds a step by its own timeout and records the attempt as timed out", async () => {
    const kernel = runKernel([slowExecutor(300, "too late")]);
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", timeoutMs: 25 }], createdAt: AT },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("timed_out");
    expect(record.attempts[0]?.status).toBe("timed_out");
    expect(failureOf(record)?.class).toBe("deadline_exceeded");
    expect(failureOf(record)?.code).toBe("timeout");
    expect(failureOf(record)?.message).toMatch(/exceeded its 25ms timeout/);
  });

  it("applies the tightest of the step timeout, the policy limit and the execution deadline", async () => {
    const kernel = runKernel([slowExecutor(400, "too late")]);
    const request = executionRequest({ deadlineMs: 30 });
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "only", timeoutMs: 500 }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(record.status).toBe("timed_out");
    expect(failureOf(record)?.message).toMatch(/exceeded its 30ms timeout/);
  });

  it("applies the kernel's default deadline to a request that names none", async () => {
    const kernel = runKernel([slowExecutor(300)], () => AT_MS, { defaultDeadlineMs: 25 });
    const record = await kernel.execute(executionRequest());
    expect(record.status).toBe("timed_out");
    expect(record.governance.deadlineAt).toBe("2026-02-25T06:13:20.025Z");
  });

  it("stops before the next step once the execution deadline has passed", async () => {
    const time = manualClock();
    const executor = stepExecutor("model", (step) => {
      time.advance(200);
      return succeededOutcome(step.id);
    });
    const kernel = runKernel([executor], time.clock);
    const request = executionRequest({ deadlineMs: 100 });
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "a" }, { id: "b" }], createdAt: AT },
        () => AT_MS,
      ),
    });

    expect(record.status).toBe("timed_out");
    expect(record.attempts.map((row) => [row.stepId, row.status])).toEqual([
      ["a", "succeeded"],
      ["b", "timed_out"],
    ]);
    expect(notesOf(record)).toContain("deadline passed before the step ran");
    expect(failureOf(record)?.message).toMatch(/execution deadline of 100ms exceeded/);
  });

  it("records what an executor threw, classified, instead of letting it escape", async () => {
    const kernel = runKernel([throwingExecutor(new Error("executor exploded"))]);
    const record = await kernel.execute(executionRequest());
    expect(record.status).toBe("failed");
    expect(record.attempts[0]?.status).toBe("failed");
    expect(record.attempts[0]?.failure?.message).toBe("executor exploded");
    expect(record.attempts[0]?.failure?.class).toBe("unknown");
    expect(failureOf(record)?.message).toBe("executor exploded");
  });

  it("records a non-error throw as a failure rather than as an unhandled value", async () => {
    const kernel = runKernel([throwingExecutor("the provider hung up")]);
    const record = await kernel.execute(executionRequest());
    expect(record.attempts[0]?.failure?.message).toBe("the provider hung up");
  });

  it("disposes the step's child scope after the attempt, so nothing is left running", async () => {
    const seen: StepEnvironment[] = [];
    const executor = stepExecutor("model", (_step, environment) => {
      seen.push(environment);
      return succeededOutcome("done");
    });
    const kernel = runKernel([executor]);
    await kernel.execute(executionRequest());
    const environment = seen[0];
    if (environment === undefined) {
      throw new Error("expected the executor to have been called");
    }
    // The step scope is disposed when the attempt ends, which cancels whatever the executor left.
    expect(environment.context.cancellation.cancelled).toBe(true);
    expect(environment.isCancelled()).toBe(true);
  });
});

describe("cancellation", () => {
  it("ends a live run when it is cancelled, and the executor sees why", async () => {
    const executor = cancellableExecutor(2);
    const kernel = runKernel([executor]);
    const request = executionRequest();
    const running = kernel.execute(request);
    await tick(20);
    await kernel.cancel(request.id, "user pressed stop");
    const record = await running;

    expect(record.status).toBe("cancelled");
    expect(record.result?.status).toBe("cancelled");
    expect(failureOf(record)?.class).toBe("cancelled");
    expect(failureOf(record)?.message).toMatch(/user pressed stop/);
    expect(record.attempts.at(-1)?.status).toBe("cancelled");
    expect(executor.pollCount()).toBeGreaterThan(0);
  });

  it("returns the live record from cancel, and the terminal one from the run", async () => {
    const kernel = runKernel([cancellableExecutor(2)]);
    const request = executionRequest();
    const running = kernel.execute(request);
    await tick(20);
    const immediate = await kernel.cancel(request.id, "stop");
    expect(immediate.status).toBe("running");
    const final = await running;
    expect(final.status).toBe("cancelled");
    expect(kernel.requireExecution(request.id).status).toBe("cancelled");
  });

  it("marks a stored execution cancelled without running it", async () => {
    const kernel = runKernel([okExecutor()]);
    const request = executionRequest();
    kernel.create(request);
    const record = await kernel.cancel(request.id, "changed our mind");

    expect(record.status).toBe("cancelled");
    expect(record.attempts).toEqual([]);
    expect(record.result?.metadata).toMatchObject({ cancelledWithoutRun: true });
    expect(record.governance.finishedAt).toBe(AT);
    expect(statusTrail(record)).toEqual(["created", "cancelled"]);
  });

  it("refuses to cancel a finished execution, and to cancel one it never saw", async () => {
    const kernel = runKernel([okExecutor()]);
    const finished = await kernel.execute(executionRequest());
    await expect(kernel.cancel(finished.request.id, "too late")).rejects.toThrow(ConflictError);
    await expect(kernel.cancel(finished.request.id, "too late")).rejects.toThrow(
      /already succeeded/,
    );
    await expect(kernel.cancel(createExecutionId(), "nobody")).rejects.toThrow(NotFoundError);
  });

  it("ends a run before the first gate when the caller's scope is already cancelled", async () => {
    const kernel = runKernel([okExecutor("never reached")]);
    const request = executionRequest();
    const scope = ExecutionScope.createRoot({ executionId: request.id }, { clock: () => AT_MS });
    scope.cancel("cancelled before it started");
    const record = await kernel.execute(request, { scope });

    expect(record.status).toBe("cancelled");
    expect(record.attempts).toEqual([]);
    expect(statusTrail(record)).toEqual(["created", "validated", "cancelled"]);
    expect(notesOf(record)).toContain("cancelled before the first gate");
    scope.dispose();
  });

  it("ends a run before the first gate when the caller's scope has already expired", async () => {
    const time = manualClock();
    const kernel = runKernel([okExecutor("never reached")], time.clock);
    const request = executionRequest();
    const scope = ExecutionScope.createRoot(
      { executionId: request.id, deadlineMs: 10 },
      { clock: time.clock },
    );
    time.advance(50);
    const record = await kernel.execute(request, { scope });

    expect(record.status).toBe("timed_out");
    expect(record.attempts).toEqual([]);
    expect(failureOf(record)?.class).toBe("deadline_exceeded");
    expect(notesOf(record)).toContain("deadline passed before the first gate");
    scope.dispose();
  });

  it("cancels live runs on dispose", async () => {
    const kernel = runKernel([cancellableExecutor(2)]);
    const request = executionRequest();
    const running = kernel.execute(request);
    await tick(20);
    kernel.dispose();
    const record = await running;
    expect(record.status).toBe("cancelled");
  });
});

/** A failure with the fields an executor would report, for the suites that need one by hand. */
function failureFixture(
  overrides: Partial<{ class: "retryable" | "non_retryable"; retryable: boolean }> = {},
) {
  return {
    class: overrides.class ?? "retryable",
    code: "provider_failure" as const,
    message: "upstream refused",
    retryable: overrides.retryable ?? true,
    retryAfterMs: null,
    attempt: 1,
    stepId: null,
    executionId: null,
    modelId: null,
    providerId: null,
    toolId: null,
    details: {},
    occurredAt: AT,
  };
}

/** A minimal environment, for the suite that drives an executor by hand. */
function environmentFixture(): StepEnvironment {
  const scope = ExecutionScope.createRoot(
    { executionId: createExecutionId() },
    { clock: () => AT_MS },
  );
  return {
    executionId: scope.context.executionId,
    approval: null,
    stepId: "only",
    correlationId: scope.context.correlationId,
    traceId: null,
    tenantId: null,
    parentSpanId: null,
    attempt: 1,
    maxAttempts: 3,
    startedAt: AT,
    deadlineAt: null,
    context: scope.context,
    remainingMs: () => null,
    isCancelled: () => false,
    cancellationReason: () => null,
  };
}
