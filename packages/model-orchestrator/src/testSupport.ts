/**
 * Fixtures for the orchestrator's tests.
 *
 * Everything here exists so a test can state *the situation* — one model, two providers, a policy
 * that denies the second — without rebuilding registries by hand. Two rules shaped it:
 *
 * - **Nothing reaches a network.** An adapter is a script: it answers from a queue of results and
 *   records what it was asked. A test that needs a provider to fail twice and then answer says so.
 * - **Time moves only when a test moves it.** The clock is a counter with an `advance` method, so a
 *   retry delay, a deadline and a latency assertion are all exact rather than approximate.
 *
 * This file is not part of the package's public surface; it is imported by the tests beside it.
 */

import {
  createProviderId,
  createSpanId,
  createToolId,
  createTraceId,
  parseTrimmedString,
} from "@omnis/types";
import type { ExecutionId, ToolId } from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import { EMPTY_USAGE, toolParameterSchema } from "@omnis/ai-core-types";
import type {
  BudgetId,
  ModelCapability,
  ModelDescriptor,
  ModelId,
  ModelPricing,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolSpec,
  PolicyId,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderId,
  ProviderInvocationContext,
  ProviderInvocationResult,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { ExecutionFailure } from "@omnis/ai-core-types";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import type { BudgetEngine } from "@omnis/budget-engine";
import { createCancellationSource, ExecutionScope, manualClock } from "@omnis/execution-context";
import type { CancellationSource, ExecutionContext, ManualClock } from "@omnis/execution-context";
import { InMemoryModelRegistry } from "@omnis/model-registry";
import type { ModelRegistry, ModelRegistrationInput } from "@omnis/model-registry";
import { InMemoryPolicyEngine } from "@omnis/policy-engine";
import type { ConstraintSpecInput, PolicyEngine, PolicyRuleInput } from "@omnis/policy-engine";
import {
  InMemoryProviderRegistry,
  isLegalProviderStatusTransition,
} from "@omnis/provider-registry";
import type { ProviderRegistry } from "@omnis/provider-registry";
import type {
  Span,
  SpanContext,
  StartSpanOptions,
  TelemetryAttributes,
  Tracer,
} from "@omnis/telemetry";
import { InMemoryModelOrchestrator } from "./ModelOrchestrator.js";
import type { ModelOrchestratorOptions } from "./ModelOrchestrator.js";
import type { ModelCallRequest } from "./ModelCall.js";

/** The instant every fixture timestamp reads, as UTC ISO 8601. */
export const AT = "2026-03-01T12:00:00.000Z";

/** The same instant as epoch milliseconds. */
export const AT_MS = Date.parse(AT);

/** Pricing that makes cost arithmetic readable: 100 micro-USD per thousand tokens, either way. */
export const FLAT_PRICING: ModelPricing = Object.freeze({
  currency: "micro_usd",
  inputPerThousandTokens: 100,
  outputPerThousandTokens: 100,
  cachedInputPerThousandTokens: null,
  perRequestMicro: null,
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A clock a test moves by hand.
 *
 * The published {@link manualClock} from `@omnis/execution-context`, aliased so a test reads
 * `clock.advance(30)` next to an assertion about a thirty-millisecond retry delay.
 */
export type TestClock = ManualClock;

/** Creates a clock starting at {@link AT_MS}. */
export function testClock(startMs: number = AT_MS): TestClock {
  return manualClock(startMs);
}

/** A context a test can cancel from the outside, and the scope that owns it. */
export interface CancellableContext {
  readonly context: ExecutionContext;
  readonly scope: ExecutionScope;
  readonly source: CancellationSource;
  /** Requests cancellation with the given reason. */
  cancel(reason?: string): void;
}

/**
 * Builds a parent context whose cancellation a test controls.
 *
 * The orchestrator opens a child scope for a call, and a child inherits its parent's token: this is
 * how a test cancels a call that is already in flight.
 */
export function cancellableContext(
  options: {
    readonly executionId?: ExecutionId;
    readonly deadlineMs?: number;
    readonly clock?: TestClock;
  } = {},
): CancellableContext {
  const clock = options.clock ?? testClock();
  const source = createCancellationSource();
  const scope = ExecutionScope.createRoot(
    {
      ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      cancellation: source.token,
      mode: "interactive",
    },
    { clock },
  );
  return {
    context: scope.context,
    scope,
    source,
    cancel(reason = "the test cancelled the call"): void {
      source.cancel(reason);
    },
  };
}

// ---------------------------------------------------------------------------
// Usage and provider results
// ---------------------------------------------------------------------------

/** Stand-ins for the identifiers the orchestrator stamps onto a response. */
export const PLACEHOLDER_MODEL_ID = "mdl_00000000000000000000000000" as ModelId;

/** Stand-in for a provider identifier. */
export const PLACEHOLDER_PROVIDER_ID = "prv_00000000000000000000000000" as ProviderId;

/** A usage summary with the fields a test cares about. */
export function usageOf(
  inputTokens = 12,
  outputTokens = 34,
  costMicro: number | null = null,
): UsageSummary {
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    requests: 1,
    costMicro,
  };
}

/** A successful invocation carrying one assistant message. */
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

/** The response a completed invocation carries, before the orchestrator stamps it. */
export function completedResponse(
  text: string,
  usage: UsageSummary = usageOf(),
  latencyMs = 12,
): ModelResponse {
  // The orchestrator stamps the identifiers it resolved onto the response it reports, so a fixture
  // response carries placeholders rather than pretending to know which model answered.
  return {
    modelId: PLACEHOLDER_MODEL_ID,
    providerId: PLACEHOLDER_PROVIDER_ID,
    message: { role: "assistant", content: [{ type: "text", text }], name: null, metadata: {} },
    stopReason: "stop",
    usage,
    latencyMs,
    streamed: false,
    providerDetails: null,
    servedAt: AT,
  };
}

/** What a failing provider is allowed to report. */
export interface FailedInvocationOptions {
  readonly failureClass?:
    | "retryable"
    | "provider_failure"
    | "non_retryable"
    | "deadline_exceeded"
    | "validation"
    | "policy_blocked"
    | "budget_blocked";
  readonly code?: ExecutionFailure["code"];
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | null;
  readonly usage?: UsageSummary;
  readonly latencyMs?: number;
}

/** A failed invocation, classified as asked. */
export function failedInvocation(
  message = "the provider refused",
  options: FailedInvocationOptions = {},
): ProviderInvocationResult {
  const failureClass = options.failureClass ?? "provider_failure";
  const retryable =
    options.retryable ?? (failureClass === "provider_failure" || failureClass === "retryable");
  const code =
    options.code ?? (failureClass === "deadline_exceeded" ? "timeout" : "provider_failure");
  return {
    status: "failed",
    failure: {
      class: failureClass,
      code,
      message,
      retryable,
      retryAfterMs: options.retryAfterMs ?? null,
      attempt: 1,
      stepId: null,
      executionId: null,
      modelId: null,
      providerId: null,
      toolId: null,
      details: {},
      occurredAt: AT,
    },
    usage: options.usage ?? EMPTY_USAGE,
    latencyMs: options.latencyMs ?? 3,
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** One call an adapter received. */
export interface RecordedInvocation {
  readonly request: ModelRequest;
  readonly context: ProviderInvocationContext;
}

/** How a scripted adapter behaves. */
export interface ScriptedAdapterOptions {
  readonly providerId: ProviderId;
  readonly slug: string;
  /** Capabilities the adapter confirms. Defaults to `chat`. */
  readonly capabilities?: readonly ModelCapability[];
  /** Results to return, in order. The last one repeats once the queue is exhausted. */
  readonly results?: readonly ProviderInvocationResult[];
  /** When set, `invoke` throws this instead of returning. */
  readonly throws?: Error;
  /** Events `stream` yields, in order. Omitting them means the adapter cannot stream. */
  readonly streamEvents?: readonly ModelStreamEvent[];
  /** When set, `stream` throws this. */
  readonly streamThrows?: Error;
  /** Model identifiers `supports` confirms. Omit to confirm every model. */
  readonly supportsModels?: readonly ModelId[];
  /** Milliseconds the adapter takes before answering. */
  readonly latencyMs?: number;
  /** Called with every invocation, so a test can advance the clock mid-call. */
  readonly onInvoke?: (invocation: RecordedInvocation) => void;
}

/** A deterministic adapter, and the record of what it was asked. */
export interface ScriptedAdapter extends ProviderAdapter {
  readonly invocations: readonly RecordedInvocation[];
  readonly streamInvocations: readonly RecordedInvocation[];
  readonly supportsCalls: number;
  /** True when the adapter implements `stream`. */
  readonly canStream: boolean;
}

/** Creates a scripted adapter. */
export function scriptedAdapter(options: ScriptedAdapterOptions): ScriptedAdapter {
  const capabilities = options.capabilities ?? ["chat"];
  const results = options.results ?? [];
  const streamEvents = options.streamEvents;
  const invocations: RecordedInvocation[] = [];
  const streamInvocations: RecordedInvocation[] = [];
  let supportsCalls = 0;

  const resultFor = (index: number): ProviderInvocationResult => {
    if (options.throws !== undefined) {
      throw options.throws;
    }
    const scripted = results[Math.min(index, Math.max(0, results.length - 1))];
    if (scripted !== undefined) {
      return scripted;
    }
    return failedInvocation("the scripted adapter has no result configured", { retryable: false });
  };

  const adapter: ScriptedAdapter = {
    providerId: options.providerId,
    slug: options.slug,
    async invoke(
      request: ModelRequest,
      context: ProviderInvocationContext,
    ): Promise<ProviderInvocationResult> {
      const recorded: RecordedInvocation = { request, context };
      invocations.push(recorded);
      options.onInvoke?.(recorded);
      if (options.latencyMs !== undefined && options.latencyMs > 0) {
        await sleep(options.latencyMs);
      }
      return resultFor(invocations.length - 1);
    },
    supports(capability: ModelCapability, modelId: ModelId): boolean {
      supportsCalls += 1;
      if (!capabilities.includes(capability)) {
        return false;
      }
      return options.supportsModels === undefined || options.supportsModels.includes(modelId);
    },
    get invocations(): readonly RecordedInvocation[] {
      return invocations;
    },
    get streamInvocations(): readonly RecordedInvocation[] {
      return streamInvocations;
    },
    get supportsCalls(): number {
      return supportsCalls;
    },
    get canStream(): boolean {
      return streamEvents !== undefined;
    },
  };

  if (streamEvents === undefined) {
    return adapter;
  }

  return Object.assign(adapter, {
    async *stream(
      request: ModelRequest,
      context: ProviderInvocationContext,
    ): AsyncGenerator<ModelStreamEvent> {
      const recorded: RecordedInvocation = { request, context };
      streamInvocations.push(recorded);
      options.onInvoke?.(recorded);
      for (const event of streamEvents) {
        yield event;
      }
      // Throwing after the events models an adapter that dies mid-answer; with an empty list it
      // models one that never got going.
      if (options.streamThrows !== undefined) {
        throw options.streamThrows;
      }
    },
  });
}

/** A resolved promise that takes the given time, so a scripted adapter can look slow. */
function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** How a fixture provider is registered. */
export interface ProviderFixtureOptions {
  readonly slug: string;
  /** Reuse an identifier, e.g. to replace the adapter behind a model that is already registered. */
  readonly id?: ProviderId;
  readonly capabilities?: {
    readonly operations?: ProviderDescriptor["capabilities"]["operations"];
    readonly modelCapabilities?: readonly ModelCapability[];
  };
  readonly priority?: number;
  readonly status?: ProviderDescriptor["status"];
  readonly credentialsConfigured?: boolean;
  readonly region?: string | null;
  readonly policyId?: PolicyId | null;
  readonly budgetId?: BudgetId | null;
}

/** Registers a provider with its adapter and returns the descriptor. */
export function registerProvider(
  registry: ProviderRegistry,
  adapter: ProviderAdapter,
  options: ProviderFixtureOptions,
): ProviderDescriptor {
  const descriptor = registry.register(
    {
      ...(options.id === undefined ? {} : { id: options.id }),
      slug: options.slug,
      displayName: parseTrimmedString(options.slug),
      transport: "http",
      capabilities: {
        operations: options.capabilities?.operations ?? ["chat"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        modelCapabilities: options.capabilities?.modelCapabilities ?? ["chat"],
      },
      rateLimit: { requestsPerMinute: 600, tokensPerMinute: 100_000, maxConcurrentRequests: 8 },
      priority: options.priority ?? 10,
      latencyClass: "low",
      region: options.region ?? null,
      policyId: options.policyId ?? null,
      budgetId: options.budgetId ?? null,
      credentialsConfigured: options.credentialsConfigured ?? true,
      metadata: {},
      registeredAt: AT,
    },
    adapter,
  );
  if (options.status === undefined || options.status === descriptor.status) {
    return descriptor;
  }
  // The registry enforces a lifecycle, so a fixture that wants a degraded provider walks the legal
  // path to get there rather than pretending the transition was allowed.
  if (isLegalProviderStatusTransition(descriptor.status, options.status)) {
    return registry.setStatus(descriptor.id, options.status);
  }
  const initialized = registry.setStatus(descriptor.id, "initializing");
  return registry.setStatus(initialized.id, options.status);
}

/** How a fixture model is registered. */
export interface ModelFixtureOptions {
  readonly slug: string;
  readonly providerId: ProviderId;
  readonly kind?: ModelDescriptor["kind"];
  readonly capabilities?: readonly ModelCapability[];
  readonly status?: ModelDescriptor["status"];
  readonly priority?: number;
  readonly pricing?: ModelPricing | null;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly providerModelName?: string;
  readonly id?: ModelId;
}

/** Registers a model and returns the descriptor. */
export function registerModel(
  registry: ModelRegistry,
  options: ModelFixtureOptions,
): ModelDescriptor {
  const input: ModelRegistrationInput = {
    ...(options.id === undefined ? {} : { id: options.id }),
    slug: options.slug,
    displayName: parseTrimmedString(options.slug),
    providerId: options.providerId,
    kind: options.kind ?? "general",
    ...(options.status === undefined ? {} : { status: options.status }),
    capabilities: options.capabilities ?? ["chat"],
    modalities: { input: ["text"], output: ["text"] },
    contextWindowTokens: options.contextWindowTokens ?? 128_000,
    maxOutputTokens: options.maxOutputTokens ?? 4_096,
    pricing: options.pricing === undefined ? FLAT_PRICING : options.pricing,
    priority: options.priority ?? 10,
    latencyClass: "low",
    providerModelName: options.providerModelName ?? options.slug,
    metadata: {},
    registeredAt: AT,
  };
  return registry.register(input);
}

// ---------------------------------------------------------------------------
// Policy and budget fixtures
// ---------------------------------------------------------------------------

/** A policy engine holding one set. */
export function policyFixture(set: {
  readonly name: string;
  readonly defaultOutcome: PolicySetOutcome;
  readonly rules?: readonly PolicyRuleInput[];
  readonly baselineConstraints?: readonly ConstraintSpecInput[];
}): { engine: PolicyEngine; policyId: PolicyId } {
  const engine = new InMemoryPolicyEngine({ clock: () => AT });
  const registered = engine.registerPolicySet({
    name: set.name,
    defaultOutcome: set.defaultOutcome,
    rules: set.rules ?? [],
    ...(set.baselineConstraints === undefined
      ? {}
      : { baselineConstraints: set.baselineConstraints }),
    createdAt: AT,
  });
  return { engine, policyId: registered.id };
}

/** The outcomes a fixture policy set may default to. */
export type PolicySetOutcome = "allow" | "deny" | "constrain" | "require_approval";

/** A policy set that allows everything. */
export function allowAllPolicy(): { engine: PolicyEngine; policyId: PolicyId } {
  return policyFixture({ name: "allow-all", defaultOutcome: "allow" });
}

/** A policy set that denies everything. */
export function denyAllPolicy(): { engine: PolicyEngine; policyId: PolicyId } {
  return policyFixture({ name: "deny-all", defaultOutcome: "deny" });
}

/** A policy set that allows, with baseline constraints applied to every call. */
export function constrainedPolicy(constraints: readonly ConstraintSpecInput[]): {
  engine: PolicyEngine;
  policyId: PolicyId;
} {
  return policyFixture({
    name: "constrained",
    defaultOutcome: "constrain",
    baselineConstraints: constraints,
  });
}

/** A budget engine holding one budget. */
export function budgetFixture(
  limits: {
    dimension: "tokens" | "requests" | "cost_micro_usd" | "model_calls";
    window: "execution" | "total";
    limit: number;
  }[] = [{ dimension: "requests", window: "execution", limit: 10 }],
  engine: BudgetEngine = new InMemoryBudgetEngine({ clock: () => AT }),
): { engine: BudgetEngine; budgetId: BudgetId } {
  const budget = engine.registerBudget({ name: "call-budget", limits, createdAt: AT });
  return { engine, budgetId: budget.id };
}

// ---------------------------------------------------------------------------
// Telemetry fixture
// ---------------------------------------------------------------------------

/** A span as recorded. */
export interface RecordedSpan extends Span {
  readonly recordedName: string;
  readonly recordedAttributes: Record<string, string | number | boolean>;
  readonly recordedStatuses: { readonly status: string; readonly message: string | undefined }[];
}

/** A tracer that records what the orchestrator asked it to record. */
export function recordingTracer(): { tracer: Tracer; spans: readonly RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    name: parseTrimmedString("orchestrator-test-tracer"),
    startSpan(name: string, options: StartSpanOptions = {}): Span {
      const attributes: Record<string, string | number | boolean> = {
        ...(options.attributes ?? {}),
      };
      const statuses: { status: string; message: string | undefined }[] = [];
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
        get recordedAttributes(): Record<string, string | number | boolean> {
          return attributes;
        },
        get recordedStatuses(): { status: string; message: string | undefined }[] {
          return statuses;
        },
        setAttribute(key: string, value: JsonValue): void {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
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
        recordException(): void {
          // The orchestrator records failures on the result, not as span exceptions.
        },
        addEvent(): void {
          // Not used by the orchestrator.
        },
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
// The orchestrator fixture
// ---------------------------------------------------------------------------

/** A registered model with the provider and adapter that serve it. */
export interface FixtureModel {
  readonly model: ModelDescriptor;
  readonly provider: ProviderDescriptor;
  readonly adapter: ScriptedAdapter;
}

/** What a fixture gives a test. */
export interface OrchestratorFixture {
  readonly orchestrator: InMemoryModelOrchestrator;
  readonly modelRegistry: ModelRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly policyEngine: PolicyEngine | null;
  readonly budgetEngine: BudgetEngine | null;
  readonly clock: TestClock;
  readonly tracer: Tracer;
  readonly spans: readonly RecordedSpan[];
  readonly models: readonly FixtureModel[];
  /** Adds one more provider/model pair after construction. */
  addModel(spec: ModelFixtureSpec): FixtureModel;
  /** The first registered pair, or null when the fixture was built with none. */
  readonly primary: FixtureModel | null;
}

/** One provider/model pair the fixture should register. */
export interface ModelFixtureSpec {
  readonly slug: string;
  /** What the provider answers with, in order. Defaults to one successful chat response. */
  readonly results?: readonly ProviderInvocationResult[];
  /** Events a streaming adapter yields. Omit for an adapter that cannot stream. */
  readonly streamEvents?: readonly ModelStreamEvent[];
  /** When set, `stream` throws this instead of yielding. */
  readonly streamThrows?: Error;
  readonly priority?: number;
  readonly pricing?: ModelPricing | null;
  readonly capabilities?: readonly ModelCapability[];
  /** Lifecycle state to move the provider to after registration. */
  readonly status?: ProviderDescriptor["status"];
  /** Whether the provider has credentials. One without them cannot answer. */
  readonly credentialsConfigured?: boolean;
  /** When set, `invoke` throws this instead of returning a result. */
  readonly throws?: Error;
  /** Milliseconds the adapter waits before answering. */
  readonly latencyMs?: number;
  /** Called with every invocation, so a test can move the clock mid-call. */
  readonly onInvoke?: (invocation: RecordedInvocation) => void;
}

/** How the fixture is assembled. */
export interface OrchestratorFixtureOptions {
  /** Provider/model pairs to register up front. Defaults to one model named `primary`. */
  readonly models?: readonly ModelFixtureSpec[];
  /** A clock the test already holds, so an adapter callback can move it. */
  readonly clock?: TestClock;
  readonly policyEngine?: PolicyEngine | null;
  readonly budgetEngine?: BudgetEngine | null;
  readonly defaultBudgetId?: BudgetId | null;
  readonly defaultPolicyIds?: readonly PolicyId[];
  readonly retryDelayMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly orchestrator?: Partial<ModelOrchestratorOptions>;
}

/**
 * Builds registries, an orchestrator and a moving clock in one call.
 *
 * With no arguments it produces a single provider serving a single priced chat model that answers
 * "answered" — the least interesting call there is, which is exactly what a test wants to start from.
 */
export function orchestratorFixture(options: OrchestratorFixtureOptions = {}): OrchestratorFixture {
  const clock = options.clock ?? testClock();
  const modelRegistry = new InMemoryModelRegistry({ clock: () => AT });
  const providerRegistry = new InMemoryProviderRegistry({ clock: () => AT });
  const { tracer, spans } = recordingTracer();
  const models: FixtureModel[] = [];

  const capabilitiesFor = (spec: ModelFixtureSpec): readonly ModelCapability[] => {
    const declared = spec.capabilities ?? ["chat"];
    // An adapter that yields events has to declare the capability, or the orchestrator would be
    // right to pass it over.
    return spec.streamEvents === undefined || declared.includes("streaming")
      ? declared
      : [...declared, "streaming"];
  };

  const addModel = (spec: ModelFixtureSpec): FixtureModel => {
    // The identifier is minted before registration, because an adapter carries the identifier of the
    // provider it serves and registration verifies that the two agree.
    const providerId = createProviderId();
    const adapter = scriptedAdapter({
      providerId,
      slug: `${spec.slug}-provider`,
      capabilities: capabilitiesFor(spec),
      results: spec.results ?? [completedInvocation(`${spec.slug} answered`, usageOf(12, 34, 4))],
      ...(spec.streamEvents === undefined ? {} : { streamEvents: spec.streamEvents }),
      ...(spec.streamThrows === undefined ? {} : { streamThrows: spec.streamThrows }),
      ...(spec.throws === undefined ? {} : { throws: spec.throws }),
      ...(spec.latencyMs === undefined ? {} : { latencyMs: spec.latencyMs }),
      ...(spec.onInvoke === undefined ? {} : { onInvoke: spec.onInvoke }),
    });
    const provider = registerProvider(providerRegistry, adapter, {
      slug: `${spec.slug}-provider`,
      priority: spec.priority ?? 10,
      capabilities: { operations: ["chat", "streaming"], modelCapabilities: capabilitiesFor(spec) },
      credentialsConfigured: spec.credentialsConfigured ?? true,
      ...(spec.status === undefined ? {} : { status: spec.status }),
    });
    const model = registerModel(modelRegistry, {
      slug: spec.slug,
      providerId: provider.id,
      capabilities: capabilitiesFor(spec),
      priority: spec.priority ?? 10,
      ...(spec.pricing === undefined ? {} : { pricing: spec.pricing }),
    });
    const fixture: FixtureModel = { model, provider, adapter };
    models.push(fixture);
    return fixture;
  };

  const requested = options.models ?? [{ slug: "primary" }];
  for (const spec of requested) {
    addModel(spec);
  }

  const orchestrator = new InMemoryModelOrchestrator({
    modelRegistry,
    providerRegistry,
    policyEngine: options.policyEngine ?? null,
    budgetEngine: options.budgetEngine ?? null,
    tracer,
    clock,
    ...(options.defaultBudgetId === undefined ? {} : { defaultBudgetId: options.defaultBudgetId }),
    ...(options.defaultPolicyIds === undefined
      ? {}
      : { defaultPolicyIds: options.defaultPolicyIds }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.orchestrator ?? {}),
  });

  return {
    orchestrator,
    modelRegistry,
    providerRegistry,
    policyEngine: options.policyEngine ?? null,
    budgetEngine: options.budgetEngine ?? null,
    clock,
    tracer,
    spans,
    models,
    addModel,
    primary: models[0] ?? null,
  };
}

/**
 * Another orchestrator over the same registries, with governance attached.
 *
 * A test that needs a policy which names a model identifier has a chicken-and-egg problem: the
 * identifier does not exist until the model is registered. This is the way out — register first,
 * then govern.
 */
export function governedOrchestrator(
  fixture: OrchestratorFixture,
  options: {
    readonly policyEngine?: PolicyEngine | null;
    readonly budgetEngine?: BudgetEngine | null;
    readonly defaultPolicyIds?: readonly PolicyId[];
    readonly defaultBudgetId?: BudgetId | null;
    readonly retryDelayMs?: number;
    readonly defaultTimeoutMs?: number;
    readonly estimateHolds?: ModelOrchestratorOptions["estimateHolds"];
  } = {},
): InMemoryModelOrchestrator {
  return new InMemoryModelOrchestrator({
    modelRegistry: fixture.modelRegistry,
    providerRegistry: fixture.providerRegistry,
    tracer: fixture.tracer,
    clock: fixture.clock,
    policyEngine: options.policyEngine ?? null,
    budgetEngine: options.budgetEngine ?? null,
    ...(options.defaultPolicyIds === undefined
      ? {}
      : { defaultPolicyIds: options.defaultPolicyIds }),
    ...(options.defaultBudgetId === undefined ? {} : { defaultBudgetId: options.defaultBudgetId }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.estimateHolds === undefined ? {} : { estimateHolds: options.estimateHolds }),
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** A minimal call request, overridable field by field. */
export function modelCall(
  overrides: Partial<ModelCallRequest> & { model: ModelCallRequest["model"] },
): ModelCallRequest {
  return {
    messages: [userMessage("hello")],
    ...overrides,
  };
}

/** One tool spec, built with the published parameter-schema builder. */
export function toolSpec(
  name = "search",
  overrides: {
    readonly toolId?: ToolId;
    readonly description?: string;
    readonly required?: readonly string[];
  } = {},
): ModelToolSpec {
  return {
    toolId: overrides.toolId ?? createToolId(),
    name,
    description: overrides.description ?? `the ${name} tool`,
    parameters: toolParameterSchema(
      {
        query: {
          type: "string",
          description: "what to look for",
          enumValues: [],
          items: null,
          nullable: false,
        },
      },
      [...(overrides.required ?? [])],
    ),
  };
}

/** A user message with one text part. */
export function userMessage(text: string): ModelCallRequest["messages"][number] {
  return { role: "user", content: [{ type: "text", text }], name: null, metadata: {} };
}

/** The stream events a completed answer is made of. */
export function scriptedStream(
  modelId: ModelId,
  providerId: ProviderId,
  text = "streamed",
  usage: UsageSummary = usageOf(12, 34, 4),
): readonly ModelStreamEvent[] {
  return [
    { type: "started", modelId, providerId },
    { type: "delta", text },
    { type: "usage", usage },
    { type: "completed", stopReason: "stop", latencyMs: 7 },
  ];
}

/**
 * A stream script that needs no identifiers.
 *
 * The identifiers on a `started` event describe what the adapter believes it is serving; the
 * orchestrator stamps the resolved ones onto the response it reports, so a fixture may use
 * placeholders.
 */
export function streamScript(
  text = "streamed",
  usage: UsageSummary = usageOf(12, 34, 4),
  stopReason: "stop" | "length" | "tool_calls" = "stop",
): readonly ModelStreamEvent[] {
  return scriptedStream(PLACEHOLDER_MODEL_ID, PLACEHOLDER_PROVIDER_ID, text, usage).map((event) =>
    event.type === "completed" ? { ...event, stopReason } : event,
  );
}

/** Collects a stream into an array, so a test can assert on the whole sequence. */
export async function collect(
  stream: AsyncGenerator<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
