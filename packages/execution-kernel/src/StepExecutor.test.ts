import { describe, expect, it } from "vitest";
import {
  createCorrelationId,
  createExecutionId,
  createModelId,
  createProviderId,
  createTenantId,
  createToolId,
  createTraceId,
} from "@omnis/types";
import { createExecutionFailure, EMPTY_USAGE } from "@omnis/ai-core-types";
import type { ExecutionFailure, UsageSummary } from "@omnis/ai-core-types";
import { ExecutionScope, deadlineIso } from "@omnis/execution-context";
import { InfrastructureError, TimeoutError, ValidationError } from "@omnis/errors";
import {
  cancelledOutcome,
  failedOutcome,
  isSuccessfulOutcome,
  outcomeFromError,
  retryDelayMs,
  shouldRetry,
  skippedOutcome,
  stepEnvironment,
  stepExecutor,
  stepOutcome,
  succeededOutcome,
} from "./StepExecutor.js";
import type { StepOutcome } from "./StepExecutor.js";
import { executionStep } from "./plans.js";
import { AT, AT_MS, executionRequest, usage } from "./testSupport.js";

/** A failure with an explicit classification, for the retry matrix. */
function failure(
  overrides: Partial<Parameters<typeof createExecutionFailure>[0]> = {},
): ExecutionFailure {
  return createExecutionFailure({
    class: "retryable",
    code: "provider_failure",
    message: "upstream refused",
    retryable: true,
    attempt: 1,
    occurredAt: AT,
    ...overrides,
  });
}

describe("stepOutcome", () => {
  it('defaults everything an executor did not report to "nothing happened"', () => {
    const outcome = stepOutcome({ status: "succeeded" });
    expect(outcome).toEqual({
      status: "succeeded",
      output: null,
      usage: EMPTY_USAGE,
      failure: null,
      modelId: null,
      providerId: null,
      toolId: null,
      metadata: {},
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.metadata)).toBe(true);
  });

  it("keeps every field an executor did report", () => {
    const modelId = createModelId();
    const providerId = createProviderId();
    const toolId = createToolId();
    const consumed: UsageSummary = usage();
    const outcome = stepOutcome({
      status: "failed",
      output: { partial: true },
      usage: consumed,
      failure: failure(),
      modelId,
      providerId,
      toolId,
      metadata: { stage: "decode" },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.output).toEqual({ partial: true });
    expect(outcome.usage).toBe(consumed);
    expect(outcome.failure?.code).toBe("provider_failure");
    expect(outcome.modelId).toBe(modelId);
    expect(outcome.providerId).toBe(providerId);
    expect(outcome.toolId).toBe(toolId);
    expect(outcome.metadata).toEqual({ stage: "decode" });
  });

  it("builds the four named outcomes with the status their name promises", () => {
    expect(succeededOutcome().status).toBe("succeeded");
    expect(succeededOutcome({ answer: 1 }).output).toEqual({ answer: 1 });
    expect(succeededOutcome(null, usage({ requests: 2 })).usage.requests).toBe(2);
    expect(succeededOutcome(null, EMPTY_USAGE, { routed: "a" }).metadata).toEqual({ routed: "a" });

    const failed = failedOutcome(failure({ message: "no capacity" }));
    expect(failed.status).toBe("failed");
    expect(failed.failure?.message).toBe("no capacity");

    const skipped = skippedOutcome("dependency failed");
    expect(skipped.status).toBe("skipped");
    expect(skipped.metadata["skippedReason"]).toBe("dependency failed");

    const cancelled = cancelledOutcome("user stopped the run");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failure?.message).toBe("user stopped the run");
    expect(cancelled.metadata["cancellationReason"]).toBe("user stopped the run");
  });

  it("reports which outcomes mean the step did its work", () => {
    expect(isSuccessfulOutcome(succeededOutcome())).toBe(true);
    expect(isSuccessfulOutcome(failedOutcome(failure()))).toBe(false);
    expect(isSuccessfulOutcome(skippedOutcome("nope"))).toBe(false);
    expect(isSuccessfulOutcome(cancelledOutcome("nope"))).toBe(false);
    expect(isSuccessfulOutcome(stepOutcome({ status: "timed_out" }))).toBe(false);
  });
});

describe("outcomeFromError", () => {
  it("classifies a timeout as a deadline failure", () => {
    const outcome = outcomeFromError(
      new TimeoutError("step exceeded 50ms", { timeoutMs: 50, operation: "step" }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.class).toBe("deadline_exceeded");
    expect(outcome.failure?.code).toBe("timeout");
    expect(outcome.failure?.retryable).toBe(false);
  });

  it("classifies a retryable infrastructure failure as retryable, and keeps the provider's delay", () => {
    const outcome = outcomeFromError(
      new InfrastructureError("provider", "upstream 503", { retryable: true, retryAfterMs: 20 }),
    );
    expect(outcome.failure?.class).toBe("retryable");
    expect(outcome.failure?.code).toBe("infrastructure_failure");
    expect(outcome.failure?.retryable).toBe(true);
    expect(outcome.failure?.retryAfterMs).toBe(20);
  });

  it("refuses to call a non-retryable infrastructure failure retryable", () => {
    const outcome = outcomeFromError(
      new InfrastructureError("provider", "upstream 400", { retryable: false }),
    );
    expect(outcome.failure?.class).toBe("non_retryable");
    expect(outcome.failure?.retryable).toBe(false);
  });

  it("classifies a validation failure and keeps the issues as details", () => {
    const outcome = outcomeFromError(new ValidationError("input is not JSON-safe"));
    expect(outcome.failure?.class).toBe("validation");
    expect(outcome.failure?.code).toBe("validation_failed");
    expect(outcome.failure?.retryable).toBe(false);
  });

  it("accepts a plain string and a value that is not an error at all", () => {
    expect(outcomeFromError("the provider hung up").failure?.message).toBe("the provider hung up");
    const odd = outcomeFromError(42);
    expect(odd.failure?.message).toBe("execution failed with a non-error value");
    expect(odd.failure?.class).toBe("unknown");
    expect(odd.failure?.code).toBe("unknown");
  });

  it("attaches the context and usage the caller supplied", () => {
    const executionId = createExecutionId();
    const modelId = createModelId();
    const outcome = outcomeFromError(
      new ValidationError("bad"),
      { executionId, stepId: "decode", attempt: 2, modelId },
      usage({ requests: 3 }),
    );
    expect(outcome.failure?.executionId).toBe(executionId);
    expect(outcome.failure?.stepId).toBe("decode");
    expect(outcome.failure?.attempt).toBe(2);
    expect(outcome.failure?.modelId).toBe(modelId);
    expect(outcome.usage.requests).toBe(3);
  });
});

describe("shouldRetry", () => {
  const retryable = stepOutcome({ status: "failed", failure: failure() });
  const nonRetryable = stepOutcome({
    status: "failed",
    failure: failure({ class: "non_retryable", retryable: false }),
  });

  it("retries a retryable failure while attempts remain", () => {
    expect(shouldRetry(retryable, 1, 3)).toBe(true);
    expect(shouldRetry(retryable, 2, 3)).toBe(true);
  });

  it("stops at the last attempt rather than spending one more", () => {
    expect(shouldRetry(retryable, 3, 3)).toBe(false);
    expect(shouldRetry(retryable, 4, 3)).toBe(false);
    expect(shouldRetry(retryable, 1, 1)).toBe(false);
  });

  it("never retries a failure classified as non-retryable", () => {
    expect(shouldRetry(nonRetryable, 1, 5)).toBe(false);
  });

  it("never retries a failure with no classification to retry on", () => {
    expect(shouldRetry(stepOutcome({ status: "failed", failure: null }), 1, 5)).toBe(false);
  });

  it("treats success, skip, cancellation and timeouts as final", () => {
    expect(shouldRetry(succeededOutcome(), 1, 5)).toBe(false);
    expect(shouldRetry(skippedOutcome("dependency"), 1, 5)).toBe(false);
    expect(shouldRetry(cancelledOutcome("stop"), 1, 5)).toBe(false);
    expect(
      shouldRetry(
        stepOutcome({
          status: "timed_out",
          failure: failure({ class: "deadline_exceeded", code: "timeout", retryable: true }),
        }),
        1,
        5,
      ),
    ).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("prefers the delay the failure carries, because that is the provider telling us when to return", () => {
    expect(retryDelayMs(failure({ retryAfterMs: 120 }), 10, 5_000)).toBe(120);
  });

  it("falls back to the kernel delay when the failure carries none", () => {
    expect(retryDelayMs(failure({ retryAfterMs: null }), 250, 5_000)).toBe(250);
    expect(retryDelayMs(null, 250, 5_000)).toBe(250);
  });

  it("clamps to the published maximum, so a hostile retry hint cannot stall a run", () => {
    expect(retryDelayMs(failure({ retryAfterMs: 600_000 }), 10, 5_000)).toBe(5_000);
  });

  it("returns zero for a delay that is not a usable number", () => {
    expect(retryDelayMs(failure({ retryAfterMs: 0 }), 250, 5_000)).toBe(0);
    expect(retryDelayMs(failure({ retryAfterMs: -1 }), 250, 5_000)).toBe(0);
    expect(retryDelayMs(failure({ retryAfterMs: Number.NaN }), 250, 5_000)).toBe(0);
    expect(retryDelayMs(failure({ retryAfterMs: Number.POSITIVE_INFINITY }), 250, 5_000)).toBe(0);
  });

  it("is deterministic: the same failure and the same fallback always give the same delay", () => {
    const one = retryDelayMs(failure({ retryAfterMs: 77.9 }), 250, 5_000);
    const two = retryDelayMs(failure({ retryAfterMs: 77.9 }), 250, 5_000);
    expect(one).toBe(two);
    expect(one).toBe(77);
  });
});

describe("stepExecutor", () => {
  it("pairs a kind with a function and calls it with the step and the environment", async () => {
    const step = executionStep({ id: "call", kind: "tool" });
    const seen: { stepId: string; attempt: number }[] = [];
    const executor = stepExecutor("tool", (received, environment) => {
      seen.push({ stepId: received.id, attempt: environment.attempt });
      return succeededOutcome({ ok: true });
    });
    expect(executor.kind).toBe("tool");
    expect(Object.isFrozen(executor)).toBe(true);

    const scope = ExecutionScope.createRoot(
      { executionId: createExecutionId() },
      { clock: () => AT_MS },
    );
    const outcome = await executor.execute(step, stepEnvironment(scope, step, 1, 1));
    expect(outcome.output).toEqual({ ok: true });
    expect(seen).toEqual([{ stepId: "call", attempt: 1 }]);
    scope.dispose();
  });

  it("accepts an executor that returns a promise", async () => {
    const step = executionStep({ id: "async" });
    const executor = stepExecutor("model", async () => succeededOutcome("later"));
    const scope = ExecutionScope.createRoot(
      { executionId: createExecutionId() },
      { clock: () => AT_MS },
    );
    await expect(executor.execute(step, stepEnvironment(scope, step, 1, 1))).resolves.toMatchObject(
      { status: "succeeded", output: "later" },
    );
    scope.dispose();
  });
});

/** One step, shared by the environment and outcome suites. */
const STEP = executionStep({ id: "decode", kind: "model", timeoutMs: 1_000 });

describe("stepEnvironment", () => {
  const step = STEP;

  it("reports the identity of the execution the step belongs to", () => {
    const executionId = createExecutionId();
    const correlationId = createCorrelationId();
    const tenantId = createTenantId();
    const traceId = createTraceId();
    const scope = ExecutionScope.createRoot(
      { executionId, correlationId, tenantId, traceId, deadlineMs: 1_000 },
      { clock: () => AT_MS },
    );
    const environment = stepEnvironment(scope, step, 2, 3);

    expect(environment.executionId).toBe(executionId);
    expect(environment.stepId).toBe("decode");
    expect(environment.correlationId).toBe(correlationId);
    expect(environment.tenantId).toBe(tenantId);
    expect(environment.traceId).toBe(traceId);
    expect(environment.attempt).toBe(2);
    expect(environment.maxAttempts).toBe(3);
    expect(environment.startedAt).toBe(scope.context.startedAt);
    expect(environment.context).toBe(scope.context);
    expect(Object.isFrozen(environment)).toBe(true);
    scope.dispose();
  });

  it("exposes the step deadline as an absolute timestamp, and null when there is none", () => {
    const bounded = ExecutionScope.createRoot(
      { executionId: createExecutionId(), deadlineMs: 1_000 },
      { clock: () => AT_MS },
    );
    const environment = stepEnvironment(bounded, step, 1, 1);
    // One second after the fixed clock, as an absolute timestamp rather than a countdown.
    expect(environment.deadlineAt).toBe("2026-02-25T06:13:21.000Z");
    expect(bounded.context.deadline).not.toBeNull();
    if (bounded.context.deadline !== null) {
      expect(environment.deadlineAt).toBe(deadlineIso(bounded.context.deadline));
    }
    expect(environment.remainingMs()).toBe(1_000);
    bounded.dispose();

    const unbounded = ExecutionScope.createRoot(
      { executionId: createExecutionId() },
      { clock: () => AT_MS },
    );
    expect(stepEnvironment(unbounded, step, 1, 1).deadlineAt).toBeNull();
    expect(stepEnvironment(unbounded, step, 1, 1).remainingMs()).toBeNull();
    unbounded.dispose();
  });

  it("sees cancellation the moment the scope is cancelled, with the reason", () => {
    const scope = ExecutionScope.createRoot(
      { executionId: createExecutionId() },
      { clock: () => AT_MS },
    );
    const environment = stepEnvironment(scope, step, 1, 1);
    expect(environment.isCancelled()).toBe(false);
    expect(environment.cancellationReason()).toBeNull();

    scope.cancel("operator stopped the run");
    expect(environment.isCancelled()).toBe(true);
    expect(environment.cancellationReason()).toBe("operator stopped the run");
    scope.dispose();
  });

  it("carries no parent span when the kernel did not open one", () => {
    const scope = ExecutionScope.createRoot(
      { executionId: createExecutionId() },
      { clock: () => AT_MS },
    );
    expect(stepEnvironment(scope, step, 1, 1).parentSpanId).toBeNull();
    scope.dispose();
  });
});

describe("outcome shape", () => {
  it("never loses usage reported by a failed attempt, because it was still spent", () => {
    const spent: StepOutcome = failedOutcome(failure(), usage({ costMicro: 1_500 }));
    expect(spent.usage.costMicro).toBe(1_500);
    expect(spent.output).toBeNull();
  });

  it("keeps an empty usage summary unpriced rather than free", () => {
    expect(skippedOutcome("dependency failed").usage).toBe(EMPTY_USAGE);
    expect(EMPTY_USAGE.costMicro).toBeNull();
  });

  it("carries the request identifier an executor was given, for the audit trail", () => {
    const request = executionRequest();
    const scope = ExecutionScope.createRoot(
      { executionId: request.id, correlationId: request.correlationId },
      { clock: () => AT_MS },
    );
    expect(stepEnvironment(scope, STEP, 1, 1).executionId).toBe(request.id);
    scope.dispose();
  });
});
