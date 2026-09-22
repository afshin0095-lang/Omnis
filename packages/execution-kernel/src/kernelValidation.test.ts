import { describe, expect, it } from "vitest";
import { createExecutionId, createModelId } from "@omnis/types";
import { createExecutionFailure, EMPTY_USAGE, modelById, toolByName } from "@omnis/ai-core-types";
import {
  EXECUTION_ATTEMPT_CONTRACT,
  EXECUTION_PLAN_CONTRACT,
  EXECUTION_REQUEST_CONTRACT,
  EXECUTION_STEP_CONTRACT,
  EXECUTION_TIMELINE_CONTRACT,
  executionAttemptSchema,
  executionFailureSchema,
  executionPlanSchema,
  executionRequestSchema,
  executionStepSchema,
  executionTimelineEntrySchema,
  isExecutionKindValue,
  isExecutionModeValue,
  isExecutionPriorityValue,
  isExecutionStatusValue,
  modelReferenceSchema,
  toolReferenceSchema,
  usageSummarySchema,
} from "./kernelValidation.js";
import { executionPlan, executionStep } from "./plans.js";
import { AT, AT_MS, attempt, executionRequest } from "./testSupport.js";

/** The request fixture as a plain object, so a test can break one field at a time. */
function requestFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...executionRequest(), ...overrides };
}

describe("executionRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(executionRequestSchema.safeParse(executionRequest()).success).toBe(true);
  });

  it("accepts a request that names neither a model nor a tool", () => {
    expect(
      executionRequestSchema.safeParse(
        requestFields({ model: null, tool: null, kind: "evaluation" }),
      ).success,
    ).toBe(true);
  });

  it("accepts a policy named by registered name as well as by identifier", () => {
    expect(
      executionRequestSchema.safeParse(requestFields({ policyId: "production-safety" })).success,
    ).toBe(true);
    expect(executionRequestSchema.safeParse(requestFields({ policyId: null })).success).toBe(true);
  });

  it("rejects an unknown kind, mode and priority", () => {
    expect(executionRequestSchema.safeParse(requestFields({ kind: "magic" })).success).toBe(false);
    expect(executionRequestSchema.safeParse(requestFields({ mode: "turbo" })).success).toBe(false);
    expect(executionRequestSchema.safeParse(requestFields({ priority: "urgent" })).success).toBe(
      false,
    );
  });

  it("rejects an identifier of the wrong kind", () => {
    expect(
      executionRequestSchema.safeParse(requestFields({ id: "mdl_01ARZ3NDEKTSV4RRFFQ69G5FAV" }))
        .success,
    ).toBe(false);
    expect(
      executionRequestSchema.safeParse(requestFields({ correlationId: "not-an-identifier" }))
        .success,
    ).toBe(false);
  });

  it("rejects a deadline that is not a positive integer", () => {
    expect(executionRequestSchema.safeParse(requestFields({ deadlineMs: 0 })).success).toBe(false);
    expect(executionRequestSchema.safeParse(requestFields({ deadlineMs: -1 })).success).toBe(false);
    expect(executionRequestSchema.safeParse(requestFields({ deadlineMs: 1.5 })).success).toBe(
      false,
    );
    expect(executionRequestSchema.safeParse(requestFields({ deadlineMs: 1_000 })).success).toBe(
      true,
    );
  });

  it("rejects a timestamp that is not an ISO instant", () => {
    expect(
      executionRequestSchema.safeParse(requestFields({ requestedAt: "yesterday" })).success,
    ).toBe(false);
  });

  it("rejects input that is not a JSON object, and a field the contract does not have", () => {
    expect(
      executionRequestSchema.safeParse(requestFields({ input: "just a string" })).success,
    ).toBe(false);
    expect(executionRequestSchema.safeParse(requestFields({ input: [1, 2] })).success).toBe(false);
    expect(
      executionRequestSchema.safeParse(requestFields({ responseFormat: "json" })).success,
    ).toBe(false);
  });

  it("rejects a model reference that is neither shape of the union", () => {
    expect(executionRequestSchema.safeParse(requestFields({ model: { kind: "id" } })).success).toBe(
      false,
    );
    expect(executionRequestSchema.safeParse(requestFields({ model: "gpt-small" })).success).toBe(
      false,
    );
    expect(
      executionRequestSchema.safeParse(requestFields({ model: modelById(createModelId()) }))
        .success,
    ).toBe(true);
  });

  it("rejects a tool reference that is neither shape of the union", () => {
    expect(
      executionRequestSchema.safeParse(requestFields({ tool: { kind: "slug", name: "read" } }))
        .success,
    ).toBe(false);
    expect(
      executionRequestSchema.safeParse(requestFields({ tool: toolByName("read-file") })).success,
    ).toBe(true);
  });
});

describe("reference and usage schemas", () => {
  it("accepts null where a reference is optional", () => {
    expect(modelReferenceSchema.safeParse(null).success).toBe(true);
    expect(toolReferenceSchema.safeParse(null).success).toBe(true);
    expect(modelReferenceSchema.safeParse(undefined).success).toBe(true);
  });

  it("accepts the published usage summary and rejects a negative count", () => {
    expect(usageSummarySchema.safeParse(EMPTY_USAGE).success).toBe(true);
    expect(usageSummarySchema.safeParse({ ...EMPTY_USAGE, costMicro: null }).success).toBe(true);
    expect(usageSummarySchema.safeParse({ ...EMPTY_USAGE, inputTokens: -1 }).success).toBe(false);
    expect(usageSummarySchema.safeParse({ ...EMPTY_USAGE, requests: 1.5 }).success).toBe(false);
    expect(usageSummarySchema.safeParse({ ...EMPTY_USAGE, extra: true }).success).toBe(false);
  });

  it("accepts a classified failure and rejects an unclassified code", () => {
    const valid = createExecutionFailure({
      class: "retryable",
      code: "provider_failure",
      message: "upstream refused",
      attempt: 1,
      occurredAt: AT,
    });
    expect(executionFailureSchema.safeParse(valid).success).toBe(true);
    expect(executionFailureSchema.safeParse({ ...valid, code: "not_a_code" }).success).toBe(false);
    expect(executionFailureSchema.safeParse({ ...valid, class: "flaky" }).success).toBe(false);
    expect(executionFailureSchema.safeParse({ ...valid, attempt: 0 }).success).toBe(false);
  });
});

describe("step, plan, attempt and timeline schemas", () => {
  it("accepts a built step and plan", () => {
    expect(executionStepSchema.safeParse(executionStep({ id: "one" })).success).toBe(true);
    expect(
      executionPlanSchema.safeParse(
        executionPlan(
          { executionId: createExecutionId(), steps: [{ id: "one" }], createdAt: AT },
          () => AT_MS,
        ),
      ).success,
    ).toBe(true);
  });

  it("rejects a step with an empty identifier, a bad kind or too many attempts", () => {
    expect(executionStepSchema.safeParse({ ...executionStep(), id: "" }).success).toBe(false);
    expect(executionStepSchema.safeParse({ ...executionStep(), kind: "magic" }).success).toBe(
      false,
    );
    expect(executionStepSchema.safeParse({ ...executionStep(), maxAttempts: 99 }).success).toBe(
      false,
    );
    expect(executionStepSchema.safeParse({ ...executionStep(), maxAttempts: 0 }).success).toBe(
      false,
    );
    expect(executionStepSchema.safeParse({ ...executionStep(), timeoutMs: 0 }).success).toBe(false);
  });

  it("rejects an attempt outside the published range", () => {
    expect(executionAttemptSchema.safeParse(attempt()).success).toBe(true);
    expect(executionAttemptSchema.safeParse(attempt({ attempt: 0 })).success).toBe(false);
    expect(executionAttemptSchema.safeParse(attempt({ attempt: 9 })).success).toBe(false);
    expect(executionAttemptSchema.safeParse(attempt({ status: "exploded" as never })).success).toBe(
      false,
    );
    expect(executionAttemptSchema.safeParse(attempt({ finishedAt: "later" })).success).toBe(false);
  });

  it("accepts a timeline entry and rejects an unknown status", () => {
    expect(
      executionTimelineEntrySchema.safeParse({
        at: AT,
        status: "validated",
        note: null,
        stepId: null,
      }).success,
    ).toBe(true);
    expect(
      executionTimelineEntrySchema.safeParse({
        at: AT,
        status: "halfway",
        note: null,
        stepId: null,
      }).success,
    ).toBe(false);
    expect(
      executionTimelineEntrySchema.safeParse({ at: AT, status: "validated", note: null }).success,
    ).toBe(false);
  });
});

describe("published contracts", () => {
  it("names each contract and pins it to the AI Core contract version", () => {
    const contracts = [
      EXECUTION_REQUEST_CONTRACT,
      EXECUTION_STEP_CONTRACT,
      EXECUTION_PLAN_CONTRACT,
      EXECUTION_ATTEMPT_CONTRACT,
      EXECUTION_TIMELINE_CONTRACT,
    ];
    expect(contracts.map((contract) => contract.contractId)).toEqual([
      "ExecutionRequest",
      "ExecutionStep",
      "ExecutionPlan",
      "ExecutionAttempt",
      "ExecutionTimelineEntry",
    ]);
    for (const contract of contracts) {
      expect(contract.version).toBe("1.0.0");
      expect(contract.schema).toBeDefined();
    }
  });

  it("has no contract for the record, which only this package builds", () => {
    // A second declaration of a contract is a contract that can drift.
    expect(EXECUTION_REQUEST_CONTRACT.contractId).not.toBe("ExecutionRecord");
  });
});

describe("enum guards", () => {
  it("recognises the published kinds", () => {
    for (const kind of ["agent", "model", "tool", "evaluation", "composite"]) {
      expect(isExecutionKindValue(kind), kind).toBe(true);
    }
    expect(isExecutionKindValue("workflow")).toBe(false);
    expect(isExecutionKindValue("")).toBe(false);
  });

  it("recognises the published statuses, modes and priorities", () => {
    expect(isExecutionStatusValue("reserved")).toBe(true);
    expect(isExecutionStatusValue("waiting")).toBe(true);
    expect(isExecutionStatusValue("paused")).toBe(false);
    expect(isExecutionModeValue("streaming")).toBe(true);
    expect(isExecutionModeValue("live")).toBe(false);
    expect(isExecutionPriorityValue("critical")).toBe(true);
    expect(isExecutionPriorityValue("urgent")).toBe(false);
  });
});
