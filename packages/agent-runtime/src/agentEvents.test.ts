/**
 * What the runtime tells the rest of the platform about a run.
 *
 * These tests assert three properties that matter more than any single field: the
 * payloads satisfy the event contracts the registry publishes (a real bus validates
 * every one), the payloads are JSON-safe strings and numbers rather than branded
 * objects that only survive in-process, and a bus that refuses an event cannot change
 * the outcome of the run that produced it.
 */

import { describe, expect, it } from "vitest";
import { createAgentId, createExecutionId, createModelId, createToolId } from "@omnis/types";
import { assertJsonSafe, createExecutionFailure, EMPTY_USAGE } from "@omnis/ai-core-types";
import type { ExecutionAttempt, ExecutionStep } from "@omnis/ai-core-types";
import { AI_EVENT_TYPES } from "@omnis/events";
import type { EventBus } from "@omnis/events";
import { createAgentEventPublisher, NOOP_AGENT_EVENT_PUBLISHER } from "./agentEvents.js";
import type { AgentStateChangeFact } from "./agentEvents.js";
import { AT, busFixture } from "./testSupport.js";

const executionId = createExecutionId();
const agentId = createAgentId();

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return Object.freeze({
    id: "answer",
    name: "Assistant answers",
    kind: "model",
    dependsOn: Object.freeze([]),
    timeoutMs: 5_000,
    maxAttempts: 2,
    optional: false,
    input: Object.freeze({ goal: "summarise" }),
    modelId: createModelId(),
    providerId: null,
    toolId: null,
    metadata: Object.freeze({}),
    ...overrides,
  });
}

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return Object.freeze({
    stepId: "answer",
    kind: "model",
    attempt: 1,
    status: "succeeded",
    startedAt: AT,
    finishedAt: AT,
    durationMs: 120,
    failure: null,
    usage: Object.freeze({
      ...EMPTY_USAGE,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costMicro: 450,
      requests: 1,
    }),
    modelId: createModelId(),
    providerId: null,
    toolId: createToolId(),
    metadata: Object.freeze({}),
    ...overrides,
  });
}

function stateChange(overrides: Partial<AgentStateChangeFact> = {}): AgentStateChangeFact {
  return {
    executionId,
    agentId,
    from: "ready",
    to: "running",
    waitingOn: null,
    reason: null,
    changedAt: AT,
    ...overrides,
  };
}

/** A bus that fails synchronously, for testing that a publish failure stays contained. */
function throwingBus(reason: string): EventBus {
  return {
    publish() {
      throw new Error(reason);
    },
  } as unknown as EventBus;
}

describe("publishing a state change", () => {
  it("publishes the transition, the run it belongs to, and what it is waiting on", () => {
    const fixture = busFixture();
    fixture.publisher.stateChanged(
      stateChange({ to: "waiting", waitingOn: "approval", reason: "a human must approve" }),
    );

    expect(fixture.published).toHaveLength(1);
    const event = fixture.published[0];
    expect(event?.type).toBe(AI_EVENT_TYPES.agentStateChanged);
    expect(event?.payload).toMatchObject({
      executionId: String(executionId),
      agentId: String(agentId),
      from: "ready",
      to: "waiting",
      waitingOn: "approval",
      reason: "a human must approve",
      changedAt: AT,
    });
  });

  it("reports a lifecycle move that has no run as such, rather than inventing one", () => {
    const fixture = busFixture();
    fixture.publisher.stateChanged(
      stateChange({ executionId: null, from: "created", to: "ready" }),
    );
    expect(fixture.published[0]?.payload).toMatchObject({
      executionId: null,
      from: "created",
      to: "ready",
    });
  });

  it("publishes identifiers as strings, so the payload survives serialization", () => {
    const fixture = busFixture();
    fixture.publisher.stateChanged(stateChange());
    assertJsonSafe(fixture.published[0]?.payload, "agent event payload");
    expect(typeof (fixture.published[0]?.payload as { agentId: unknown }).agentId).toBe("string");
  });
});

describe("publishing step outcomes", () => {
  it("reports a succeeded step with its usage and duration", () => {
    const fixture = busFixture();
    fixture.publisher.stepCompleted(executionId, agentId, step(), attempt());

    expect(fixture.published[0]?.type).toBe(AI_EVENT_TYPES.agentStepCompleted);
    expect(fixture.published[0]?.payload).toMatchObject({
      executionId: String(executionId),
      agentId: String(agentId),
      stepId: "answer",
      stepName: "Assistant answers",
      stepKind: "model",
      attempt: 1,
      durationMs: 120,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costMicroUsd: 450,
    });
    assertJsonSafe(fixture.published[0]?.payload, "agent event payload");
  });

  it("reports a failed step with the failure's code, class and retryability", () => {
    const fixture = busFixture();
    fixture.publisher.stepFailed(
      executionId,
      agentId,
      step(),
      attempt({
        status: "failed",
        failure: createExecutionFailure({
          class: "deadline_exceeded",
          code: "timeout",
          message: "the provider did not answer",
          retryable: true,
        }),
      }),
    );

    expect(fixture.published[0]?.type).toBe(AI_EVENT_TYPES.agentStepFailed);
    expect(fixture.published[0]?.payload).toMatchObject({
      errorCode: "timeout",
      failureClass: "deadline_exceeded",
      errorMessage: "the provider did not answer",
      retryable: true,
      skipped: false,
      optional: false,
    });
  });

  it("says when a step was skipped, which is a different fact from a step that failed", () => {
    const fixture = busFixture();
    fixture.publisher.stepFailed(
      executionId,
      agentId,
      step({ optional: true }),
      attempt({ status: "skipped", failure: null }),
    );
    expect(fixture.published[0]?.payload).toMatchObject({
      skipped: true,
      optional: true,
      retryable: false,
    });
  });

  it("reports an unpriced call as an absent cost rather than as zero", () => {
    const fixture = busFixture();
    fixture.publisher.stepCompleted(
      executionId,
      agentId,
      step(),
      attempt({
        usage: Object.freeze({
          ...EMPTY_USAGE,
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          costMicro: null,
        }),
      }),
    );
    expect((fixture.published[0]?.payload as { costMicroUsd: unknown }).costMicroUsd).toBeNull();
  });

  it("carries a durationless attempt as zero rather than as null, because the field is a number", () => {
    const fixture = busFixture();
    fixture.publisher.stepCompleted(executionId, agentId, step(), attempt({ durationMs: null }));
    expect((fixture.published[0]?.payload as { durationMs: unknown }).durationMs).toBe(0);
  });
});

describe("when the bus refuses an event", () => {
  it("records the failure and lets the run continue", () => {
    const publisher = createAgentEventPublisher({
      bus: throwingBus("bus unavailable"),
      tenantId: busFixture().tenantId,
    });
    expect(() => publisher.stateChanged(stateChange())).not.toThrow();

    const failures = publisher.publishFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("bus unavailable");
    expect(failures[0]?.type).toBe(AI_EVENT_TYPES.agentStateChanged);
  });

  it("records a rejection from an asynchronous bus too, rather than leaving it unhandled", async () => {
    const bus = {
      publish: () => Promise.reject(new Error("subscriber refused")),
    } as unknown as EventBus;
    const publisher = createAgentEventPublisher({ bus, tenantId: busFixture().tenantId });
    publisher.stateChanged(stateChange());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publisher.publishFailures().map((failure) => failure.message)).toEqual([
      "subscriber refused",
    ]);
  });

  it("calls the publish-error hook, so an operator can see a broken bus", () => {
    const seen: string[] = [];
    const publisher = createAgentEventPublisher({
      bus: throwingBus("bus unavailable"),
      tenantId: busFixture().tenantId,
      onPublishError: (type) => seen.push(type),
    });
    publisher.stepCompleted(executionId, agentId, step(), attempt());
    expect(seen).toEqual([AI_EVENT_TYPES.agentStepCompleted]);
  });

  it("keeps only the most recent failures, because the list outlives every run", () => {
    const publisher = createAgentEventPublisher({
      bus: throwingBus("down"),
      tenantId: busFixture().tenantId,
      maxFailures: 2,
    });
    for (let index = 0; index < 5; index += 1) {
      publisher.stateChanged(stateChange({ reason: `failure ${String(index)}` }));
    }
    expect(publisher.publishFailures()).toHaveLength(2);
  });
});

describe("a runtime wired without a bus", () => {
  it("publishes nothing and records nothing", () => {
    expect(() => NOOP_AGENT_EVENT_PUBLISHER.stateChanged(stateChange())).not.toThrow();
    expect(() =>
      NOOP_AGENT_EVENT_PUBLISHER.stepCompleted(executionId, agentId, step(), attempt()),
    ).not.toThrow();
    expect(() =>
      NOOP_AGENT_EVENT_PUBLISHER.stepFailed(executionId, agentId, step(), attempt()),
    ).not.toThrow();
    expect(NOOP_AGENT_EVENT_PUBLISHER.publishFailures()).toEqual([]);
  });
});
