import { describe, expect, it } from "vitest";
import { createCorrelationId, createEvaluationId, createExecutionId } from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import {
  attemptsForStep,
  ATTEMPT_STATUSES,
  createExecutionFailure,
  EMPTY_USAGE,
  executionStatusForResult,
  initialExecutionMetadata,
  isExecutionRecordTerminal,
  isSuccessfulResult,
  recordAttemptCount,
  resultFailure,
  summarizeExecutionRecord,
  totalRecordUsage,
  withExecutionTiming,
  withGovernanceOutcome,
  type ExecutionAttempt,
  type ExecutionFailure,
  type ExecutionRecord,
  type ExecutionResult,
} from "./index.js";

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    stepId: "step-1",
    kind: "model",
    attempt: 1,
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    failure: null,
    usage: { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1 },
    modelId: null,
    providerId: null,
    toolId: null,
    metadata: {},
    ...overrides,
  };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const executionId = createExecutionId();
  return {
    request: {
      id: executionId,
      kind: "agent",
      correlationId: createCorrelationId(),
      causationId: null,
      traceId: null,
      tenantId: null,
      parentExecutionId: null,
      agentId: null,
      model: null,
      tool: null,
      input: { prompt: "summarize the report" },
      mode: "interactive",
      priority: "normal",
      policyId: "prod-default",
      budgetId: null,
      deadlineMs: 30_000,
      metadata: {},
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
    status: "running",
    plan: null,
    attempts: [attempt()],
    result: null,
    governance: initialExecutionMetadata("2026-01-01T00:00:30.000Z"),
    timeline: [{ at: "2026-01-01T00:00:00.000Z", status: "created", note: null, stepId: null }],
    evaluation: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function succeeded(output: JsonValue | null = { answer: "done" }): ExecutionResult {
  return {
    status: "succeeded",
    executionId: createExecutionId(),
    output,
    usage: { ...EMPTY_USAGE, totalTokens: 15, requests: 1, costMicro: 250 },
    evaluation: null,
    completedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2_000,
    metadata: {},
  };
}

/**
 * Builds a non-success result.
 *
 * Each variant is written out rather than assembled from a status variable: a
 * discriminated union cannot be constructed from a widened discriminant without a
 * cast, and a cast here would hide a genuine mismatch between variants.
 */
function nonSuccess(
  status: "failed" | "cancelled" | "timed_out",
  failure: ExecutionFailure,
): ExecutionResult {
  const shared = {
    executionId: createExecutionId(),
    failure,
    usage: EMPTY_USAGE,
    completedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2_000,
    metadata: {},
  };
  switch (status) {
    case "failed":
      return { status, evaluation: null, ...shared };
    case "cancelled":
      return { status, ...shared };
    case "timed_out":
      return { status, ...shared };
  }
}

describe("execution results", () => {
  it("narrows a success and exposes its output", () => {
    const result = succeeded();
    expect(isSuccessfulResult(result)).toBe(true);
    if (isSuccessfulResult(result)) {
      expect(result.output).toEqual({ answer: "done" });
      expect(result.evaluation).toBeNull();
    }
    expect(resultFailure(result)).toBeNull();
  });

  it("exposes the classified failure of every non-success", () => {
    const failure = createExecutionFailure({
      class: "provider_failure",
      code: "provider_failure",
      message: "upstream 503",
    });
    for (const status of ["failed", "cancelled", "timed_out"] as const) {
      const result = nonSuccess(status, failure);
      expect(isSuccessfulResult(result), status).toBe(false);
      expect(resultFailure(result)?.class).toBe("provider_failure");
      expect(executionStatusForResult(status)).toBe(status);
    }
  });

  it("allows a success to carry a null output", () => {
    // Work whose only effect was a side effect legitimately produces no output, and
    // that is not the same as a failure.
    expect(isSuccessfulResult(succeeded(null))).toBe(true);
  });

  it("maps each result status onto the execution status it terminates in", () => {
    expect(executionStatusForResult("succeeded")).toBe("succeeded");
    expect(executionStatusForResult("failed")).toBe("failed");
    expect(executionStatusForResult("cancelled")).toBe("cancelled");
    expect(executionStatusForResult("timed_out")).toBe("timed_out");
    expect(ATTEMPT_STATUSES).toContain("skipped");
  });
});

describe("execution records", () => {
  it("is terminal only when its status is", () => {
    expect(isExecutionRecordTerminal(record())).toBe(false);
    expect(isExecutionRecordTerminal(record({ status: "succeeded" }))).toBe(true);
    expect(isExecutionRecordTerminal(record({ status: "waiting" }))).toBe(false);
  });

  it("totals usage across attempts", () => {
    const subject = record({
      attempts: [
        attempt({
          usage: {
            ...EMPTY_USAGE,
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            requests: 1,
            costMicro: 100,
          },
        }),
        attempt({
          stepId: "step-2",
          usage: {
            ...EMPTY_USAGE,
            inputTokens: 4,
            outputTokens: 1,
            totalTokens: 5,
            requests: 1,
            costMicro: 50,
          },
        }),
      ],
    });
    expect(totalRecordUsage(subject)).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      totalTokens: 20,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      requests: 2,
      costMicro: 150,
    });
  });

  it("keeps an unpriced attempt unpriced in the total", () => {
    const subject = record({
      attempts: [
        attempt({ usage: { ...EMPTY_USAGE, totalTokens: 15, requests: 1, costMicro: 100 } }),
        attempt({
          stepId: "step-2",
          usage: { ...EMPTY_USAGE, totalTokens: 5, requests: 1, costMicro: null },
        }),
      ],
    });
    expect(totalRecordUsage(subject).costMicro).toBeNull();
  });

  it("filters attempts by step and counts them", () => {
    const subject = record({
      attempts: [attempt(), attempt({ attempt: 2 }), attempt({ stepId: "step-2" })],
    });
    expect(attemptsForStep(subject, "step-1")).toHaveLength(2);
    expect(attemptsForStep(subject, "step-2")).toHaveLength(1);
    expect(attemptsForStep(subject, "step-3")).toHaveLength(0);
    expect(recordAttemptCount(subject)).toBe(3);
  });
});

describe("summarizeExecutionRecord", () => {
  it("carries the facts an event or span needs", () => {
    const failure = createExecutionFailure({
      class: "budget_blocked",
      code: "execution_failed",
      message: "no allowance",
    });
    const subject = record({
      status: "failed",
      governance: {
        ...initialExecutionMetadata(),
        policyOutcome: "allow",
        budgetStatus: "committed",
        durationMs: 1_500,
      },
      result: {
        status: "failed",
        executionId: createExecutionId(),
        failure,
        usage: EMPTY_USAGE,
        evaluation: null,
        completedAt: "2026-01-01T00:00:02.000Z",
        durationMs: 1_500,
        metadata: {},
      },
      evaluation: {
        id: createEvaluationId(),
        executionId: createExecutionId(),
        verdict: "warn",
        overallScore: 0.6,
        scores: [],
        rulesApplied: ["latency-budget"],
        evaluatedAt: "2026-01-01T00:00:02.000Z",
        deterministic: true,
        metadata: {},
      },
    });

    const summary = summarizeExecutionRecord(subject);
    expect(summary["status"]).toBe("failed");
    expect(summary["failureClass"]).toBe("budget_blocked");
    expect(summary["policyOutcome"]).toBe("allow");
    expect(summary["budgetStatus"]).toBe("committed");
    expect(summary["evaluationVerdict"]).toBe("warn");
    expect(summary["attemptCount"]).toBe(1);
    expect(summary["durationMs"]).toBe(1_500);
  });

  it("never includes request input, message content or tool arguments", () => {
    // The summary is emitted onto an event bus with many subscribers; the audit store
    // is where payloads belong.
    const summary = summarizeExecutionRecord(
      record({ attempts: [attempt({ metadata: { arguments: { query: "secret" } } })] }),
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("summarize the report");
    expect(serialized).not.toContain("secret");
    expect(Object.keys(summary)).toEqual([
      "executionId",
      "correlationId",
      "kind",
      "mode",
      "priority",
      "status",
      "stepCount",
      "attemptCount",
      "durationMs",
      "policyOutcome",
      "budgetStatus",
      "evaluationVerdict",
      "evaluationId",
      "failureClass",
      "failureCode",
      "retryable",
    ]);
  });

  it("reports nulls rather than omitting keys for an execution still in flight", () => {
    const summary = summarizeExecutionRecord(record());
    expect(summary["failureClass"]).toBeNull();
    expect(summary["evaluationVerdict"]).toBeNull();
    expect(summary["stepCount"]).toBe(0);
  });
});

describe("governance metadata updates", () => {
  it("records policy and budget outcomes without mutating the previous snapshot", () => {
    const before = initialExecutionMetadata();
    const after = withGovernanceOutcome(before, {
      policyId: null,
      policyOutcome: "constrain",
      budgetId: null,
      reservationState: "held",
    });
    expect(after.policyOutcome).toBe("constrain");
    expect(after.budgetStatus).toBe("held");
    // An observer that read the record before authorization must still see what it saw.
    expect(before.policyOutcome).toBeNull();
    expect(before.budgetStatus).toBeNull();
    expect(Object.isFrozen(after)).toBe(true);
  });

  it("keeps an already-recorded value when the new outcome is unknown", () => {
    const first = withGovernanceOutcome(initialExecutionMetadata(), {
      policyId: null,
      policyOutcome: "allow",
      budgetId: null,
      reservationState: "held",
    });
    const second = withGovernanceOutcome(first, {
      policyId: null,
      policyOutcome: null,
      budgetId: null,
      reservationState: null,
    });
    expect(second.policyOutcome).toBe("allow");
    expect(second.budgetStatus).toBe("held");
  });

  it("records timing and attempt count", () => {
    const timed = withExecutionTiming(initialExecutionMetadata(), {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.500Z",
      durationMs: 2_500,
      attemptCount: 3,
    });
    expect(timed.durationMs).toBe(2_500);
    expect(timed.attemptCount).toBe(3);
    expect(timed.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
