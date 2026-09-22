import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ConfigurationError,
  ContractError,
  ExecutionError,
  InfrastructureError,
  NotFoundError,
  NotImplementedError,
  PolicyViolationError,
  ProviderError,
  TimeoutError,
  ValidationError,
} from "@omnis/errors";
import {
  createBudgetId,
  createExecutionId,
  createModelId,
  createProviderId,
  createToolId,
} from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import {
  approvalRequiredError,
  budgetExhaustedError,
  classifyError,
  createExecutionFailure,
  deadlineExceededError,
  describeFailure,
  duplicateRegistrationError,
  executionCancelledError,
  failureFromError,
  illegalAgentTransitionError,
  isGovernanceFailureClass,
  isRetryableFailureClass,
  isTerminalIntentFailureClass,
  modelNotFoundError,
  modelBySlug,
  policyDeniedError,
  providerInvocationError,
  stepTimeoutError,
  toolExecutionError,
} from "./index.js";

describe("classifyError", () => {
  it("maps governance errors to policy_blocked", () => {
    expect(classifyError(new PolicyViolationError("prod-policy", "writes are denied"))).toBe(
      "policy_blocked",
    );
    expect(classifyError(new AuthorizationError("missing scope"))).toBe("policy_blocked");
    expect(classifyError(new AuthenticationError("bad credential"))).toBe("policy_blocked");
  });

  it("maps contract and configuration errors to validation", () => {
    expect(classifyError(new ValidationError("bad input"))).toBe("validation");
    expect(classifyError(new ContractError("agent-state-machine", "bad transition"))).toBe(
      "validation",
    );
    expect(classifyError(new ConfigurationError("bad config"))).toBe("validation");
  });

  it("maps provider errors to provider_failure", () => {
    expect(classifyError(new ProviderError("openai-compatible", "502 from upstream"))).toBe(
      "provider_failure",
    );
  });

  it("maps a timeout to deadline_exceeded", () => {
    expect(classifyError(new TimeoutError("too slow"))).toBe("deadline_exceeded");
  });

  it("maps structural errors to non_retryable", () => {
    expect(classifyError(new NotFoundError("model", "mdl_x"))).toBe("non_retryable");
    expect(classifyError(new ConflictError("model:slug", "duplicate"))).toBe("non_retryable");
    expect(classifyError(new NotImplementedError("video generation"))).toBe("non_retryable");
  });

  it("lets the error's own retryability decide infrastructure and execution failures", () => {
    expect(classifyError(new InfrastructureError("queue", "connection reset"))).toBe("retryable");
    expect(classifyError(new ExecutionError("step exploded"))).toBe("retryable");
    expect(classifyError(new ExecutionError("step exploded", { retryable: false }))).toBe(
      "non_retryable",
    );
    expect(
      classifyError(new InfrastructureError("queue", "no such queue", { retryable: false })),
    ).toBe("non_retryable");
  });

  it("honors an explicit AI Core failure class over the error code", () => {
    // An `execution_failed` code cannot express cancellation; the marker can.
    const cancelled = new ExecutionError("stopped by operator", {
      metadata: { "omnis.failure.class": "cancelled" },
    });
    expect(classifyError(cancelled)).toBe("cancelled");

    const budget = new ExecutionError("no allowance left", {
      metadata: { "omnis.budget.blocked": true },
    });
    expect(classifyError(budget)).toBe("budget_blocked");
  });

  it("ignores an unrecognized failure-class marker rather than trusting it", () => {
    const bogus = new ExecutionError("odd", {
      metadata: { "omnis.failure.class": "probably_fine" },
    });
    expect(classifyError(bogus)).toBe("retryable");
  });

  it("classifies non-OMNIS values conservatively", () => {
    expect(classifyError(new Error("plain error"))).toBe("unknown");
    expect(classifyError("a string")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
    expect(classifyError({ code: "provider_failure" })).toBe("unknown");

    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyError(abort)).toBe("cancelled");
  });
});

describe("createExecutionFailure", () => {
  it("freezes the record and defaults retryability from the class", () => {
    const failure = createExecutionFailure({
      class: "provider_failure",
      code: "provider_failure",
      message: "upstream 503",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure.retryable).toBe(true);
    expect(failure.attempt).toBe(1);
    expect(failure.retryAfterMs).toBeNull();
    expect(failure.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("lets an explicit retryable override the class default", () => {
    const failure = createExecutionFailure({
      class: "provider_failure",
      code: "provider_failure",
      message: "malformed response",
      retryable: false,
    });
    expect(failure.retryable).toBe(false);
  });

  it("never treats governance or cancellation classes as retryable", () => {
    for (const failureClass of [
      "policy_blocked",
      "budget_blocked",
      "cancelled",
      "deadline_exceeded",
      "unknown",
    ] as const) {
      expect(isRetryableFailureClass(failureClass), failureClass).toBe(false);
    }
    expect(isRetryableFailureClass("retryable")).toBe(true);
    expect(isRetryableFailureClass("provider_failure")).toBe(true);
  });

  it("rejects details that would not survive serialization", () => {
    // Both cases are *type-valid* `JsonValue`, which is exactly why the runtime guard
    // exists: `NaN` serializes to `null`, and a cycle makes `JSON.stringify` throw only
    // after the expensive work was done.
    expect(() =>
      createExecutionFailure({
        class: "tool_failure",
        code: "execution_failed",
        message: "tool broke",
        details: { ratio: Number.NaN },
      }),
    ).toThrow(ValidationError);

    const cyclic: Record<string, JsonValue> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(() =>
      createExecutionFailure({
        class: "tool_failure",
        code: "execution_failed",
        message: "tool broke",
        details: cyclic,
      }),
    ).toThrow(ValidationError);
  });

  it("records the identifiers it is given", () => {
    const executionId = createExecutionId();
    const modelId = createModelId();
    const providerId = createProviderId();
    const toolId = createToolId();
    const failure = createExecutionFailure({
      class: "retryable",
      code: "infrastructure_failure",
      message: "transient",
      executionId,
      modelId,
      providerId,
      toolId,
      stepId: "step-1",
      attempt: 2,
    });
    expect(failure.executionId).toBe(executionId);
    expect(failure.modelId).toBe(modelId);
    expect(failure.providerId).toBe(providerId);
    expect(failure.toolId).toBe(toolId);
    expect(failure.stepId).toBe("step-1");
    expect(failure.attempt).toBe(2);
  });
});

describe("failureFromError", () => {
  it("carries the class, code and message of an OMNIS error", () => {
    const failure = failureFromError(new TimeoutError("deadline elapsed"), {
      attempt: 3,
      stepId: "model-call",
    });
    expect(failure.class).toBe("deadline_exceeded");
    expect(failure.code).toBe("timeout");
    expect(failure.message).toBe("deadline elapsed");
    expect(failure.attempt).toBe(3);
    expect(failure.stepId).toBe("model-call");
    // A deadline is not recoverable by trying again inside the same deadline.
    expect(failure.retryable).toBe(false);
  });

  it("keeps retryability only when the class also allows it", () => {
    const retryable = failureFromError(new InfrastructureError("queue", "reset"));
    expect(retryable.retryable).toBe(true);

    const denied = failureFromError(new AuthorizationError("denied"));
    expect(denied.class).toBe("policy_blocked");
    expect(denied.retryable).toBe(false);
  });

  it("classifies an unknown thrown value as unknown and non-retryable", () => {
    const failure = failureFromError("something threw a string");
    expect(failure.class).toBe("unknown");
    expect(failure.code).toBe("unknown");
    expect(failure.message).toBe("something threw a string");
    expect(failure.retryable).toBe(false);
    expect(failure.details).toEqual({});
  });
});

describe("typed error factories", () => {
  it("round-trips every AI Core factory through classifyError", () => {
    const executionId = createExecutionId();
    expect(classifyError(modelNotFoundError(modelBySlug("missing")))).toBe("non_retryable");
    expect(classifyError(providerInvocationError(createProviderId(), "upstream failed"))).toBe(
      "provider_failure",
    );
    expect(
      classifyError(policyDeniedError("prod-policy", "deny-writes", "writes are denied")),
    ).toBe("policy_blocked");
    expect(
      classifyError(approvalRequiredError("prod-policy", "needs-human", "critical risk")),
    ).toBe("policy_blocked");
    expect(classifyError(budgetExhaustedError(createBudgetId(), "tokens", 5000, 100))).toBe(
      "budget_blocked",
    );
    expect(classifyError(executionCancelledError(executionId, "operator"))).toBe("cancelled");
    expect(classifyError(deadlineExceededError(executionId, 30_000))).toBe("deadline_exceeded");
    expect(classifyError(stepTimeoutError("step-1", 5_000))).toBe("deadline_exceeded");
    expect(classifyError(toolExecutionError(createToolId(), "handler threw"))).toBe("tool_failure");
    expect(classifyError(illegalAgentTransitionError("completed", "running", "agt_x"))).toBe(
      "validation",
    );
    expect(classifyError(duplicateRegistrationError("model", "reasoning-large"))).toBe(
      "non_retryable",
    );
  });

  it("marks approval-required decisions distinctly from denials in metadata", () => {
    const approval = approvalRequiredError("prod-policy", "needs-human", "critical risk");
    expect(approval.metadata["approvalRequired"]).toBe(true);
    expect(approval.retryable).toBe(false);
  });

  it("gives budget failures the dimension and amounts needed to explain the block", () => {
    const error = budgetExhaustedError(createBudgetId(), "cost_micro_usd", 5_000_000, 1_000_000);
    expect(error.metadata["dimension"]).toBe("cost_micro_usd");
    expect(error.metadata["requested"]).toBe(5_000_000);
    expect(error.metadata["available"]).toBe(1_000_000);
    expect(error.retryable).toBe(false);
  });

  it("keeps a provider invocation retryable by default but allows an explicit override", () => {
    expect(providerInvocationError(createProviderId(), "429").retryable).toBe(true);
    expect(
      providerInvocationError(createProviderId(), "401 unauthorized", { retryable: false })
        .retryable,
    ).toBe(false);
  });
});

describe("failure class predicates", () => {
  it("separates governance blocks from caller intent", () => {
    expect(isGovernanceFailureClass("policy_blocked")).toBe(true);
    expect(isGovernanceFailureClass("budget_blocked")).toBe(true);
    expect(isGovernanceFailureClass("cancelled")).toBe(false);

    expect(isTerminalIntentFailureClass("cancelled")).toBe(true);
    expect(isTerminalIntentFailureClass("deadline_exceeded")).toBe(true);
    expect(isTerminalIntentFailureClass("policy_blocked")).toBe(false);
  });
});

describe("describeFailure", () => {
  it("renders class, code and message on one line", () => {
    const failure = createExecutionFailure({
      class: "provider_failure",
      code: "provider_failure",
      message: "upstream unavailable",
    });
    expect(describeFailure(failure)).toBe(
      "provider_failure(provider_failure): upstream unavailable",
    );
  });
});
