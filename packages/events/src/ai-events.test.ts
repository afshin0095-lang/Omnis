/**
 * Tests for the `ai.*` vocabulary, its payload contracts and its registration.
 *
 * What is pinned here is the part a consumer is allowed to rely on: that every
 * declared type has exactly one definition owned by AI Core at the current
 * contract version, that each payload schema accepts a realistic payload and
 * rejects the near-misses that matter, and that no payload can carry model or
 * tool *content* — identifiers, counters and classifications only.
 *
 * The cross-package half of this guarantee (that the enumerations restated in
 * `ai-payloads.ts` still equal the ones `@omnis/ai-core-types` declares) lives in
 * `tests/contract/ai-core-events.test.ts`, because it needs both packages and
 * this one must not depend on a domain package.
 */

import { CONTRACT_VERSION, createEvent } from "@omnis/contracts";
import type { EventEnvelope } from "@omnis/contracts";
import {
  createAgentId,
  createBudgetId,
  createEvaluationId,
  createExecutionId,
  createModelId,
  createPolicyId,
  createProviderId,
  createReservationId,
  createTenantId,
  createToolId,
  eventNamespaceOf,
  parseEventType,
} from "@omnis/types";
import type { EventType, JsonObject, JsonValue } from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  AI_CORE_EVENT_DEFINITIONS,
  AI_EVENT_TYPES,
  AI_EVENT_TYPE_LIST,
  AI_EVENT_TYPES_WITHOUT_DEFINITIONS,
  ALL_EVENT_TYPES,
  createEventRegistry,
  createInMemoryEventBus,
  EVENT_OWNERS,
  EVENT_TYPES_WITHOUT_DEFINITIONS,
  PLATFORM_EVENT_DEFINITIONS,
  SPRINT0_EVENT_DEFINITIONS,
} from "./index.js";

const AT = "2026-01-01T00:00:00.000Z";

/** One valid payload per declared type, keyed by the event type name. */
function samples(): Readonly<Record<string, JsonObject>> {
  const executionId = String(createExecutionId());
  const modelId = String(createModelId());
  const providerId = String(createProviderId());
  const toolId = String(createToolId());
  const agentId = String(createAgentId());
  const policyId = String(createPolicyId());
  const budgetId = String(createBudgetId());
  const reservationId = String(createReservationId());
  const evaluationId = String(createEvaluationId());

  const usage = { inputTokens: 120, outputTokens: 340, totalTokens: 460, costMicroUsd: 46 };
  const failure = {
    errorCode: "provider_failure",
    failureClass: "provider_failure",
    errorMessage: "the provider closed the connection",
    retryable: true,
  };

  return {
    "ai.model.call.completed": {
      executionId,
      modelId,
      providerId,
      modelReference: "slug:gpt-class",
      durationMs: 812,
      stopReason: "stop",
      streamed: false,
      fallbacks: 1,
      ...usage,
    },
    "ai.model.call.failed": {
      executionId,
      modelId,
      providerId,
      modelReference: "slug:gpt-class",
      durationMs: 1_504,
      attempts: 3,
      fallbacks: 2,
      ...failure,
    },
    "ai.model.fallback.used": {
      executionId,
      fromModelId: modelId,
      fromProviderId: providerId,
      toModelId: String(createModelId()),
      toProviderId: String(createProviderId()),
      depth: 1,
      reason: "the provider returned a retryable failure",
      policyDriven: false,
    },
    "ai.model.retry.scheduled": {
      executionId,
      modelId,
      providerId,
      attempt: 1,
      nextAttempt: 2,
      delayMs: 250,
      errorCode: "provider_failure",
      failureClass: "retryable",
    },
    "ai.model.stream.started": { executionId, modelId, providerId },
    "ai.model.stream.completed": {
      executionId,
      modelId,
      providerId,
      durationMs: 2_310,
      stopReason: "stop",
      chunks: 48,
      ...usage,
    },
    "ai.model.stream.failed": {
      executionId,
      modelId,
      providerId,
      durationMs: 940,
      chunksEmitted: 12,
      abandoned: false,
      ...failure,
    },
    "ai.provider.health.recorded": {
      providerId,
      observation: "failure",
      state: "degraded",
      consecutiveSuccesses: 0,
      consecutiveFailures: 3,
      averageLatencyMs: 812.5,
      observedAt: AT,
    },
    "ai.provider.status.changed": {
      providerId,
      from: "ready",
      to: "degraded",
      reason: "three consecutive failures",
      changedAt: AT,
    },
    "ai.tool.call.completed": {
      executionId,
      toolId,
      agentId,
      riskLevel: "medium",
      durationMs: 42,
      outputBytes: 1_024,
      isErrorResult: false,
      approved: false,
    },
    "ai.tool.call.failed": {
      executionId,
      toolId,
      agentId,
      riskLevel: "high",
      durationMs: 5_001,
      timedOut: true,
      ...failure,
      errorCode: "timeout",
      failureClass: "deadline_exceeded",
    },
    "ai.tool.call.blocked": {
      executionId,
      toolId,
      agentId,
      riskLevel: "critical",
      blockedBy: "policy",
      policyId,
      reason: "the policy set denies this tool for this agent",
    },
    "ai.agent.state.changed": {
      executionId,
      agentId,
      from: "ready",
      to: "running",
      waitingOn: null,
      reason: null,
      changedAt: AT,
    },
    "ai.agent.step.completed": {
      executionId,
      agentId,
      stepId: "step-retrieve",
      stepName: "retrieve context",
      stepKind: "tool",
      attempt: 1,
      durationMs: 88,
      ...usage,
    },
    "ai.agent.step.failed": {
      executionId,
      agentId,
      stepId: "step-answer",
      stepName: "answer",
      stepKind: "model",
      attempt: 2,
      durationMs: 1_204,
      skipped: false,
      optional: false,
      ...failure,
    },
    "ai.policy.decision.recorded": {
      executionId,
      policyId,
      subject: `model:${modelId}`,
      outcome: "constrain",
      constraintKinds: ["max_output_tokens"],
      approvalRequired: false,
      reason: null,
      decidedAt: AT,
    },
    "ai.policy.violation.detected": {
      executionId,
      policyId,
      subject: `model:${modelId}`,
      constraintKind: "denied_models",
      refused: true,
      detail: "the model is denied for this tenant",
      detectedAt: AT,
    },
    "ai.budget.reserved": {
      executionId,
      budgetId,
      reservationId,
      window: "execution",
      holds: [{ dimension: "tokens", amount: 4_098 }],
      costMicroUsd: 410,
      reservedAt: AT,
    },
    "ai.budget.committed": { executionId, budgetId, reservationId, ...usage, committedAt: AT },
    "ai.budget.released": {
      executionId,
      budgetId,
      reservationId,
      reason: "the call was cancelled before any provider answered",
      releasedAt: AT,
    },
    "ai.budget.exceeded": {
      executionId,
      budgetId,
      dimension: "cost_micro_usd",
      window: "day",
      limit: 100_000,
      used: 99_800,
      requested: 410,
      refusedAt: AT,
    },
    "ai.evaluation.completed": {
      evaluationId,
      executionId,
      subject: "execution",
      verdict: "warn",
      overallScore: 0.82,
      dimensionsScored: 4,
      rulesApplied: 7,
      findings: 2,
      evaluatedAt: AT,
    },
  };
}

describe("the ai vocabulary", () => {
  it("declares twenty-two event types", () => {
    expect(AI_EVENT_TYPE_LIST).toHaveLength(22);
    expect(new Set(AI_EVENT_TYPE_LIST.map(String)).size).toBe(22);
    expect(Object.keys(AI_EVENT_TYPES)).toHaveLength(22);
  });

  it("places every type in the ai namespace and inside the event grammar", () => {
    const grammar = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
    for (const type of AI_EVENT_TYPE_LIST) {
      const name = String(type);
      expect(name.startsWith("ai."), name).toBe(true);
      expect(eventNamespaceOf(type), name).toBe("ai");
      expect(name, name).toMatch(grammar);
      expect(name.includes("_"), name).toBe(false);
    }
  });

  it("reads as facts that already happened, never as instructions", () => {
    for (const type of AI_EVENT_TYPE_LIST) {
      const verb = String(type).split(".").at(-1) as string;
      expect(["requested", "start", "run", "execute", "publish"], String(type)).not.toContain(verb);
    }
  });

  it("defers nothing, and says so explicitly", () => {
    expect(AI_EVENT_TYPES_WITHOUT_DEFINITIONS).toHaveLength(0);
    const deferred = new Set(EVENT_TYPES_WITHOUT_DEFINITIONS.map(String));
    for (const type of AI_EVENT_TYPE_LIST) {
      expect(deferred.has(String(type)), String(type)).toBe(false);
    }
  });

  it("joins the platform vocabulary without displacing Sprint 0", () => {
    for (const type of AI_EVENT_TYPE_LIST) {
      expect(ALL_EVENT_TYPES.map(String), String(type)).toContain(String(type));
    }
    expect(new Set(ALL_EVENT_TYPES.map(String)).size).toBe(ALL_EVENT_TYPES.length);
  });
});

describe("the ai definitions", () => {
  it("defines every declared type exactly once", () => {
    const defined = AI_CORE_EVENT_DEFINITIONS.map((definition) => String(definition.type));
    expect(new Set(defined).size).toBe(defined.length);
    expect([...defined].sort()).toEqual(AI_EVENT_TYPE_LIST.map(String).sort());
  });

  it("gives AI Core ownership of its own namespace", () => {
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      expect(definition.owner, String(definition.type)).toBe(EVENT_OWNERS.aiCore);
    }
  });

  it("pins every definition to the current contract version", () => {
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      expect(String(definition.version), String(definition.type)).toBe(String(CONTRACT_VERSION));
    }
  });

  it("uses only the two scopes the platform recognises, and both of them", () => {
    const scopes = new Set(AI_CORE_EVENT_DEFINITIONS.map((definition) => definition.scope));
    expect([...scopes].sort()).toEqual(["domain", "integration"]);
  });

  it("writes a summary a human can act on for every definition", () => {
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      expect(definition.summary.length, String(definition.type)).toBeGreaterThan(20);
      expect(definition.summary.endsWith("."), String(definition.type)).toBe(true);
    }
  });

  it("appends to the platform list rather than replacing it", () => {
    expect(PLATFORM_EVENT_DEFINITIONS).toHaveLength(
      SPRINT0_EVENT_DEFINITIONS.length + AI_CORE_EVENT_DEFINITIONS.length,
    );
    expect(PLATFORM_EVENT_DEFINITIONS.slice(SPRINT0_EVENT_DEFINITIONS.length)).toEqual(
      AI_CORE_EVENT_DEFINITIONS,
    );
  });
});

describe("the ai payload contracts", () => {
  const registry = createEventRegistry();
  registry.registerAll(PLATFORM_EVENT_DEFINITIONS);

  it("accepts a realistic payload for every declared type", () => {
    const all = samples();
    expect(Object.keys(all)).toHaveLength(22);
    for (const [name, payload] of Object.entries(all)) {
      const definition = registry.require(parseEventType(name));
      const result = definition.payloadSchema.safeParse(payload);
      const issues = result.success
        ? null
        : JSON.stringify((result as { error?: unknown }).error ?? null);
      expect(result.success, `${name}: ${String(issues)}`).toBe(true);
    }
  });

  it("survives a JSON round trip unchanged, so no key can silently disappear", () => {
    for (const [name, payload] of Object.entries(samples())) {
      const restored = JSON.parse(JSON.stringify(payload)) as JsonObject;
      expect(restored, name).toEqual(payload);
      for (const [key, value] of Object.entries(payload)) {
        expect(value === undefined, `${name}.${key}`).toBe(false);
      }
    }
  });

  it("carries no model or tool content, only identifiers, counters and classifications", () => {
    // The rule that keeps a broadcast event stream from becoming a copy of the
    // most sensitive store in the platform. A key that could hold a prompt, a
    // completion or a tool argument is refused by name.
    // `errorMessage`, `reason` and `detail` are platform-generated classifications and are allowed;
    // a key that would hold a prompt, a completion, a tool argument or a credential is not.
    const forbidden =
      /(?:^|_)(?:text|content|prompt|messages|body|completion|arguments|secret|transcript|response)(?:$|_)/i;
    for (const [name, payload] of Object.entries(samples())) {
      for (const key of Object.keys(payload)) {
        expect(forbidden.test(key), `${name}.${key}`).toBe(false);
      }
    }
  });

  it("refuses a payload that omits a required fact", () => {
    const definition = registry.require(AI_EVENT_TYPES.modelCallCompleted);
    const payload: Record<string, JsonValue> = {
      ...(samples()["ai.model.call.completed"] as JsonObject),
    };
    delete payload["providerId"];
    expect(definition.payloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses a stop reason outside the declared vocabulary", () => {
    const definition = registry.require(AI_EVENT_TYPES.modelCallCompleted);
    const payload = {
      ...(samples()["ai.model.call.completed"] as JsonObject),
      stopReason: "because",
    };
    expect(definition.payloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses a failure class outside the declared vocabulary", () => {
    const definition = registry.require(AI_EVENT_TYPES.modelCallFailed);
    const payload = {
      ...(samples()["ai.model.call.failed"] as JsonObject),
      failureClass: "mysterious",
    };
    expect(definition.payloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses a negative duration or a fractional token count", () => {
    const completed = registry.require(AI_EVENT_TYPES.modelCallCompleted);
    expect(
      completed.payloadSchema.safeParse({
        ...(samples()["ai.model.call.completed"] as JsonObject),
        durationMs: -1,
      }).success,
    ).toBe(false);
    expect(
      completed.payloadSchema.safeParse({
        ...(samples()["ai.model.call.completed"] as JsonObject),
        inputTokens: 1.5,
      }).success,
    ).toBe(false);
  });

  it("distinguishes an unpriced call from a free one", () => {
    // `costMicroUsd: null` asserts "not priced"; `0` would assert "free". Budget
    // enforcement depends on that difference, so both must be accepted and the
    // absence of the key must not be.
    const committed = registry.require(AI_EVENT_TYPES.budgetCommitted);
    const base = samples()["ai.budget.committed"] as JsonObject;
    expect(committed.payloadSchema.safeParse({ ...base, costMicroUsd: null }).success).toBe(true);
    expect(committed.payloadSchema.safeParse({ ...base, costMicroUsd: 0 }).success).toBe(true);
    const missing: Record<string, JsonValue> = { ...base };
    delete missing["costMicroUsd"];
    expect(committed.payloadSchema.safeParse(missing).success).toBe(false);
  });

  it("refuses an identifier of the wrong kind", () => {
    const definition = registry.require(AI_EVENT_TYPES.toolCallCompleted);
    const payload = {
      ...(samples()["ai.tool.call.completed"] as JsonObject),
      toolId: String(createModelId()),
    };
    expect(definition.payloadSchema.safeParse(payload).success).toBe(false);
  });

  it('allows the nulls that mean "there is none", and only those', () => {
    const failed = registry.require(AI_EVENT_TYPES.modelCallFailed);
    const base = samples()["ai.model.call.failed"] as JsonObject;
    expect(
      failed.payloadSchema.safeParse({ ...base, modelId: null, providerId: null }).success,
    ).toBe(true);

    const completed = registry.require(AI_EVENT_TYPES.modelCallCompleted);
    // A completed call always knows which model answered.
    expect(
      completed.payloadSchema.safeParse({
        ...(samples()["ai.model.call.completed"] as JsonObject),
        modelId: null,
      }).success,
    ).toBe(false);
  });
});

describe("publishing ai events", () => {
  function harness(): {
    registry: ReturnType<typeof createEventRegistry>;
    bus: ReturnType<typeof createInMemoryEventBus>;
  } {
    const registry = createEventRegistry();
    registry.registerAll(PLATFORM_EVENT_DEFINITIONS);
    return { registry, bus: createInMemoryEventBus(registry) };
  }

  function envelope(type: EventType, payload: JsonObject): EventEnvelope {
    return createEvent({ type, payload, source: EVENT_OWNERS.aiCore, tenantId: createTenantId() });
  }

  it("delivers an agent state change to a subscriber", async () => {
    const { bus } = harness();
    const seen: EventEnvelope[] = [];
    bus.subscribe(AI_EVENT_TYPES.agentStateChanged, (event) => {
      seen.push(event);
    });

    await bus.publish(
      envelope(AI_EVENT_TYPES.agentStateChanged, samples()["ai.agent.state.changed"] as JsonObject),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toMatchObject({ from: "ready", to: "running" });
  });

  it("delivers a model call outcome to a namespace-wide subscriber", async () => {
    const { registry, bus } = harness();
    expect(registry.listByNamespace("ai")).toHaveLength(22);

    const seen: EventType[] = [];
    bus.subscribeAll((event) => {
      seen.push(event.type);
    });
    await bus.publish(
      envelope(
        AI_EVENT_TYPES.modelCallCompleted,
        samples()["ai.model.call.completed"] as JsonObject,
      ),
    );
    await bus.publish(
      envelope(AI_EVENT_TYPES.budgetCommitted, samples()["ai.budget.committed"] as JsonObject),
    );

    expect(seen.map(String)).toEqual(["ai.model.call.completed", "ai.budget.committed"]);
  });

  it("rejects a payload that does not match its registered contract", async () => {
    const { bus } = harness();
    await expect(
      bus.publish(envelope(AI_EVENT_TYPES.modelCallCompleted, { executionId: "not-an-execution" })),
    ).rejects.toThrow();
  });

  it("rejects an ai type nobody defined, because declaring is not registering", async () => {
    const { registry } = harness();
    // There is deliberately no `ai.model.call.requested`: the request is a fact in
    // the execution record, and a second copy would be a second source of truth.
    const undeclared = parseEventType("ai.model.call.requested");
    expect(registry.isRegistered(undeclared)).toBe(false);
    expect(() => registry.require(undeclared)).toThrow();
  });
});
