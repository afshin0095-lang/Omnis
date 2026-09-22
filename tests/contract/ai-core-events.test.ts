/**
 * The AI Core's event contract, checked from both ends.
 *
 * `@omnis/ai-core-types` declares what may be said, `@omnis/events` defines how it is
 * said, and `@omnis/ai-core-runtime` says it. Those three packages have no compile-time
 * link to each other — the events package must not import the AI Core's types, or every
 * consumer of the event contract would drag the whole runtime into its dependency tree —
 * so nothing but a test can prove they still agree.
 *
 * That is what this file is for. A definition that drifts from the declaration, or an
 * envelope the runtime publishes that its own contract rejects, is a break consumers
 * discover in production, and both are checked here instead.
 */

import { describe, expect, it } from "vitest";
import { agentBySlug, modelById, toolById } from "@omnis/ai-core-types";
import {
  AI_CORE_EVENT_DEFINITIONS,
  AI_EVENT_TYPE_LIST,
  AI_EVENT_TYPES,
  AI_CORE_EVENT_DEFINITIONS_BY_TYPE,
  AI_EVENT_TYPES_WITHOUT_DEFINITIONS,
  EVENT_OWNERS,
  aiAgentStateChangedPayloadSchema,
  aiBudgetExceededPayloadSchema,
  aiBudgetReservedPayloadSchema,
  aiEvaluationCompletedPayloadSchema,
  aiModelCallCompletedPayloadSchema,
  aiModelFallbackUsedPayloadSchema,
  aiPolicyDecisionRecordedPayloadSchema,
  aiToolCallCompletedPayloadSchema,
  createEventRegistry,
  createInMemoryEventBus,
  definitionKey,
} from "@omnis/events";
import { CONTRACT_VERSION, EVENT_SCOPES, createEvent, eventEnvelopeSchema } from "@omnis/contracts";
import type { EventType } from "@omnis/types";
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
} from "@omnis/types";
import type { JsonObject } from "@omnis/types";
import { AT, buildAiCorePlatform } from "../support/aiCoreTestPlatform.js";

/** Identifiers reused across the samples, so a failing assertion points at one field. */
const EXECUTION = createExecutionId();
const MODEL = createModelId();
const PROVIDER = createProviderId();
const AGENT = createAgentId();
const TOOL = createToolId();
const POLICY = createPolicyId();
const BUDGET = createBudgetId();
const RESERVATION = createReservationId();
const EVALUATION = createEvaluationId();
const TENANT = createTenantId();

const USAGE = { inputTokens: 12, outputTokens: 34, totalTokens: 46, costMicroUsd: 4 } as const;
const FAILURE = {
  errorCode: "provider_failure",
  failureClass: "provider_failure",
  errorMessage: "the provider closed the connection",
  retryable: false,
} as const;

/**
 * One faithful payload per declared `ai.*` type.
 *
 * Typed as a record over the declared union, so adding an event type without adding its
 * sample is a compile error rather than a silent gap in the contract suite.
 */
const SAMPLES: Record<EventType, JsonObject> = {
  [AI_EVENT_TYPES.modelCallCompleted]: {
    executionId: String(EXECUTION),
    modelId: String(MODEL),
    providerId: String(PROVIDER),
    modelReference: "capability:chat",
    durationMs: 240,
    stopReason: "stop",
    streamed: false,
    fallbacks: 1,
    ...USAGE,
  },
  [AI_EVENT_TYPES.modelCallFailed]: {
    executionId: String(EXECUTION),
    modelId: String(MODEL),
    providerId: String(PROVIDER),
    modelReference: "slug:primary",
    durationMs: 90,
    attempts: 2,
    fallbacks: 1,
    ...FAILURE,
  },
  [AI_EVENT_TYPES.modelFallbackUsed]: {
    executionId: String(EXECUTION),
    fromModelId: String(MODEL),
    fromProviderId: String(PROVIDER),
    toModelId: String(createModelId()),
    toProviderId: String(createProviderId()),
    depth: 1,
    reason: "the first candidate refused the call",
    policyDriven: false,
  },
  [AI_EVENT_TYPES.modelRetryScheduled]: {
    executionId: String(EXECUTION),
    modelId: String(MODEL),
    providerId: String(PROVIDER),
    attempt: 1,
    nextAttempt: 2,
    delayMs: 250,
    errorCode: "provider_failure",
    failureClass: "retryable",
  },
  [AI_EVENT_TYPES.modelStreamStarted]: {
    executionId: String(EXECUTION),
    modelId: String(MODEL),
    providerId: String(PROVIDER),
  },
  [AI_EVENT_TYPES.modelStreamCompleted]: {
    executionId: String(EXECUTION),
    modelId: String(MODEL),
    providerId: String(PROVIDER),
    durationMs: 310,
    stopReason: "stop",
    chunks: 14,
    ...USAGE,
  },
  [AI_EVENT_TYPES.modelStreamFailed]: {
    executionId: String(EXECUTION),
    modelId: String(MODEL),
    providerId: String(PROVIDER),
    durationMs: 120,
    chunksEmitted: 3,
    abandoned: true,
    ...FAILURE,
  },
  [AI_EVENT_TYPES.providerHealthRecorded]: {
    providerId: String(PROVIDER),
    observation: "failure",
    state: "degraded",
    consecutiveSuccesses: 0,
    consecutiveFailures: 2,
    averageLatencyMs: 480,
    observedAt: AT,
  },
  [AI_EVENT_TYPES.providerStatusChanged]: {
    providerId: String(PROVIDER),
    from: "ready",
    to: "degraded",
    reason: "two consecutive failures",
    changedAt: AT,
  },
  [AI_EVENT_TYPES.toolCallCompleted]: {
    executionId: String(EXECUTION),
    toolId: String(TOOL),
    agentId: String(AGENT),
    riskLevel: "low",
    durationMs: 18,
    outputBytes: 512,
    isErrorResult: false,
    approved: false,
  },
  [AI_EVENT_TYPES.toolCallFailed]: {
    executionId: String(EXECUTION),
    toolId: String(TOOL),
    agentId: String(AGENT),
    riskLevel: "medium",
    durationMs: 1200,
    timedOut: true,
    ...FAILURE,
  },
  [AI_EVENT_TYPES.toolCallBlocked]: {
    executionId: String(EXECUTION),
    toolId: String(TOOL),
    agentId: String(AGENT),
    riskLevel: "high",
    blockedBy: "policy",
    policyId: String(POLICY),
    reason: "the policy set denies this tool",
  },
  [AI_EVENT_TYPES.agentStateChanged]: {
    executionId: String(EXECUTION),
    agentId: String(AGENT),
    from: "running",
    to: "waiting",
    waitingOn: "approval",
    reason: "a policy required an approval",
    changedAt: AT,
  },
  [AI_EVENT_TYPES.agentStepCompleted]: {
    executionId: String(EXECUTION),
    agentId: String(AGENT),
    stepId: "answer",
    stepName: "answer",
    stepKind: "model",
    attempt: 1,
    durationMs: 240,
    ...USAGE,
  },
  [AI_EVENT_TYPES.agentStepFailed]: {
    executionId: String(EXECUTION),
    agentId: String(AGENT),
    stepId: "lookup",
    stepName: "lookup",
    stepKind: "tool",
    attempt: 1,
    durationMs: 30,
    skipped: false,
    optional: true,
    ...FAILURE,
  },
  [AI_EVENT_TYPES.policyDecisionRecorded]: {
    executionId: String(EXECUTION),
    policyId: String(POLICY),
    subject: `model:${String(MODEL)}`,
    outcome: "constrain",
    constraintKinds: ["max_cost_micro_usd"],
    approvalRequired: false,
    reason: null,
    decidedAt: AT,
  },
  [AI_EVENT_TYPES.policyViolationDetected]: {
    executionId: String(EXECUTION),
    policyId: String(POLICY),
    subject: `tool:${String(TOOL)}`,
    constraintKind: "denied_tools",
    refused: true,
    detail: "the tool is on the agent's deny list",
    detectedAt: AT,
  },
  [AI_EVENT_TYPES.budgetReserved]: {
    executionId: String(EXECUTION),
    budgetId: String(BUDGET),
    reservationId: String(RESERVATION),
    window: "execution",
    holds: [{ dimension: "requests", amount: 1 }],
    costMicroUsd: 400,
    reservedAt: AT,
  },
  [AI_EVENT_TYPES.budgetCommitted]: {
    executionId: String(EXECUTION),
    budgetId: String(BUDGET),
    reservationId: String(RESERVATION),
    ...USAGE,
    committedAt: AT,
  },
  [AI_EVENT_TYPES.budgetReleased]: {
    executionId: String(EXECUTION),
    budgetId: String(BUDGET),
    reservationId: String(RESERVATION),
    reason: "the call failed before it was charged",
    releasedAt: AT,
  },
  [AI_EVENT_TYPES.budgetExceeded]: {
    executionId: String(EXECUTION),
    budgetId: String(BUDGET),
    dimension: "cost_micro_usd",
    window: "day",
    limit: 10_000,
    used: 9_800,
    requested: 400,
    refusedAt: AT,
  },
  [AI_EVENT_TYPES.evaluationCompleted]: {
    evaluationId: String(EVALUATION),
    executionId: String(EXECUTION),
    subject: "execution",
    verdict: "pass",
    overallScore: 0.92,
    dimensionsScored: 4,
    rulesApplied: 6,
    findings: 0,
    evaluatedAt: AT,
  },
};

/** Why a schema rejected a payload, as text a failing assertion can print. */
function rejectionOf(parsed: { readonly success: boolean; readonly error?: unknown }): string {
  return parsed.success ? "" : String(parsed.error);
}

/** The sample for a declared type, or a failure that names the gap. */
function sampleFor(type: EventType): JsonObject {
  const sample = SAMPLES[type];
  if (sample === undefined) {
    throw new Error(`the contract suite has no sample for ${String(type)}`);
  }
  return sample;
}

/** A registry holding every AI Core definition. */
function aiRegistry() {
  const registry = createEventRegistry();
  registry.registerAll(AI_CORE_EVENT_DEFINITIONS);
  return registry;
}

describe("every declared event type is defined, and nothing else is", () => {
  it("defines all twenty-two ai.* types", () => {
    expect(AI_EVENT_TYPE_LIST).toHaveLength(22);
    for (const type of AI_EVENT_TYPE_LIST) {
      expect(
        AI_CORE_EVENT_DEFINITIONS_BY_TYPE.get(String(type)),
        `no definition for ${String(type)}`,
      ).toBeDefined();
    }
    // A type declared without a definition is a promise the platform cannot keep: a
    // consumer subscribing to it would wait forever for an event nobody can validate.
    expect(AI_EVENT_TYPES_WITHOUT_DEFINITIONS).toHaveLength(0);
  });

  it("defines nothing that was not declared", () => {
    const declared = new Set(AI_EVENT_TYPE_LIST.map((type) => String(type)));
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      expect(
        declared.has(String(definition.type)),
        `undeclared definition ${String(definition.type)}`,
      ).toBe(true);
    }
    expect(AI_CORE_EVENT_DEFINITIONS).toHaveLength(declared.size);
  });

  it("versions every definition at the contract version and gives it one owner", () => {
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      expect(String(definition.version)).toBe(CONTRACT_VERSION);
      // Ownership is what makes a contract changeable by exactly one team: an event owned
      // by everybody is owned by nobody, and two owners means two incompatible versions.
      expect(definition.owner).toBe(EVENT_OWNERS.aiCore);
      expect(EVENT_SCOPES).toContain(definition.scope);
      expect(definition.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every definition a unique key, and refuses to register a second one", () => {
    const keys = AI_CORE_EVENT_DEFINITIONS.map((definition) =>
      definitionKey(definition.type, definition.version),
    );
    expect(new Set(keys).size).toBe(keys.length);

    const registry = aiRegistry();
    expect(() => registry.register(AI_CORE_EVENT_DEFINITIONS[0]!)).toThrow();
  });

  it("refuses an envelope for a type nobody registered", () => {
    const registry = createEventRegistry();
    const bus = createInMemoryEventBus(registry);
    const envelope = createEvent({
      type: AI_EVENT_TYPES.modelCallCompleted,
      payload: sampleFor(AI_EVENT_TYPES.modelCallCompleted),
      source: EVENT_OWNERS.aiCore,
      tenantId: TENANT,
    });

    // Validating before dispatch is the point: a consumer that receives an event it cannot
    // parse either crashes or, worse, quietly reads the wrong fields.
    expect(() => registry.validateEnvelope(envelope)).toThrow();
    return expect(bus.publish(envelope)).rejects.toBeTruthy();
  });
});

describe("payloads validate against their own definition", () => {
  it("accepts a faithful payload for every declared type", () => {
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      const type = definition.type;
      const parsed = definition.payloadSchema.safeParse(sampleFor(type));
      expect(
        parsed.success,
        `${String(type)} rejected its own sample: ${rejectionOf(parsed)}`,
      ).toBe(true);
    }
  });

  it("rejects a payload that names the wrong kind of thing", () => {
    // Identifiers are branded: a model identifier is not a provider identifier, and a
    // schema that accepted any string would let a consumer correlate the wrong records.
    const parsed = aiModelCallCompletedPayloadSchema.safeParse({
      ...sampleFor(AI_EVENT_TYPES.modelCallCompleted),
      modelId: String(PROVIDER),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a payload that reports a state nobody declared", () => {
    const parsed = aiAgentStateChangedPayloadSchema.safeParse({
      ...sampleFor(AI_EVENT_TYPES.agentStateChanged),
      to: "exploding",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects fractional money", () => {
    // Micro-USD integers are the platform's money type. A float in an event is a rounding
    // difference a consumer cannot reconcile, and it is invisible until the books do not add up.
    expect(
      aiBudgetReservedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.budgetReserved),
        costMicroUsd: 400.5,
      }).success,
    ).toBe(false);
    expect(
      aiBudgetExceededPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.budgetExceeded),
        used: 9_800.25,
      }).success,
    ).toBe(false);
    // Null is allowed and means "not priced", which is a different fact from zero.
    expect(
      aiBudgetReservedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.budgetReserved),
        costMicroUsd: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative counter and a missing field", () => {
    expect(
      aiToolCallCompletedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.toolCallCompleted),
        durationMs: -1,
      }).success,
    ).toBe(false);
    const { executionId: _executionId, ...withoutExecution } = sampleFor(
      AI_EVENT_TYPES.toolCallCompleted,
    );
    expect(aiToolCallCompletedPayloadSchema.safeParse(withoutExecution).success).toBe(false);
  });

  it("rejects an out-of-range score", () => {
    expect(
      aiEvaluationCompletedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.evaluationCompleted),
        overallScore: 1.4,
      }).success,
    ).toBe(false);
  });

  it("rejects a fallback that names no destination", () => {
    expect(
      aiModelFallbackUsedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.modelFallbackUsed),
        toModelId: null,
      }).success,
    ).toBe(false);
    // The *source* of a fallback may be unknown — the first candidate can be passed over
    // before anything identifies it — and saying so is honest.
    expect(
      aiModelFallbackUsedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.modelFallbackUsed),
        fromModelId: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a policy decision with an outcome nobody declared", () => {
    expect(
      aiPolicyDecisionRecordedPayloadSchema.safeParse({
        ...sampleFor(AI_EVENT_TYPES.policyDecisionRecorded),
        outcome: "maybe",
      }).success,
    ).toBe(false);
  });
});

describe("payloads carry identifiers, never content", () => {
  /** Every AI Core payload schema, reached through the definitions. */
  const schemas: readonly [string, Record<string, unknown>][] = [
    ["ai.model.call.completed", aiModelCallCompletedPayloadSchema.shape],
    ["ai.model.fallback.used", aiModelFallbackUsedPayloadSchema.shape],
    ["ai.tool.call.completed", aiToolCallCompletedPayloadSchema.shape],
    ["ai.agent.state.changed", aiAgentStateChangedPayloadSchema.shape],
    ["ai.policy.decision.recorded", aiPolicyDecisionRecordedPayloadSchema.shape],
    ["ai.budget.reserved", aiBudgetReservedPayloadSchema.shape],
    ["ai.evaluation.completed", aiEvaluationCompletedPayloadSchema.shape],
  ];

  /** Field names that would mean the payload carries somebody's words. */
  const CONTENT_FIELDS = [
    "prompt",
    "completion",
    "message",
    "messages",
    "text",
    "content",
    "output",
    "response",
    "transcript",
  ];

  it("names what happened with identifiers and counters", () => {
    for (const [type, shape] of schemas) {
      const keys = Object.keys(shape);
      expect(
        keys.some((key) => key.endsWith("Id")),
        `${type} carries no identifier`,
      ).toBe(true);
      for (const forbidden of CONTENT_FIELDS) {
        // An event is broadcast to every subscriber, so anything in it leaves the trust
        // boundary of the call that produced it. The prompt and the answer stay in the
        // execution record, where access is scoped; the event says who, what and how much.
        expect(keys, `${type} carries a content field "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it("carries no credential-shaped field anywhere in the contract", () => {
    for (const definition of AI_CORE_EVENT_DEFINITIONS) {
      for (const key of Object.keys(sampleFor(definition.type))) {
        // Token *counts* are legitimate counters; a token *value* is a credential. The
        // distinction is why this is a list of shapes rather than a substring match.
        expect(key.toLowerCase()).not.toMatch(
          /apikey|api_key|secret|password|credential|authorization|bearer|access_?token|private_?key|signature/,
        );
      }
    }
  });
});

describe("what the runtime actually publishes satisfies the contract", () => {
  it("validates every envelope an agent run emits, against its definition and the envelope schema", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    const registry = aiRegistry();
    const envelopes = platform.published
      .map((record) => record.envelope)
      .filter((envelope) => String(envelope.type).startsWith("ai."));
    expect(envelopes.length).toBeGreaterThan(0);

    for (const envelope of envelopes) {
      const type = String(envelope.type);
      // The envelope itself: identity, tenant, causality, version.
      expect(eventEnvelopeSchema.safeParse(envelope).success, `envelope ${type} is malformed`).toBe(
        true,
      );
      // And the payload against the definition the type was declared with.
      const definition = registry.find(envelope.type);
      expect(definition, `${type} is not registered`).toBeDefined();
      const parsed = definition?.payloadSchema.safeParse(envelope.payload);
      expect(
        parsed?.success,
        `${type} published a payload its own contract rejects: ${rejectionOf(parsed ?? { success: false, error: "unregistered" })}`,
      ).toBe(true);
      // Tenancy is in the envelope, not in the payload: a consumer filters by tenant
      // without parsing anything, and a payload that carried it could disagree.
      expect(envelope.tenantId).not.toBeNull();
      expect(String(envelope.version)).toBe(CONTRACT_VERSION);
    }
  });

  it("publishes the agent's state changes in the order the state machine allows", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    const states = platform.published
      .filter((envelope) => String(envelope.type) === String(AI_EVENT_TYPES.agentStateChanged))
      .map((envelope) => String((envelope.payload as JsonObject).to));
    expect(states.at(-1)).toBe("completed");
    // Every change is published, including the ones on the way: a consumer reconstructing
    // the run from events alone has to see the path, not just the destination.
    expect(states.length).toBeGreaterThan(2);
    expect(states).toContain("running");
  });

  it("keeps a published envelope JSON-safe", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    for (const envelope of platform.published.map((record) => record.envelope)) {
      // An envelope that does not survive serialization cannot cross a process boundary,
      // and the failure would show up in the transport rather than in the publisher.
      expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    }
  });

  it("says what happened when a run fails, in the same contract", async () => {
    const platform = buildAiCorePlatform({ toolValue: null });
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer, then look something up that does not exist",
      steps: [
        { id: "answer", kind: "model", model: modelById(platform.primary.model.id) },
        {
          id: "lookup",
          kind: "tool",
          tool: toolById(platform.tool.id),
          arguments: { query: "missing" },
          optional: true,
        },
      ],
    });

    const registry = aiRegistry();
    const stepEvents = platform.published
      .map((record) => record.envelope)
      .filter((envelope) =>
        [
          String(AI_EVENT_TYPES.agentStepCompleted),
          String(AI_EVENT_TYPES.agentStepFailed),
        ].includes(String(envelope.type)),
      );
    expect(stepEvents.length).toBe(2);
    for (const envelope of stepEvents) {
      const definition = registry.find(envelope.type);
      expect(definition?.payloadSchema.safeParse(envelope.payload).success).toBe(true);
    }
  });
});
