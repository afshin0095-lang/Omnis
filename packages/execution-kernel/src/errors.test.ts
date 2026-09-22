import { describe, expect, it } from "vitest";
import { createExecutionId } from "@omnis/types";
import type { PlanIssue } from "@omnis/ai-core-types";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import {
  describePlanIssues,
  duplicateExecution,
  executionAlreadyTerminal,
  executionNotFound,
  invalidExecutionRequest,
  invalidExecutor,
  kernelCapacityExceeded,
  noStepExecutor,
  planRejected,
} from "./errors.js";

/** One plan issue, for the rejection suite. */
function issue(overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    code: "unknown_dependency",
    message: 'step "b" depends on unknown step "a"',
    stepId: "b",
    ...overrides,
  };
}

describe("executionNotFound", () => {
  it("names the missing execution and the registry that looked for it", () => {
    const executionId = createExecutionId();
    const error = executionNotFound(executionId);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("not_found");
    expect(error.resourceType).toBe("execution");
    expect(error.resourceId).toBe(executionId);
    expect(error.message).toBe(`execution "${executionId}" was not found`);
    expect(error.retryable).toBe(false);
    expect(error.metadata).toMatchObject({ registry: "kernel", executionId });
  });
});

describe("duplicateExecution", () => {
  it("reports the conflict on the execution identifier", () => {
    const executionId = createExecutionId();
    const error = duplicateExecution(executionId);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("conflict");
    expect(error.conflict).toBe(`execution:${executionId}`);
    expect(error.message).toMatch(/already registered/);
    expect(error.retryable).toBe(false);
  });
});

describe("invalidExecutionRequest", () => {
  it("carries the reason the request was refused", () => {
    const error = invalidExecutionRequest(
      "kind is not one of the published values",
      createExecutionId(),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("validation_failed");
    expect(error.message).toBe(
      "execution request is invalid: kind is not one of the published values",
    );
    expect(error.retryable).toBe(false);
  });

  it("works without an identifier, for a request too malformed to name", () => {
    const error = invalidExecutionRequest("missing identifier");
    expect(error.metadata["executionId"]).toBeNull();
    expect(error.metadata["registry"]).toBe("kernel");
  });
});

describe("planRejected", () => {
  it("turns every issue into a validation issue pointing at its step", () => {
    const error = planRejected(
      [
        issue(),
        issue({ code: "duplicate_step_id", message: 'duplicate step identifier "b"', stepId: "b" }),
      ],
      createExecutionId(),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toMatchObject({ path: "plan.steps.b", code: "unknown_dependency" });
    expect(error.issues[1]).toMatchObject({ path: "plan.steps.b", code: "duplicate_step_id" });
    expect(error.message).toMatch(/unknown step "a"/);
    expect(error.message).toMatch(/duplicate step identifier "b"/);
  });

  it("points a plan-wide issue at the plan rather than at a step", () => {
    const error = planRejected([
      issue({ code: "too_many_steps", stepId: null, message: "plan declares 65 steps" }),
    ]);
    expect(error.issues[0]?.path).toBe("plan");
    expect(error.message).toMatch(/65 steps/);
  });
});

describe("describePlanIssues", () => {
  it("says so when there is nothing wrong, rather than returning an empty string", () => {
    expect(describePlanIssues([])).toBe("no issues");
  });

  it("joins every issue with its step, so one message explains the whole rejection", () => {
    const described = describePlanIssues([
      issue({ stepId: null, message: "plan declares 65 steps" }),
      issue(),
    ]);
    expect(described).toBe('plan declares 65 steps; b: step "b" depends on unknown step "a"');
  });
});

describe("invalidExecutor", () => {
  it("names the kind and the reason", () => {
    const error = invalidExecutor("model", "execute must be a function");
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe(
      'step executor for kind "model" is invalid: execute must be a function',
    );
    expect(error.metadata).toMatchObject({ registry: "kernel", kind: "model" });
    expect(error.retryable).toBe(false);
  });
});

describe("noStepExecutor", () => {
  it("names the kind, the step and the execution, which is what an operator needs", () => {
    const executionId = createExecutionId();
    const error = noStepExecutor("tool", "fetch", executionId);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('no step executor is registered for kind "tool" (step "fetch")');
    expect(error.metadata).toMatchObject({
      registry: "kernel",
      kind: "tool",
      stepId: "fetch",
      executionId,
    });
  });
});

describe("executionAlreadyTerminal", () => {
  it("reports the state the execution is stuck in", () => {
    const executionId = createExecutionId();
    const error = executionAlreadyTerminal(executionId, "succeeded");
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe(`execution ${executionId} is already succeeded`);
    expect(error.metadata).toMatchObject({ status: "succeeded", executionId });
    expect(error.retryable).toBe(false);
  });
});

describe("kernelCapacityExceeded", () => {
  it("reports the configured limit", () => {
    const error = kernelCapacityExceeded(8);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.conflict).toBe("execution:capacity");
    expect(error.message).toBe("kernel holds at most 8 execution records");
    expect(error.metadata).toMatchObject({ maxExecutions: 8 });
  });
});

describe("error hygiene", () => {
  it("never puts request input or model output into an error message", () => {
    const messages = [
      executionNotFound(createExecutionId()).message,
      duplicateExecution(createExecutionId()).message,
      invalidExecutionRequest("input is not a JSON object").message,
      planRejected([issue()]).message,
      invalidExecutor("model", "execute must be a function").message,
      noStepExecutor("tool", "fetch", createExecutionId()).message,
      executionAlreadyTerminal(createExecutionId(), "failed").message,
      kernelCapacityExceeded(16).message,
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/sk-|Bearer |api[_-]?key/i);
      expect(message.length).toBeLessThan(400);
    }
  });

  it("marks every one of them non-retryable, because each is a caller or configuration fault", () => {
    expect(executionNotFound(createExecutionId()).retryable).toBe(false);
    expect(invalidExecutor("model", "no function").retryable).toBe(false);
    expect(kernelCapacityExceeded(1).retryable).toBe(false);
  });
});
