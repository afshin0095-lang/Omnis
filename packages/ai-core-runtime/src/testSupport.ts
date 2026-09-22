/**
 * Test doubles for the composition root.
 *
 * A composition test that reached a real provider would be testing that provider, and one
 * that used the wall clock could not assert ordering. So: a scripted adapter that returns
 * what it was told and records every request it received, a moving clock, a tracer that
 * records spans instead of dropping them, and one call that composes the whole AI Core.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import {
  createExecutionId,
  createModelId,
  createProviderId,
  createSpanId,
  createTenantId,
  createToolId,
  createTraceId,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonValue, ModelId, ProviderId, TenantId, ToolId } from "@omnis/types";
import {
  createCorrelationId,
  createExecutionFailure,
  EMPTY_USAGE,
  toolById,
  toolByName,
  toolParameterSchema,
} from "@omnis/ai-core-types";
import type {
  AgentDescriptor,
  ExecutionStep,
  ModelCapability,
  ModelDescriptor,
  ModelPricing,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderInvocationContext,
  ProviderInvocationResult,
  ToolAuditRecord,
  ToolDenialReason,
  ToolDescriptor,
  ToolHandlerResult,
  ToolInvocation,
  ToolResult,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { AgentRegistrationInput } from "@omnis/agent-runtime";
import type { PolicyId } from "@omnis/ai-core-types";
import type { EventBus } from "@omnis/events";
import { createExecutionContext, ExecutionScope } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import type { StepEnvironment } from "@omnis/execution-kernel";
import type {
  Span,
  SpanContext,
  StartSpanOptions,
  TelemetryAttributes,
  Tracer,
} from "@omnis/telemetry";
import type { ToolDescriptorInput, ToolInvocationRequest } from "@omnis/tool-runtime";
import { createAiCoreEventBus, createAiCoreRuntime } from "./AiCoreRuntime.js";
import type { AiCoreRuntime, AiCoreRuntimeOptions } from "./AiCoreRuntime.js";

/** The instant every fixture happens at, in epoch milliseconds. */
export const AT_MS = 1_772_000_000_000;

/** The same instant as a UTC ISO 8601 timestamp. */
export const AT = "2026-02-25T06:13:20.000Z";

// ---------------------------------------------------------------------------
// Clock and telemetry
// ---------------------------------------------------------------------------

/** A clock that only moves when a test moves it. */
export interface TestClock {
  (): number;
  advance(ms: number): number;
  readonly now: number;
}

/** Creates a clock starting at {@link AT_MS}. */
export function testClock(startMs: number = AT_MS): TestClock {
  let current = startMs;
  const clock = (): number => current;
  return Object.assign(clock, {
    advance(ms: number): number {
      current += ms;
      return current;
    },
    get now(): number {
      return current;
    },
  });
}

/** A span as recorded. */
export interface RecordedSpan extends Span {
  readonly recordedName: string;
  readonly recordedAttributes: Record<string, string | number | boolean | null>;
  readonly recordedStatuses: { readonly status: string; readonly message: string | undefined }[];
  readonly recordedExceptions: unknown[];
}

/** A tracer that keeps every span it was asked for. */
export function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    name: parseTrimmedString("ai-core-test-tracer"),
    startSpan(name: string, options: StartSpanOptions = {}): Span {
      const attributes: Record<string, string | number | boolean | null> = {
        ...(options.attributes ?? {}),
      };
      const statuses: { status: string; message: string | undefined }[] = [];
      const exceptions: unknown[] = [];
      const context: SpanContext = {
        traceId: options.parent?.traceId ?? createTraceId(),
        spanId: createSpanId(),
        parentSpanId: options.parent?.spanId ?? null,
        correlationId: options.parent?.correlationId ?? null,
        tenantId: options.parent?.tenantId ?? null,
      };
      let ended = false;
      const span: RecordedSpan = {
        name: parseTrimmedString(name),
        kind: options.kind ?? "internal",
        context,
        get ended(): boolean {
          return ended;
        },
        get recordedName(): string {
          return name;
        },
        get recordedAttributes(): Record<string, string | number | boolean | null> {
          return attributes;
        },
        get recordedStatuses(): {
          readonly status: string;
          readonly message: string | undefined;
        }[] {
          return statuses;
        },
        get recordedExceptions(): unknown[] {
          return exceptions;
        },
        setAttribute(key: string, value: JsonValue): void {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            value === null
          ) {
            attributes[key] = value;
          }
        },
        setAttributes(values: TelemetryAttributes): void {
          Object.assign(attributes, values);
        },
        setStatus(status: string, message?: string): void {
          statuses.push({ status, message });
        },
        recordException(error: unknown): void {
          exceptions.push(error);
        },
        addEvent(): void {},
        end(): void {
          ended = true;
        },
      };
      spans.push(span);
      return span;
    },
  };
  return { tracer, spans };
}

// ---------------------------------------------------------------------------
// Provider fixtures
// ---------------------------------------------------------------------------

/** Pricing every fixture model carries, so a cost is always computable. */
export const FLAT_PRICING: ModelPricing = Object.freeze({
  currency: "micro_usd",
  inputPerThousandTokens: 100,
  outputPerThousandTokens: 100,
  cachedInputPerThousandTokens: null,
  perRequestMicro: null,
});

/** A usage summary with the fields a test cares about. */
export function usageOf(
  inputTokens = 12,
  outputTokens = 34,
  costMicro: number | null = 4,
): UsageSummary {
  return {
    ...EMPTY_USAGE,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requests: 1,
    costMicro,
  };
}

/** The response a completed invocation carries. */
export function completedResponse(
  text: string,
  usage: UsageSummary = usageOf(),
  latencyMs = 12,
): ModelResponse {
  // The orchestrator stamps the identifiers it resolved onto the response it reports, so a
  // fixture response carries placeholders rather than pretending to know which model answered.
  return {
    modelId: createModelId(),
    providerId: createProviderId(),
    message: { role: "assistant", content: [{ type: "text", text }], name: null, metadata: {} },
    stopReason: "stop",
    usage,
    latencyMs,
    streamed: false,
    providerDetails: null,
    servedAt: AT,
  };
}

/** A successful provider invocation. */
export function completedInvocation(
  text = "answered",
  usage: UsageSummary = usageOf(),
  latencyMs = 12,
): ProviderInvocationResult {
  return {
    status: "completed",
    response: completedResponse(text, usage, latencyMs),
    usage,
    latencyMs,
  };
}

/**
 * The events a streaming adapter yields: a start, one delta per chunk, and the completion.
 *
 * Always terminated, because an unterminated stream is a failure the orchestrator reports
 * rather than something a fixture should accidentally produce.
 */
export function streamEventsFor(
  text: string,
  modelId: ModelId,
  providerId: ProviderId,
): readonly ModelStreamEvent[] {
  return Object.freeze([
    { type: "started", modelId, providerId },
    { type: "delta", text },
    { type: "usage", usage: usageOf() },
    { type: "completed", stopReason: "stop", latencyMs: 9 },
  ] satisfies readonly ModelStreamEvent[]);
}

/** A failed provider invocation, classified as asked. */
export function failedInvocation(
  message = "the provider refused",
  options: {
    readonly failureClass?: "provider_failure" | "retryable" | "non_retryable";
    readonly retryable?: boolean;
  } = {},
): ProviderInvocationResult {
  const failureClass = options.failureClass ?? "provider_failure";
  return {
    status: "failed",
    failure: createExecutionFailure({
      class: failureClass,
      code: "provider_failure",
      message,
      retryable: options.retryable ?? failureClass !== "non_retryable",
    }),
    usage: EMPTY_USAGE,
    latencyMs: 8,
  };
}

/** One recorded provider invocation. */
export interface RecordedInvocation {
  readonly request: ModelRequest;
  readonly context: ProviderInvocationContext;
}

/** An adapter that returns scripted results and records what it was asked. */
export interface ScriptedAdapter extends ProviderAdapter {
  readonly invocations: readonly RecordedInvocation[];
  /** Replaces the results the adapter returns, in order. */
  script(results: readonly ProviderInvocationResult[]): void;
}

/** Creates a scripted adapter for one provider. */
export function scriptedAdapter(options: {
  readonly providerId: ProviderId;
  readonly slug: string;
  readonly capabilities?: readonly ModelCapability[];
  readonly results?: readonly ProviderInvocationResult[];
  readonly streamEvents?: readonly ModelStreamEvent[];
}): ScriptedAdapter {
  const capabilities = options.capabilities ?? ["chat"];
  const invocations: RecordedInvocation[] = [];
  let results = [...(options.results ?? [completedInvocation(`${options.slug} answered`)])];

  /** The result for one call: the script's last entry repeats once it is exhausted. */
  const resultAt = (index: number): ProviderInvocationResult =>
    results[Math.min(index, Math.max(0, results.length - 1))] as ProviderInvocationResult;

  const adapter: ScriptedAdapter = {
    providerId: options.providerId,
    slug: options.slug,
    async invoke(
      request: ModelRequest,
      context: ProviderInvocationContext,
    ): Promise<ProviderInvocationResult> {
      invocations.push({ request, context });
      return resultAt(invocations.length - 1);
    },
    supports(capability: ModelCapability): boolean {
      return capabilities.includes(capability);
    },
    get invocations(): readonly RecordedInvocation[] {
      return invocations;
    },
    script(next: readonly ProviderInvocationResult[]): void {
      results = [...next];
    },
  };
  if (options.streamEvents !== undefined) {
    const events = options.streamEvents;
    Object.assign(adapter, {
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        for (const event of events) {
          yield event;
        }
      },
    });
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Tool fixtures
// ---------------------------------------------------------------------------

/** A descriptor input for a low-risk read tool that takes one query string. */
export function toolDescriptorInput(
  overrides: Partial<ToolDescriptorInput> = {},
): ToolDescriptorInput {
  return {
    name: "search_documents",
    displayName: "Search documents",
    description: "Searches the document index and returns matching identifiers.",
    version: "1.0.0",
    kind: "read",
    riskLevel: "low",
    sideEffect: "none",
    permissions: [],
    parameters: toolParameterSchema(
      {
        query: {
          type: "string",
          description: "The query text.",
          enumValues: [],
          items: null,
          nullable: false,
        },
      },
      ["query"],
    ),
    resultDescription: "A list of matching document identifiers.",
    timeoutMs: 1_000,
    supportsCancellation: true,
    maxConcurrency: 4,
    requiresApproval: false,
    registeredAt: AT,
    ...overrides,
  };
}

/** A handler that returns one value and records every invocation it received. */
export function recordingHandler(value: JsonValue): {
  handler: (invocation: ToolInvocation) => ToolHandlerResult;
  readonly calls: readonly ToolInvocation[];
} {
  const calls: ToolInvocation[] = [];
  return {
    handler: (invocation: ToolInvocation): ToolHandlerResult => {
      calls.push(invocation);
      return { ok: true, value };
    },
    get calls(): readonly ToolInvocation[] {
      return calls;
    },
  };
}

/** A handler that reports an error result. */
export function errorResultHandler(
  errorCode: string,
  message: string,
  retryable = false,
): (invocation: ToolInvocation) => ToolHandlerResult {
  return () => ({ ok: false, errorCode, message, retryable });
}

/**
 * An audit record a tool result can carry.
 *
 * A real one is built for real invocations; tests need the same shape without an invocation,
 * and forging one here keeps every result in every test honest about what it claims.
 */
export function toolAuditRecord(
  toolId: ToolId,
  overrides: Partial<ToolAuditRecord> = {},
): ToolAuditRecord {
  return {
    executionId: createExecutionId(),
    correlationId: createCorrelationId(),
    toolId,
    toolName: "search_documents",
    toolVersion: "1.0.0",
    attempt: 1,
    permissionsRequired: Object.freeze([]),
    policyDecisionOutcome: "allow",
    startedAt: AT,
    finishedAt: AT,
    durationMs: 5,
    timedOut: false,
    cancelled: false,
    argumentKeys: Object.freeze(["query"]),
    ...overrides,
  };
}

/** A tool result of each status, for driving the bridge without a real invocation. */
export function toolResult(status: "succeeded", toolId: ToolId, value?: JsonValue): ToolResult;
export function toolResult(
  status: "failed",
  toolId: ToolId,
  failure?: {
    readonly errorCode?: string;
    readonly message?: string;
    readonly retryable?: boolean;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
  },
): ToolResult;
export function toolResult(
  status: "denied",
  toolId: ToolId,
  reason?: ToolDenialReason,
  message?: string,
): ToolResult;
export function toolResult(
  status: ToolResult["status"],
  toolId: ToolId,
  third?: unknown,
  fourth?: unknown,
): ToolResult {
  if (status === "succeeded") {
    return {
      status,
      toolId,
      value: (third as JsonValue | undefined) ?? { documents: ["doc_1"] },
      durationMs: 14,
      audit: toolAuditRecord(toolId),
    };
  }
  if (status === "denied") {
    return {
      status,
      toolId,
      reason: (third as ToolDenialReason | undefined) ?? "policy",
      message: (fourth as string | undefined) ?? "the tool runtime refused the invocation",
      audit: toolAuditRecord(toolId, { policyDecisionOutcome: "deny" }),
    };
  }
  const failure = (third ?? {}) as {
    readonly errorCode?: string;
    readonly message?: string;
    readonly retryable?: boolean;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
  };
  return {
    status: "failed",
    toolId,
    errorCode: failure.errorCode ?? "tool_failed",
    message: failure.message ?? "the tool raised",
    retryable: failure.retryable ?? false,
    timedOut: failure.timedOut ?? false,
    cancelled: failure.cancelled ?? false,
    durationMs: 14,
    audit: toolAuditRecord(toolId, {
      timedOut: failure.timedOut ?? false,
      cancelled: failure.cancelled ?? false,
    }),
  };
}

/** A step environment, for driving a step executor by hand. */
export function stepEnvironment(overrides: Partial<StepEnvironment> = {}): StepEnvironment {
  const scope = ExecutionScope.createRoot(
    { executionId: createExecutionId(), tenantId: createTenantId() },
    { clock: () => AT_MS },
  );
  const context = scope.context;
  return {
    executionId: context.executionId,
    stepId: "only",
    correlationId: context.correlationId,
    traceId: context.traceId,
    tenantId: context.tenantId,
    parentSpanId: context.parentSpanId,
    attempt: 1,
    maxAttempts: 2,
    startedAt: AT,
    deadlineAt: null,
    context,
    approval: null,
    remainingMs: () => null,
    isCancelled: () => false,
    cancellationReason: () => null,
    ...overrides,
  };
}

/** An execution step, with the fields a test usually leaves alone. */
export function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: "answer",
    name: "Assistant answers",
    kind: "model",
    dependsOn: [],
    timeoutMs: 5_000,
    maxAttempts: 2,
    optional: false,
    input: { goal: "answer briefly" },
    modelId: createModelId(),
    providerId: null,
    toolId: null,
    metadata: {},
    ...overrides,
  };
}

/** A fresh execution context, tenant-scoped so an envelope can be minted from it. */
export function context(overrides: Record<string, unknown> = {}): ExecutionContext {
  return createExecutionContext(
    { tenantId: createTenantId(), ...overrides },
    { clock: () => AT_MS },
  );
}

/** An invocation request against a tool, with a fresh context and one valid argument. */
export function toolInvocation(
  tool: ToolDescriptor | ToolId | string,
  overrides: Partial<ToolInvocationRequest> = {},
): ToolInvocationRequest {
  const reference =
    typeof tool === "string"
      ? toolByName(tool)
      : toolById(typeof tool === "object" && "id" in tool ? (tool.id as ToolId) : (tool as ToolId));
  return {
    tool: reference,
    arguments: { query: "quarterly report" },
    context: context(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The composition fixture
// ---------------------------------------------------------------------------

/** One provider/model pair the fixture registered. */
export interface FixtureModel {
  readonly model: ModelDescriptor;
  readonly provider: ProviderDescriptor;
  readonly adapter: ScriptedAdapter;
}

/** One published event, as a subscriber saw it. */
export interface PublishedEvent {
  readonly type: string;
  readonly payload: JsonValue;
  readonly tenantId: string | null;
}

/** What a fixture exposes. */
export interface AiCoreFixture {
  readonly runtime: AiCoreRuntime;
  readonly clock: TestClock;
  readonly spans: readonly RecordedSpan[];
  /** The bus the fixture built. Wired into the runtime unless `withoutEvents` was set. */
  readonly bus: EventBus;
  /** Every event a subscriber saw, in publish order. */
  readonly published: readonly PublishedEvent[];
  readonly tenantId: TenantId;
  readonly models: readonly FixtureModel[];
  /** The first registered pair. */
  readonly primary: FixtureModel;
  readonly tool: ToolDescriptor;
  readonly toolHandler: { readonly calls: readonly ToolInvocation[] };
  readonly agent: AgentDescriptor;
}

/** How a fixture is assembled. */
export interface AiCoreFixtureOptions {
  /** What the provider answers with, in order. Defaults to one successful response. */
  readonly modelResults?: readonly ProviderInvocationResult[];
  /** A second provider/model pair, for fallback tests. */
  readonly secondaryResults?: readonly ProviderInvocationResult[] | null;
  /** When set, the primary model declares `streaming` and its adapter yields these events. */
  readonly streamEvents?: readonly ModelStreamEvent[] | null;
  /** What the tool handler returns. */
  readonly toolValue?: JsonValue;
  /** Overrides for the agent registration. */
  readonly agent?: Partial<AgentRegistrationInput>;
  /** Policy sets every call is gated by. */
  readonly defaultPolicyIds?: readonly PolicyId[];
  /** Extra options for the composition itself. */
  readonly runtime?: Partial<AiCoreRuntimeOptions>;
  /** Compose without an event bus. */
  readonly withoutEvents?: boolean;
}

/**
 * Composes the whole AI Core with one provider, one priced model, one tool and one agent.
 *
 * This is the least interesting platform there is — everything registered, everything
 * healthy, everything allowed — which is exactly what a composition test wants to start
 * from before it removes one part and checks that the rest notices.
 */
export function aiCoreFixture(options: AiCoreFixtureOptions = {}): AiCoreFixture {
  const clock = testClock();
  const { tracer, spans } = recordingTracer();
  const bus = createAiCoreEventBus();
  const tenantId = createTenantId();
  const published: PublishedEvent[] = [];
  bus.subscribeAll((event) => {
    published.push({
      type: String(event.type),
      payload: event.payload,
      tenantId: event.tenantId === null ? null : String(event.tenantId),
    });
  });

  const runtime = createAiCoreRuntime({
    clock: () => clock(),
    tracer,
    events: options.withoutEvents === true ? null : bus,
    tenantId,
    retryDelayMs: 0,
    ...(options.defaultPolicyIds === undefined
      ? {}
      : { defaultPolicyIds: options.defaultPolicyIds }),
    ...(options.runtime ?? {}),
  });

  const addPair = (
    slug: string,
    results: readonly ProviderInvocationResult[],
    streaming: boolean = false,
  ): FixtureModel => {
    const providerId = createProviderId();
    const modelId = createModelId();
    const capabilities: readonly ModelCapability[] = streaming ? ["chat", "streaming"] : ["chat"];
    const adapter = scriptedAdapter({
      providerId,
      slug: `${slug}-provider`,
      capabilities,
      results,
    });
    if (streaming) {
      const events =
        options.streamEvents ?? streamEventsFor(`${slug} streamed`, modelId, providerId);
      Object.assign(adapter, {
        async *stream(): AsyncGenerator<ModelStreamEvent> {
          for (const event of events) {
            yield event;
          }
        },
      });
    }
    const registered = runtime.registerProvider(
      {
        slug: `${slug}-provider`,
        displayName: `${slug} provider`,
        transport: "http",
        capabilities: {
          operations: ["chat"],
          inputModalities: ["text"],
          outputModalities: ["text"],
          modelCapabilities: capabilities,
        },
        rateLimit: { requestsPerMinute: 600, tokensPerMinute: 100_000, maxConcurrentRequests: 8 },
        priority: 10,
        latencyClass: "low",
        region: null,
        credentialsConfigured: true,
        registeredAt: AT,
      },
      adapter,
    );
    // A registration starts as "registered"; a provider that answers is "ready", and the
    // registry enforces the lifecycle, so the fixture walks it rather than asserting it.
    const provider = runtime.providers.setStatus(registered.id, "ready");
    const model = runtime.registerModel({
      // A caller-chosen identifier, so the adapter's stream events can name the model they
      // belong to before registration hands one back.
      id: modelId,
      slug,
      displayName: slug,
      providerId: provider.id,
      kind: "general",
      capabilities,
      modalities: { input: ["text"], output: ["text"] },
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
      pricing: FLAT_PRICING,
      priority: 10,
      latencyClass: "low",
      providerModelName: slug,
      registeredAt: AT,
    });
    return { model, provider, adapter };
  };

  const models: FixtureModel[] = [
    addPair(
      "primary",
      options.modelResults ?? [completedInvocation("primary answered")],
      options.streamEvents !== undefined && options.streamEvents !== null,
    ),
  ];
  if (options.secondaryResults !== undefined && options.secondaryResults !== null) {
    models.push(addPair("secondary", options.secondaryResults));
  }

  const handler = recordingHandler(options.toolValue ?? { documents: ["doc_1"] });
  const tool = runtime.registerTool(toolDescriptorInput(), handler.handler);

  const agent = runtime.registerAgent({
    slug: "assistant",
    displayName: "Assistant",
    description: "A fixture agent.",
    kind: "reactive",
    status: "active",
    version: "1.0.0",
    capabilities: ["tool_use"],
    instructions: { system: "Answer briefly.", prohibitions: ["never invent a citation"] },
    defaultModel: { kind: "id", modelId: models[0]?.model.id as ModelId },
    tools: [{ toolId: tool.id as ToolId }],
    ...(options.agent ?? {}),
  });

  return {
    runtime,
    clock,
    spans,
    bus,
    get published(): readonly PublishedEvent[] {
      return published;
    },
    tenantId,
    models,
    primary: models[0] as FixtureModel,
    tool,
    toolHandler: handler,
    agent,
  };
}

/** A tool identifier that is not registered anywhere. */
export function unknownToolId(): ToolId {
  return createToolId();
}
