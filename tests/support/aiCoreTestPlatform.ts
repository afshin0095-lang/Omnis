/**
 * A working AI Core platform, assembled from published APIs only.
 *
 * The integration suites in this directory test the platform the way a caller meets
 * it: through `@omnis/ai-core-runtime`'s public surface, with nothing imported from
 * inside another package's `src`. That constraint is the point. A fixture that
 * reached into a package's internals could keep passing after the public API broke,
 * and the first caller would be the one to find out.
 *
 * Everything here is deterministic. The clock only moves when a test moves it, the
 * tracer records instead of exporting, and the provider adapter answers from a script
 * rather than a network. A suite that cannot be re-run to the same millisecond cannot
 * be debugged, and an integration test that needs debugging is the expensive kind.
 */

import { createExecutionFailure, EMPTY_USAGE, toolParameterSchema } from "@omnis/ai-core-types";
import type {
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
  ToolDescriptor,
  ToolHandlerResult,
  ToolInvocation,
  UsageSummary,
} from "@omnis/ai-core-types";
import { createAiCoreEventBus, createAiCoreRuntime } from "@omnis/ai-core-runtime";
import type { AiCoreRuntime, AiCoreRuntimeOptions } from "@omnis/ai-core-runtime";
import type { AgentDescriptor, PolicyId } from "@omnis/ai-core-types";
import type { AgentRegistrationInput } from "@omnis/agent-runtime";
import type { BudgetInput } from "@omnis/budget-engine";
import type { PolicySetInput } from "@omnis/policy-engine";
import type { ToolDescriptorInput } from "@omnis/tool-runtime";
import type { EventBus } from "@omnis/events";
import type { EventEnvelope } from "@omnis/contracts";
import {
  createModelId,
  createProviderId,
  createSpanId,
  createTenantId,
  createTraceId,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonValue, ModelId, ProviderId, TenantId, ToolId } from "@omnis/types";
import type {
  Span,
  SpanContext,
  StartSpanOptions,
  TelemetryAttributes,
  Tracer,
} from "@omnis/telemetry";

/** The instant every fixture event happens at, in epoch milliseconds. */
export const AT_MS = 1_772_000_000_000;

/** The same instant as a UTC ISO 8601 timestamp. */
export const AT = "2026-02-25T06:13:20.000Z";

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

/** A span as recorded, with the facts a test reads back. */
export interface RecordedSpan extends Span {
  readonly recordedName: string;
  readonly recordedAttributes: Record<string, string | number | boolean | null>;
  readonly recordedStatuses: readonly {
    readonly status: string;
    readonly message: string | undefined;
  }[];
  readonly recordedExceptions: readonly unknown[];
}

/**
 * A tracer that keeps every span it was asked for.
 *
 * Parenting follows the caller's `parent` option and nothing else, so a suite can
 * assert that one run produced one trace by reading the recorded contexts: a span
 * whose `parentSpanId` is null is a root, and two roots where one was expected is a
 * broken composition rather than a broken assertion.
 */
export function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    name: parseTrimmedString("ai-core-integration-tracer"),
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
        get recordedStatuses(): readonly {
          readonly status: string;
          readonly message: string | undefined;
        }[] {
          return statuses;
        },
        get recordedExceptions(): readonly unknown[] {
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

/** Pricing every platform model carries, so a cost is always computable. */
export const FLAT_PRICING: ModelPricing = Object.freeze({
  currency: "micro_usd",
  inputPerThousandTokens: 100,
  outputPerThousandTokens: 100,
  cachedInputPerThousandTokens: null,
  perRequestMicro: null,
});

/** A usage summary with the numbers a test cares about. */
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
  // scripted response carries placeholders rather than pretending to know who answered.
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

/** The events a streaming adapter yields: a start, a delta, the usage and the end. */
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

/** One recorded provider invocation. */
export interface RecordedInvocation {
  readonly request: ModelRequest;
  readonly context: ProviderInvocationContext;
}

/** An adapter that answers from a script and records what it was asked. */
export interface ScriptedAdapter extends ProviderAdapter {
  readonly invocations: readonly RecordedInvocation[];
  /** Replaces the results the adapter returns, in order. */
  script(results: readonly ProviderInvocationResult[]): void;
}

/**
 * Creates a scripted adapter for one provider.
 *
 * The script's last entry repeats once it is exhausted, so a test that expects three
 * calls and scripts one result gets three of them rather than an undefined that looks
 * like a platform bug.
 */
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
    Object.assign(adapter, {
      stream(): AsyncGenerator<ModelStreamEvent> {
        const events = options.streamEvents as readonly ModelStreamEvent[];
        return (async function* yieldAll(): AsyncGenerator<ModelStreamEvent> {
          for (const event of events) {
            yield event;
          }
        })();
      },
    });
  }
  return adapter;
}

/** A tool descriptor input for a low-risk read tool that takes one query string. */
export function searchToolInput(overrides: Partial<ToolDescriptorInput> = {}): ToolDescriptorInput {
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

/** One model and the provider that serves it. */
export interface PlatformModel {
  readonly model: ModelDescriptor;
  readonly provider: ProviderDescriptor;
  readonly adapter: ScriptedAdapter;
}

/** An event a subscriber saw, in publish order. */
export interface PublishedEvent {
  readonly type: string;
  readonly payload: JsonValue;
  readonly tenantId: string | null;
  /**
   * The envelope exactly as it was published.
   *
   * The flattened fields above are what most suites assert on; this is what the event
   * contract suite validates, because a contract is about the whole envelope — identity,
   * version, tenant, causality — and not only the payload.
   */
  readonly envelope: EventEnvelope;
}

/** What a built platform exposes. */
export interface AiCoreTestPlatform {
  readonly runtime: AiCoreRuntime;
  readonly clock: TestClock;
  readonly spans: readonly RecordedSpan[];
  readonly bus: EventBus;
  readonly published: readonly PublishedEvent[];
  readonly tenantId: TenantId;
  readonly models: readonly PlatformModel[];
  /** The first registered pair. */
  readonly primary: PlatformModel;
  /** The second registered pair, when the platform was built with one. */
  readonly secondary: PlatformModel | null;
  readonly tool: ToolDescriptor;
  readonly toolHandler: { readonly calls: readonly ToolInvocation[] };
  readonly agent: AgentDescriptor;
}

/** How a platform is assembled. */
export interface AiCoreTestPlatformOptions {
  /** What the primary provider answers with, in order. */
  readonly modelResults?: readonly ProviderInvocationResult[];
  /** When set, a second provider and model are registered, for fallback suites. */
  readonly secondaryResults?: readonly ProviderInvocationResult[] | null;
  /** When set, the primary model declares `streaming` and its adapter yields these. */
  readonly streamEvents?: readonly ModelStreamEvent[] | null;
  /** Declare `streaming` on the primary model and yield the default event sequence. */
  readonly streaming?: boolean;
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
 * Composes a whole AI Core: one provider, one priced model, one tool and one agent.
 *
 * This is the least interesting platform there is — everything registered, everything
 * healthy, everything allowed — which is where an integration suite wants to start
 * before it removes one part and checks that the rest notices.
 */
export function buildAiCorePlatform(options: AiCoreTestPlatformOptions = {}): AiCoreTestPlatform {
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
      envelope: event,
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
    streaming: boolean,
  ): PlatformModel => {
    const providerId = createProviderId();
    const modelId = createModelId();
    const capabilities: readonly ModelCapability[] = streaming ? ["chat", "streaming"] : ["chat"];
    const adapter = scriptedAdapter({
      providerId,
      slug: `${slug}-provider`,
      capabilities,
      results,
      ...(streaming
        ? {
            streamEvents:
              options.streamEvents ?? streamEventsFor(`${slug} streamed`, modelId, providerId),
          }
        : {}),
    });
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
    // registry enforces the lifecycle, so the platform walks it rather than asserting it.
    const provider = runtime.providers.setStatus(registered.id, "ready");
    const model = runtime.registerModel({
      // A caller-chosen identifier, so a scripted stream can name the model it belongs to
      // before registration hands one back.
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

  const streaming =
    options.streaming === true ||
    (options.streamEvents !== undefined && options.streamEvents !== null);
  const models: PlatformModel[] = [
    addPair(
      "primary",
      options.modelResults ?? [completedInvocation("primary answered")],
      streaming,
    ),
  ];
  if (options.secondaryResults !== undefined && options.secondaryResults !== null) {
    models.push(addPair("secondary", options.secondaryResults, false));
  }
  const primary = models[0] as PlatformModel;

  const handler = recordingHandler(options.toolValue ?? { documents: ["doc_1"] });
  const tool = runtime.registerTool(searchToolInput(), handler.handler);

  const agent = runtime.registerAgent({
    slug: "assistant",
    displayName: "Assistant",
    description: "An agent registered by the integration platform.",
    kind: "reactive",
    status: "active",
    version: "1.0.0",
    capabilities: ["tool_use"],
    instructions: { system: "Answer briefly.", prohibitions: ["never invent a citation"] },
    defaultModel: { kind: "id", modelId: primary.model.id },
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
    primary,
    secondary: models[1] ?? null,
    tool,
    toolHandler: handler,
    agent,
  };
}

/** A policy set input that decides one outcome for everything, so a gate is provable. */
export function singleOutcomePolicySet(
  outcome: "allow" | "deny" | "require_approval",
  name = `fixture-${outcome}`,
): PolicySetInput {
  return {
    name,
    description: `Decides "${outcome}" for every action, so a suite can prove the gate ran first.`,
    rules: [{ id: `always-${outcome}`, name: `always ${outcome}`, outcome }],
    defaultOutcome: outcome,
    createdAt: AT,
  };
}

/**
 * A budget input with one limit, so a reservation is provable.
 *
 * The window matters as much as the limit: an `execution` window gives every execution
 * its own allowance, so a suite that wants to exhaust a budget across two calls has to
 * ask for a `total` one. Getting this wrong produces a budget that never runs out.
 */
export function budgetInput(
  limit: number,
  dimension: "requests" | "tokens" | "model_calls" | "cost_micro_usd" = "requests",
  window: "execution" | "session" | "day" | "total" = "execution",
  name = "fixture-budget",
): BudgetInput {
  return { name, limits: [{ dimension, window, limit }], createdAt: AT };
}
