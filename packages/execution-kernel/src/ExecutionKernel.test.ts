import { describe, expect, it } from "vitest";
import {
  createEvaluationId,
  createExecutionId,
  createModelId,
  createSpanId,
  createTraceId,
} from "@omnis/types";
import { modelById } from "@omnis/ai-core-types";
import type {
  EvaluationInput,
  EvaluationResult,
  ExecutionRecord,
  ExecutionStatus,
} from "@omnis/ai-core-types";
import { ExecutionScope } from "@omnis/execution-context";
import { ConflictError, ContractError, NotFoundError, ValidationError } from "@omnis/errors";
import {
  DEFAULT_MAX_EXECUTIONS,
  InMemoryExecutionKernel,
  createExecutionKernel,
} from "./ExecutionKernel.js";
import { collectingHooks } from "./ExecutionHooks.js";
import type { ExecutionHooks } from "./ExecutionHooks.js";
import { executionPlan } from "./plans.js";
import { stepExecutor, succeededOutcome } from "./StepExecutor.js";
import type { StepExecutor } from "./StepExecutor.js";
import { AT, AT_MS, executionRequest, okExecutor, recordingTracer, usage } from "./testSupport.js";
import type { RecordedSpan } from "./testSupport.js";

/** A clock a test moves by hand, so durations are exact rather than approximate. */
function manualClock(start = AT_MS) {
  let now = start;
  return {
    clock: (): number => now,
    advance(ms: number): void {
      now += ms;
    },
  };
}

/** The statuses a record passed through, with consecutive repeats collapsed. */
function statusTrail(record: ExecutionRecord): readonly ExecutionStatus[] {
  const trail: ExecutionStatus[] = [];
  for (const entry of record.timeline) {
    if (trail[trail.length - 1] !== entry.status) {
      trail.push(entry.status);
    }
  }
  return trail;
}

/** The one span a run opened, or a failure the test states plainly. */
function onlySpan(spans: readonly RecordedSpan[]): RecordedSpan {
  const span = spans[0];
  if (span === undefined) {
    throw new Error("expected the kernel to open one span");
  }
  return span;
}

/** Every timeline note, for the suites that assert what the kernel said about itself. */
function notesOf(record: ExecutionRecord): readonly string[] {
  return record.timeline.map((entry) => entry.note ?? "");
}

describe("construction", () => {
  it("starts empty, with no executors and a published default capacity", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    expect(kernel.size).toBe(0);
    expect(kernel.listExecutions()).toEqual([]);
    expect(kernel.executorFor("model")).toBeNull();
    expect(DEFAULT_MAX_EXECUTIONS).toBeGreaterThan(0);
  });

  it("is reachable through the factory as well as the class", () => {
    expect(createExecutionKernel({ clock: () => AT_MS })).toBeInstanceOf(InMemoryExecutionKernel);
  });

  it("rejects a capacity that is not a positive integer", () => {
    expect(() => new InMemoryExecutionKernel({ maxExecutions: 0 })).toThrow(RangeError);
    expect(() => new InMemoryExecutionKernel({ maxExecutions: 1.5 })).toThrow(RangeError);
    expect(() => new InMemoryExecutionKernel({ maxExecutions: -1 })).toThrow(/positive integer/);
  });

  it("registers the executors it was given, and refuses a second one for the same kind", () => {
    const first = okExecutor();
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [first] });
    expect(kernel.executorFor("model")).toBe(first);
    expect(() => kernel.registerExecutor(okExecutor({ other: true }))).toThrow(ConflictError);
    expect(() => kernel.registerExecutor(okExecutor({ other: true }))).toThrow(
      /step-executor "model" is already registered/,
    );
    // Re-registering the same instance is not a routing change, so it is allowed.
    expect(() => kernel.registerExecutor(first)).not.toThrow();
  });

  it("refuses an executor that cannot execute", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const broken = { kind: "model" } as unknown as StepExecutor;
    expect(() => kernel.registerExecutor(broken)).toThrow(ValidationError);
    expect(() => kernel.registerExecutor(broken)).toThrow(/execute must be a function/);
  });

  it("unregisters an executor and says whether there was one", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    expect(kernel.unregisterExecutor("model")).toBe(true);
    expect(kernel.unregisterExecutor("model")).toBe(false);
    expect(kernel.executorFor("model")).toBeNull();
  });
});

describe("create and storage", () => {
  it("stores a created record that has run nothing", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const request = executionRequest();
    const record = kernel.create(request);

    expect(record.status).toBe("created");
    // The record holds the *validated* request: a parsed copy, not the caller's object, so a caller
    // that keeps mutating what it passed cannot rewrite what was authorized.
    expect(record.request).toEqual(request);
    expect(record.request).not.toBe(request);
    expect(record.plan).toBeNull();
    expect(record.attempts).toEqual([]);
    expect(record.result).toBeNull();
    expect(record.evaluation).toBeNull();
    expect(record.createdAt).toBe(AT);
    expect(record.updatedAt).toBe(AT);
    expect(record.timeline).toEqual([
      { at: AT, status: "created", note: "execution created", stepId: null },
    ]);
    expect(record.governance).toMatchObject({
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      attemptCount: 0,
      policyOutcome: null,
      budgetId: null,
      deadlineAt: null,
    });
    expect(kernel.size).toBe(1);
  });

  it("records the request deadline as an absolute timestamp", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const record = kernel.create(executionRequest({ deadlineMs: 2_000 }));
    expect(record.governance.deadlineAt).toBe("2026-02-25T06:13:22.000Z");
  });

  it("freezes the record and everything in it, so a reader cannot rewrite history", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const record = kernel.create(executionRequest());
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.timeline)).toBe(true);
    expect(Object.isFrozen(record.attempts)).toBe(true);
    expect(Object.isFrozen(record.governance)).toBe(true);
  });

  it("refuses a request that does not satisfy the published contract", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const invalid = { ...executionRequest(), kind: "magic" } as never;
    expect(() => kernel.create(invalid)).toThrow(ValidationError);
    expect(kernel.size).toBe(0);
  });

  it("refuses to create the same execution twice", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const request = executionRequest();
    kernel.create(request);
    expect(() => kernel.create(request)).toThrow(ConflictError);
    expect(kernel.size).toBe(1);
  });

  it("looks executions up, and says so when there is none", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const request = executionRequest();
    kernel.create(request);
    expect(kernel.getExecution(request.id)).not.toBeNull();
    expect(kernel.getExecution(createExecutionId())).toBeNull();
    expect(kernel.requireExecution(request.id).request.id).toBe(request.id);
    expect(() => kernel.requireExecution(createExecutionId())).toThrow(NotFoundError);
  });

  it("lists executions in creation order, as a frozen array", () => {
    const time = manualClock();
    const kernel = new InMemoryExecutionKernel({ clock: time.clock });
    const first = executionRequest();
    time.advance(1_000);
    const second = executionRequest();
    kernel.create(second);
    kernel.create(first);

    const listed = kernel.listExecutions();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.map((record) => record.request.id)).toEqual([first.id, second.id]);
  });

  it("stops accepting executions at its configured capacity", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, maxExecutions: 1 });
    kernel.create(executionRequest());
    expect(() => kernel.create(executionRequest())).toThrow(ConflictError);
    expect(() => kernel.create(executionRequest())).toThrow(/at most 1 execution records/);
    await expect(kernel.execute(executionRequest(), { executors: [okExecutor()] })).rejects.toThrow(
      /at most 1 execution records/,
    );
  });

  it("drops every record and executor on dispose", () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    kernel.create(executionRequest());
    kernel.dispose();
    expect(kernel.size).toBe(0);
    expect(kernel.executorFor("model")).toBeNull();
  });
});

describe("execute", () => {
  it("runs the whole lifecycle and returns the terminal record", async () => {
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor({ answer: 42 }, usage())],
    });
    const request = executionRequest();
    const record = await kernel.execute(request);

    expect(record.status).toBe("succeeded");
    expect(statusTrail(record)).toEqual([
      "created",
      "validated",
      "authorized",
      "planned",
      "running",
      "succeeded",
    ]);
    expect(record.result?.status).toBe("succeeded");
    expect(
      record.result !== null && record.result.status === "succeeded" ? record.result.output : null,
    ).toEqual({ answer: 42 });
    expect(record.governance).toMatchObject({
      startedAt: AT,
      finishedAt: AT,
      durationMs: 0,
      attemptCount: 1,
    });
    expect(kernel.requireExecution(request.id)).toBe(record);
  });

  it("records one attempt row per attempt, validated against the published contract", async () => {
    const modelId = createModelId();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor("done", usage({ inputTokens: 7, totalTokens: 7, requests: 1 }))],
    });
    const record = await kernel.execute(executionRequest({ model: modelById(modelId) }));

    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({
      stepId: "model-step",
      kind: "model",
      attempt: 1,
      status: "succeeded",
      startedAt: AT,
      finishedAt: AT,
      durationMs: 0,
      failure: null,
      modelId,
    });
    expect(record.attempts[0]?.usage.inputTokens).toBe(7);
  });

  it("sums usage across steps rather than reporting the last one", async () => {
    const executor = stepExecutor("model", (step) =>
      succeededOutcome({ step: step.id }, usage({ requests: 1, totalTokens: 10, costMicro: 100 })),
    );
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [executor] });
    const request = executionRequest();
    const record = await kernel.execute(request, {
      plan: executionPlan(
        { executionId: request.id, steps: [{ id: "a" }, { id: "b" }], createdAt: AT },
        () => AT_MS,
      ),
    });
    expect(record.attempts).toHaveLength(2);
    expect(record.result?.usage).toMatchObject({ requests: 2, totalTokens: 20, costMicro: 200 });
    expect(record.governance.attemptCount).toBe(2);
  });

  it("returns a single step's output unwrapped, and several steps' outputs keyed by step", async () => {
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [stepExecutor("model", (step) => succeededOutcome({ step: step.id }))],
    });
    const request = executionRequest();
    const twoSteps = executionPlan(
      { executionId: request.id, steps: [{ id: "beta" }, { id: "alpha" }], createdAt: AT },
      () => AT_MS,
    );
    const record = await kernel.execute(request, { plan: twoSteps });

    expect(record.result?.status).toBe("succeeded");
    expect(
      record.result !== null && record.result.status === "succeeded" ? record.result.output : null,
    ).toEqual({ alpha: { step: "alpha" }, beta: { step: "beta" } });
    expect(record.result?.metadata).toMatchObject({
      steps: 2,
      attempts: 2,
      stepStatuses: { alpha: "succeeded", beta: "succeeded" },
    });
  });

  it("notes what it did at every point, in a timeline an auditor can read", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    const record = await kernel.execute(executionRequest());
    const notes = notesOf(record);
    expect(notes[0]).toBe("execution created");
    expect(notes).toContain("request satisfied the ExecutionRequest contract");
    expect(notes).toContain("no policy engine configured");
    expect(notes.some((note) => note.startsWith("plan pln_"))).toBe(true);
    expect(notes.some((note) => note.startsWith("running 1 step"))).toBe(true);
    expect(notes.some((note) => note.includes('step "model-step" succeeded on attempt 1'))).toBe(
      true,
    );
    expect(notes.at(-1)).toBe("all 1 step(s) succeeded");
  });

  it("prefers a run's executors over the registered ones", async () => {
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor("registered")],
    });
    const record = await kernel.execute(executionRequest(), { executors: [okExecutor("per-run")] });
    expect(
      record.result !== null && record.result.status === "succeeded" ? record.result.output : null,
    ).toBe("per-run");
  });

  it("refuses a caller scope that belongs to a different execution", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const scope = ExecutionScope.createRoot(
      { executionId: createExecutionId() },
      { clock: () => AT_MS },
    );
    await expect(kernel.execute(executionRequest(), { scope })).rejects.toThrow(ValidationError);
    await expect(kernel.execute(executionRequest(), { scope })).rejects.toThrow(
      /execution scope is for/,
    );
    scope.dispose();
  });

  it("uses a caller scope when it matches, and leaves it alive afterwards", async () => {
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor("scoped")],
    });
    const request = executionRequest();
    const scope = ExecutionScope.createRoot({ executionId: request.id }, { clock: () => AT_MS });
    const record = await kernel.execute(request, { scope });
    expect(record.status).toBe("succeeded");
    expect(scope.isDisposed).toBe(false);
    scope.dispose();
  });

  it("refuses to run the same execution twice", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    const request = executionRequest();
    await kernel.execute(request);
    await expect(kernel.execute(request)).rejects.toThrow(ConflictError);
    await expect(kernel.execute(request)).rejects.toThrow(/already registered/);
  });

  it("produces the same record shape for the same request, run after run", async () => {
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor({ answer: 1 })],
    });
    const first = await kernel.execute(executionRequest({ id: createExecutionId() }));
    const second = await kernel.execute(executionRequest({ id: createExecutionId() }));
    expect(statusTrail(first)).toEqual(statusTrail(second));
    expect(first.plan?.steps.map((step) => step.id)).toEqual(
      second.plan?.steps.map((step) => step.id),
    );
    expect(first.result?.status).toBe(second.result?.status);
    expect(first.attempts.map((row) => row.status)).toEqual(
      second.attempts.map((row) => row.status),
    );
  });
});

describe("transition", () => {
  it("moves a stored execution to a legal state and records the move", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const request = executionRequest();
    kernel.create(request);
    const moved = await kernel.transition(request.id, "validated", "operator confirmed the input");
    expect(moved.status).toBe("validated");
    expect(moved.timeline.at(-1)).toMatchObject({
      status: "validated",
      note: "operator confirmed the input",
    });
  });

  it("refuses an illegal move with the published contract error", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    const request = executionRequest();
    kernel.create(request);
    await expect(kernel.transition(request.id, "running")).rejects.toThrow(ContractError);
    await expect(kernel.transition(request.id, "succeeded")).rejects.toThrow(
      /illegal execution transition created -> succeeded/,
    );
    expect(kernel.requireExecution(request.id).status).toBe("created");
  });

  it("refuses to move a finished execution", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    const record = await kernel.execute(executionRequest());
    await expect(kernel.transition(record.request.id, "running")).rejects.toThrow(ContractError);
  });

  it("says when the execution does not exist", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS });
    await expect(kernel.transition(createExecutionId(), "validated")).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("telemetry", () => {
  it("opens one span per execution, names it after the kind, and ends it", async () => {
    const { tracer, spans } = recordingTracer();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      tracer,
      executors: [okExecutor()],
    });
    const modelId = createModelId();
    await kernel.execute(
      executionRequest({ model: modelById(modelId), mode: "streaming", priority: "high" }),
    );

    expect(spans).toHaveLength(1);
    const span = onlySpan(spans);
    expect(span.recordedName).toBe("execution.run model");
    expect(span.ended).toBe(true);
    expect(span.recordedAttributes["omnis.ai.execution.id"]).toBeDefined();
    expect(span.recordedAttributes["omnis.ai.execution.mode"]).toBe("streaming");
    expect(span.recordedAttributes["omnis.ai.execution.priority"]).toBe("high");
    expect(span.recordedAttributes["omnis.ai.model.id"]).toBe(modelId);
    expect(span.recordedAttributes["omnis.ai.attempt"]).toBe(1);
  });

  it("decorates the span with the outcome, and marks it ok or error accordingly", async () => {
    const { tracer, spans } = recordingTracer();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      tracer,
      executors: [okExecutor("fine", usage({ totalTokens: 12, costMicro: 300 }))],
    });
    await kernel.execute(executionRequest());
    const span = onlySpan(spans);
    expect(span.recordedAttributes["omnis.ai.execution.status"]).toBe("succeeded");
    expect(span.recordedAttributes["omnis.ai.status"]).toBe("succeeded");
    expect(span.recordedAttributes["omnis.ai.usage.total_tokens"]).toBe(12);
    expect(span.recordedAttributes["omnis.ai.usage.cost_micro_usd"]).toBe(300);
    expect(span.recordedAttributes["omnis.ai.cancelled"]).toBe(false);
    expect(span.recordedAttributes["omnis.ai.timed_out"]).toBe(false);
    expect(span.recordedStatuses).toEqual([{ status: "ok", message: undefined }]);
  });

  it("puts the failure class and code on the span, but never the failure message", async () => {
    const { tracer, spans } = recordingTracer();
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, tracer });
    await kernel.execute(executionRequest());
    const span = onlySpan(spans);
    expect(span.recordedAttributes["omnis.ai.failure.code"]).toBe("validation_failed");
    expect(span.recordedAttributes["omnis.ai.failure.class"]).toBe("validation");
    expect(span.recordedStatuses[0]?.status).toBe("error");
    expect(Object.values(span.recordedAttributes).join("|")).not.toMatch(/no step executor/);
  });

  it("parents the span to the incoming trace when the request carries one", async () => {
    const { tracer, spans } = recordingTracer();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      tracer,
      executors: [okExecutor()],
    });
    const traceId = createTraceId();
    const parentSpanId = createSpanId();
    const request = executionRequest({ traceId });
    const scope = ExecutionScope.createRoot(
      { executionId: request.id, traceId, parentSpanId },
      { clock: () => AT_MS },
    );
    await kernel.execute(request, { scope });
    const span = onlySpan(spans);
    expect(span.parent?.traceId).toBe(traceId);
    expect(span.parent?.spanId).toBe(parentSpanId);
    scope.dispose();
  });

  it("never puts request input or model output on a span", async () => {
    const { tracer, spans } = recordingTracer();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      tracer,
      executors: [okExecutor({ secretAnswer: "hunter2" })],
    });
    await kernel.execute(executionRequest({ input: { prompt: "a very private question" } }));
    const dumped = JSON.stringify(spans[0]?.recordedAttributes);
    expect(dumped).not.toMatch(/hunter2/);
    expect(dumped).not.toMatch(/a very private question/);
  });
});

describe("hooks", () => {
  it("calls the observation points in lifecycle order", async () => {
    const hooks = collectingHooks();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      hooks,
      executors: [okExecutor()],
    });
    await kernel.execute(executionRequest());

    expect(hooks.records).toHaveLength(2);
    expect(hooks.records[0]?.status).toBe("created");
    expect(hooks.records[1]?.status).toBe("succeeded");
    expect(hooks.changes.map((change) => change.to)).toEqual([
      "validated",
      "authorized",
      "planned",
      "running",
      "succeeded",
    ]);
    expect(hooks.changes[0]?.from).toBe("created");
    expect(hooks.steps).toHaveLength(1);
    expect(hooks.steps[0]?.step.id).toBe("model-step");
    expect(hooks.steps[0]?.attempt.status).toBe("succeeded");
    expect(hooks.retries).toEqual([]);
    expect(hooks.hookErrors).toEqual([]);
  });

  it("composes run hooks after kernel hooks, so both see the run", async () => {
    const kernelHooks = collectingHooks();
    const runHooks = collectingHooks();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      hooks: kernelHooks,
      executors: [okExecutor()],
    });
    await kernel.execute(executionRequest(), { hooks: runHooks });
    expect(kernelHooks.changes).toHaveLength(5);
    expect(runHooks.changes).toHaveLength(5);
  });

  it("records a hook failure and keeps the execution going", async () => {
    const broken: ExecutionHooks = {
      beforeStep: () => {
        throw new Error("observer exploded");
      },
    };
    const watching = collectingHooks();
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      hooks: broken,
      executors: [okExecutor("still fine")],
    });
    const record = await kernel.execute(executionRequest(), { hooks: watching });

    expect(record.status).toBe("succeeded");
    expect(
      record.result !== null && record.result.status === "succeeded" ? record.result.output : null,
    ).toBe("still fine");
    expect(notesOf(record)).toContain("hook beforeStep failed: observer exploded");
    expect(watching.hookErrors).toEqual([{ point: "beforeStep", message: "observer exploded" }]);
  });

  it("contains a hook that fails while reporting another hook's failure", async () => {
    const hostile: ExecutionHooks = {
      beforeExecution: () => {
        throw new Error("first failure");
      },
      onHookError: () => {
        throw new Error("second failure");
      },
    };
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      hooks: hostile,
      executors: [okExecutor()],
    });
    const record = await kernel.execute(executionRequest());
    expect(record.status).toBe("succeeded");
    expect(notesOf(record)).toContain("hook beforeExecution failed: first failure");
  });
});

describe("evaluation", () => {
  it("grades the execution with what it consumed and what policy decided", async () => {
    // Captured in an array: a `let` assigned inside a callback is narrowed to its initializer by
    // control-flow analysis, which would make every assertion below type-error.
    const seen: EvaluationInput[] = [];
    const evaluation: EvaluationResult = Object.freeze({
      id: createEvaluationId(),
      executionId: createExecutionId(),
      verdict: "pass",
      overallScore: 0.9,
      scores: [],
      rulesApplied: ["output_present"],
      evaluatedAt: AT,
      deterministic: true,
      metadata: {},
    });
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor({ answer: 1 }, usage({ totalTokens: 5 }))],
      evaluate: (input) => {
        seen.push(input);
        return evaluation;
      },
    });
    const record = await kernel.execute(
      executionRequest({
        input: {
          prompt: "hi",
          expected: { answer: 1 },
          responseFormat: "json",
          schemaName: "answer",
        },
      }),
    );

    expect(seen).toHaveLength(1);
    const input = seen[0] as EvaluationInput;
    expect(input.output).toEqual({ answer: 1 });
    expect(input.expected).toEqual({ answer: 1 });
    expect(input.requestedResponseFormat).toBe("json");
    expect(input.schemaName).toBe("answer");
    expect(input.usage?.totalTokens).toBe(5);
    expect(input.policyOutcome).toBeNull();
    expect(input.failure).toBeNull();
    expect(input.cancelled).toBe(false);
    expect(input.timedOut).toBe(false);
    expect(input.toolResults).toEqual([]);
    expect(record.evaluation).toBe(evaluation);
    expect(record.result?.status === "succeeded" ? record.result.evaluation : null).toBe(
      evaluation,
    );
  });

  it("keeps a successful execution successful when the evaluator throws", async () => {
    const kernel = new InMemoryExecutionKernel({
      clock: () => AT_MS,
      executors: [okExecutor()],
      evaluate: () => {
        throw new Error("evaluator exploded");
      },
    });
    const record = await kernel.execute(executionRequest());
    expect(record.status).toBe("succeeded");
    expect(record.evaluation).toBeNull();
  });

  it("leaves the evaluation empty when no evaluator was injected", async () => {
    const kernel = new InMemoryExecutionKernel({ clock: () => AT_MS, executors: [okExecutor()] });
    const record = await kernel.execute(executionRequest());
    expect(record.evaluation).toBeNull();
  });
});
