import { describe, expect, it } from "vitest";
import { createExecutionId } from "@omnis/types";
import { ValidationError } from "@omnis/errors";
import {
  assertEvaluationInput,
  emptyUsage,
  evaluationInputFromRecord,
  evaluationInputFromResult,
  isEvaluationInput,
  isPolicyOutcome,
  MAX_EVALUATED_TOOL_RESULTS,
} from "./input.js";
import {
  cancelledResult,
  evaluationInput,
  failedResult,
  providerFailure,
  succeededResult,
  timedOutResult,
  toolResult,
  usage,
} from "./testSupport.js";

describe("evaluationInputFromResult", () => {
  it("reads a successful result's facts", () => {
    const result = succeededResult({ answer: 42 });
    const input = evaluationInputFromResult(result);
    expect(input.executionId).toBe(result.executionId);
    expect(input.output).toEqual({ answer: 42 });
    expect(input.usage).toBe(result.usage);
    expect(input.latencyMs).toBe(1_200);
    expect(input.failure).toBeNull();
    expect(input.cancelled).toBe(false);
    expect(input.timedOut).toBe(false);
    expect(input.expected).toBeNull();
    expect(input.policyOutcome).toBeNull();
    expect(input.toolResults).toEqual([]);
    expect(isEvaluationInput(input)).toBe(true);
  });

  it("carries a failure and drops the output of a non-success", () => {
    const input = evaluationInputFromResult(failedResult(providerFailure("timeout")));
    expect(input.output).toBeNull();
    expect(input.failure?.code).toBe("timeout");
    expect(input.failure?.class).toBe("provider_failure");
    expect(input.latencyMs).toBe(30_000);
  });

  it("marks cancellation and timeout from the status", () => {
    expect(evaluationInputFromResult(cancelledResult()).cancelled).toBe(true);
    expect(evaluationInputFromResult(cancelledResult()).timedOut).toBe(false);
    expect(evaluationInputFromResult(timedOutResult()).timedOut).toBe(true);
  });

  it("takes the facts a result does not carry from the caller", () => {
    const result = succeededResult({ rows: [1] });
    const tool = toolResult({ status: "failed", errorCode: "no_index" });
    const input = evaluationInputFromResult(result, {
      expected: { rows: [1] },
      requestedResponseFormat: "json_schema",
      schemaName: "Rows",
      outputMatchesRequestedFormat: true,
      policyOutcome: "constrain",
      toolResults: [tool],
    });
    expect(input.expected).toEqual({ rows: [1] });
    expect(input.requestedResponseFormat).toBe("json_schema");
    expect(input.schemaName).toBe("Rows");
    expect(input.outputMatchesRequestedFormat).toBe(true);
    expect(input.policyOutcome).toBe("constrain");
    expect(input.toolResults).toEqual([tool]);
    // An unsupplied format flag means "not verified", never "verified".
    expect(
      evaluationInputFromResult(result, { requestedResponseFormat: "json" })
        .outputMatchesRequestedFormat,
    ).toBe(false);
  });
});

describe("evaluationInputFromRecord", () => {
  /** A record whose governance and attempts the builder has to read. */
  function record(
    result: ReturnType<typeof succeededResult> | null,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      request: {
        id: createExecutionId(),
        kind: "model",
        correlationId: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        causationId: null,
        traceId: null,
        tenantId: null,
        parentExecutionId: null,
        agentId: null,
        model: { kind: "id", modelId: "mdl_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        tool: null,
        input: {},
        mode: "sync",
        priority: "normal",
        policyId: null,
        budgetId: null,
        deadlineMs: null,
        metadata: {},
        requestedAt: "2026-02-25T06:13:20.000Z",
      },
      status: result === null ? "running" : "succeeded",
      plan: null,
      attempts: [],
      result,
      governance: {
        startedAt: "2026-02-25T06:13:20.000Z",
        finishedAt: "2026-02-25T06:13:21.200Z",
        durationMs: 1_200,
        deadlineAt: null,
        attemptCount: 1,
        policyOutcome: "constrain",
        policyId: null,
        budgetStatus: "committed",
        budgetId: null,
        tags: {},
      },
      timeline: [],
      evaluation: null,
      createdAt: "2026-02-25T06:13:20.000Z",
      updatedAt: "2026-02-25T06:13:21.200Z",
      ...overrides,
    };
  }

  it("reads governance, timing and the request's model reference", () => {
    const result = succeededResult({ rows: [1] });
    const executionRecord = record(result);
    const input = evaluationInputFromRecord(executionRecord as never);
    expect(input.executionId).toBe(executionRecord.request.id);
    expect(input.output).toEqual({ rows: [1] });
    expect(input.policyOutcome).toBe("constrain");
    expect(input.latencyMs).toBe(1_200);
    expect(input.modelId).toBe("mdl_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(isEvaluationInput(input)).toBe(true);
  });

  it("handles a record with no result yet", () => {
    const input = evaluationInputFromRecord(record(null) as never);
    expect(input.output).toBeNull();
    expect(input.failure).toBeNull();
    expect(input.cancelled).toBe(false);
    expect(input.usage).toEqual(emptyUsage());
    expect(input.latencyMs).toBe(1_200);
  });

  it("ignores a governance outcome it does not recognize", () => {
    const withRecord = record(succeededResult(), {
      governance: {
        ...(record(null).governance as Record<string, unknown>),
        policyOutcome: "shrug",
      },
    });
    expect(evaluationInputFromRecord(withRecord as never).policyOutcome).toBeNull();
  });

  it("reads a cancelled record", () => {
    const cancelled = record(succeededResult(), { status: "cancelled" });
    expect(evaluationInputFromRecord(cancelled as never).cancelled).toBe(true);
  });
});

describe("assertEvaluationInput", () => {
  it("accepts the fixture", () => {
    expect(() => assertEvaluationInput(evaluationInput())).not.toThrow();
    expect(isEvaluationInput(evaluationInput())).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(() => assertEvaluationInput("nope")).toThrow(ValidationError);
    expect(() => assertEvaluationInput(null)).toThrow(ValidationError);
    expect(isEvaluationInput(7)).toBe(false);
  });

  it("reports every problem at once", () => {
    try {
      assertEvaluationInput({ executionId: "", output: () => 1, cancelled: "yes" });
      expect.unreachable("an incomplete input must throw");
    } catch (error) {
      const message = (error as ValidationError).message;
      expect(message).toContain("executionId must be a non-empty string");
      expect(message).toContain("output must be JSON-safe or null");
      expect(message).toContain("cancelled must be a boolean");
      expect(message).toContain("toolResults must be an array");
      // The message names fields; it never echoes the offending value.
      expect(message).not.toContain("yes");
    }
  });

  it("rejects a bad usage summary, latency, policy outcome and tool result", () => {
    expect(() =>
      assertEvaluationInput(evaluationInput({ usage: { inputTokens: -1 } as never })),
    ).toThrow(ValidationError);
    expect(() => assertEvaluationInput(evaluationInput({ latencyMs: -5 }))).toThrow(
      ValidationError,
    );
    expect(() => assertEvaluationInput(evaluationInput({ latencyMs: Number.NaN }))).toThrow(
      ValidationError,
    );
    expect(() =>
      assertEvaluationInput(evaluationInput({ policyOutcome: "maybe" as never })),
    ).toThrow(ValidationError);
    expect(() =>
      assertEvaluationInput(evaluationInput({ toolResults: [{ name: "x" }] as never })),
    ).toThrow(ValidationError);
    expect(() =>
      assertEvaluationInput(evaluationInput({ failure: { code: "x" } as never })),
    ).toThrow(ValidationError);
    // Null is a legitimate value for every nullable fact.
    expect(() =>
      assertEvaluationInput(
        evaluationInput({
          usage: null,
          latencyMs: null,
          policyOutcome: null,
          failure: null,
          output: null,
          expected: null,
        }),
      ),
    ).not.toThrow();
  });

  it("bounds the tool result list", () => {
    const many = Array.from({ length: MAX_EVALUATED_TOOL_RESULTS + 1 }, () => toolResult());
    expect(() => assertEvaluationInput(evaluationInput({ toolResults: many }))).toThrow(/maximum/);
    expect(() =>
      assertEvaluationInput(
        evaluationInput({ toolResults: many.slice(0, MAX_EVALUATED_TOOL_RESULTS) }),
      ),
    ).not.toThrow();
  });
});

describe("isPolicyOutcome", () => {
  it("recognizes the published outcomes only", () => {
    for (const outcome of ["allow", "constrain", "require_approval", "deny"]) {
      expect(isPolicyOutcome(outcome), outcome).toBe(true);
    }
    expect(isPolicyOutcome(null)).toBe(false);
    expect(isPolicyOutcome("permit")).toBe(false);
  });
});

describe("emptyUsage", () => {
  it("is the shared zero-usage record", () => {
    expect(emptyUsage().totalTokens).toBe(0);
    expect(emptyUsage().costMicro).toBeNull();
    expect(emptyUsage()).toBe(emptyUsage());
    expect(usage().totalTokens).toBe(1_000);
  });
});
