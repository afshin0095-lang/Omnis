/**
 * The runtime's typed errors.
 *
 * What these tests check is not that a message is pleasant but that a caller can act
 * on one: the right class, a stable code, the identifier that was missing or refusing,
 * and — for a lifecycle move — the moves that were actually legal. A message that says
 * "invalid" teaches a retry loop nothing.
 */

import { describe, expect, it } from "vitest";
import { createAgentId, createExecutionId } from "@omnis/types";
import { agentById, agentBySlug } from "@omnis/ai-core-types";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import {
  agentCannotPauseWhileRunning,
  agentInstanceCapacityExceeded,
  agentInstanceNotFound,
  agentNotFound,
  agentNotExecutable,
  agentPlanRejected,
  duplicateAgent,
  illegalAgentStateTransition,
  illegalAgentStatusTransition,
  invalidAgentRunInput,
} from "./errors.js";

describe("a missing agent", () => {
  it("says what kind of thing is missing and which reference named it", () => {
    const agentId = createAgentId();
    const error = agentNotFound(agentById(agentId));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("not_found");
    expect(error.resourceType).toBe("agent");
    expect(error.resourceId).toContain(String(agentId));
    expect(error.retryable).toBe(false);
  });

  it("describes a slug reference as a slug, so the caller checks the right registry", () => {
    const error = agentNotFound(agentBySlug("assistant"));
    expect(error.resourceId).toContain("assistant");
    expect(error.metadata).toMatchObject({ reference: expect.stringContaining("assistant") });
  });

  it("distinguishes a missing agent from a missing run", () => {
    const executionId = createExecutionId();
    const error = agentInstanceNotFound(executionId);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.resourceType).toBe("agent-instance");
    expect(error.resourceId).toBe(String(executionId));
    expect(error.metadata).toMatchObject({ executionId: String(executionId) });
  });
});

describe("a conflicting operation", () => {
  it("names the conflicting key on a duplicate registration", () => {
    const error = duplicateAgent("assistant", "another agent already uses this slug");

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("conflict");
    // The conflicting key is namespaced, so a slug collision can never be confused
    // with a model or tool collision carrying the same string.
    expect(error.conflict).toBe("agent:assistant");
    expect(error.message).toContain("another agent already uses this slug");
  });

  it("lists the legal targets of an illegal state transition", () => {
    const agentId = createAgentId();
    const error = illegalAgentStateTransition(agentId, "completed", "running", []);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain(String(agentId));
    expect(error.message).toContain("completed");
    expect(error.message).toContain("running");
    // A terminal state has no legal targets, and the message must say so rather than
    // leaving the caller to guess that an empty list means "anything".
    expect(error.message.toLowerCase()).toContain("terminal");
    expect(error.metadata).toMatchObject({ from: "completed", to: "running", allowed: [] });
  });

  it("lists the legal targets of an illegal status transition", () => {
    const agentId = createAgentId();
    const error = illegalAgentStatusTransition(agentId, "retired", "active", []);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain("retired");
    expect(error.message).toContain("active");
    expect(error.metadata).toMatchObject({ from: "retired", to: "active" });
  });

  it("says which status made an agent unrunnable", () => {
    const agentId = createAgentId();
    const error = agentNotExecutable(agentId, "assistant", "draft");

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain("draft");
    expect(error.message).toContain("assistant");
    expect(error.retryable).toBe(false);
  });

  it("explains why a run cannot be paused, instead of reporting a generic refusal", () => {
    const executionId = createExecutionId();
    const error = agentCannotPauseWhileRunning(executionId, "running");

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain(String(executionId));
    // The message offers the move that would work, rather than only refusing this one.
    expect(error.message).toContain("cancel it instead");
    expect(error.metadata).toMatchObject({ state: "running" });
  });

  it("reports the instance limit it hit", () => {
    const error = agentInstanceCapacityExceeded(64);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain("64");
  });
});

describe("a malformed plan or run input", () => {
  it("carries every reason a plan was rejected", () => {
    const agentId = createAgentId();
    const error = agentPlanRejected(agentId, ["step 3 exceeds maxSteps", "tool search is denied"]);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("step 3 exceeds maxSteps");
    expect(error.message).toContain("tool search is denied");
    expect(error.metadata).toMatchObject({
      reasons: ["step 3 exceeds maxSteps", "tool search is denied"],
    });
  });

  it("keeps the caller's own words in a run input error", () => {
    const error = invalidAgentRunInput("goal is required");
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain("goal is required");
  });
});
