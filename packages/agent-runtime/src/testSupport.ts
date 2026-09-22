/**
 * Fixtures for the agent runtime's tests.
 *
 * Not exported from `index.ts`: these exist to make a test read as a statement
 * about behaviour rather than as an assembly manual. Everything here is a real
 * implementation — a real kernel, a real policy engine, a real event bus — with the
 * parts that would need a network or a vendor replaced by scripts.
 *
 * The step executor is the seam that matters. The runtime never calls a model or a
 * tool, so a test that wants "the model step succeeded" registers an executor for
 * the `model` kind with the kernel, exactly as a composition root would. If a test
 * could make the runtime call a provider directly, the fixture would be lying about
 * the architecture.
 */

import {
  createEventRegistry,
  createInMemoryEventBus,
  PLATFORM_EVENT_DEFINITIONS,
} from "@omnis/events";
import type { EventBus } from "@omnis/events";
import {
  createAgentId,
  createCorrelationId,
  createExecutionId,
  createSpanId,
  createTraceId,
  createTenantId,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonValue, TenantId } from "@omnis/types";
import { createPolicyEngine } from "@omnis/policy-engine";
import type { PolicyEngine } from "@omnis/policy-engine";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import type { BudgetEngine } from "@omnis/budget-engine";
import { InMemoryExecutionKernel, stepExecutor } from "@omnis/execution-kernel";
import type { ExecutionKernel, StepEnvironment, StepOutcome } from "@omnis/execution-kernel";
import { succeededOutcome } from "@omnis/execution-kernel";
import type {
  AgentDescriptor,
  AgentId,
  AgentStateName,
  AiCoreMetadata,
  BudgetId,
  ExecutionKind,
  ExecutionRequest,
  ExecutionStep,
  PolicyId,
} from "@omnis/ai-core-types";
import type {
  Span,
  SpanContext,
  StartSpanOptions,
  TelemetryAttributes,
  Tracer,
} from "@omnis/telemetry";
import { createAgentRegistry } from "./AgentRegistry.js";
import type { AgentRegistry } from "./AgentRegistry.js";
import { createAgentRuntime } from "./AgentRuntime.js";
import type { AgentRunOptions, AgentRuntime, AgentRuntimeOptions } from "./AgentRuntime.js";
import { createAgentEventPublisher } from "./agentEvents.js";
import type { AgentEventPublisher, AgentStateChangeFact } from "./agentEvents.js";
import type { AgentRegistrationInput, AgentRunInput } from "./agentValidation.js";

/** The instant every fixture record is stamped with. */
export const AT = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** A clock a test moves by hand, so nothing depends on how fast a machine is. */
export interface TestClock {
  (): number;
  advance(ms: number): number;
  readonly now: number;
}

/** Creates a clock starting at a fixed instant. */
export function testClock(startMs: number = Date.parse(AT)): TestClock {
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

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** A span as recorded. */
export interface RecordedSpan extends Span {
  readonly recordedName: string;
  readonly recordedAttributes: Record<string, string | number | boolean | null>;
  readonly recordedStatuses: { readonly status: string; readonly message: string | undefined }[];
  readonly recordedExceptions: unknown[];
}

/** A tracer that records what the runtime asked it to record. */
export function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    name: parseTrimmedString("agent-test-tracer"),
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
        get recordedStatuses(): { status: string; message: string | undefined }[] {
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
// Step executors
// ---------------------------------------------------------------------------

/** One recorded step execution. */
export interface RecordedStep {
  readonly step: ExecutionStep;
  readonly environment: StepEnvironment;
}

/** A step executor that returns scripted outcomes and records what it was asked to run. */
export interface ScriptedExecutor {
  readonly kind: ExecutionKind;
  readonly executed: readonly RecordedStep[];
  /** Replaces the outcomes the executor returns, in order. */
  script(outcomes: readonly StepOutcome[]): void;
  execute(step: ExecutionStep, environment: StepEnvironment): Promise<StepOutcome>;
}

/** Creates an executor for one step kind. */
export function scriptedExecutor(
  kind: ExecutionKind,
  outcomes: readonly StepOutcome[] = [succeededOutcome({ answered: true })],
): ScriptedExecutor {
  const executed: RecordedStep[] = [];
  let scripted = [...outcomes];
  let calls = 0;

  /** The outcome for one call: the script's last entry repeats once it is exhausted. */
  const outcomeAt = (index: number): StepOutcome => {
    if (scripted.length === 0) {
      return succeededOutcome({ answered: true });
    }
    return scripted[Math.min(index, scripted.length - 1)] as StepOutcome;
  };

  const executor: ScriptedExecutor = {
    kind,
    get executed(): readonly RecordedStep[] {
      return executed;
    },
    script(next: readonly StepOutcome[]): void {
      scripted = [...next];
      calls = 0;
    },
    async execute(step: ExecutionStep, environment: StepEnvironment): Promise<StepOutcome> {
      executed.push({ step, environment });
      const outcome = outcomeAt(calls);
      calls += 1;
      return outcome;
    },
  };
  return executor;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** An event publisher that records facts instead of publishing them. */
export interface RecordingEventPublisher extends AgentEventPublisher {
  readonly stateChanges: readonly AgentStateChangeFact[];
  readonly stepEvents: readonly {
    readonly kind: "completed" | "failed";
    readonly stepId: string;
    readonly attempt: number;
  }[];
}

/** Creates a publisher that records what the runtime asked it to publish. */
export function recordingEventPublisher(): RecordingEventPublisher {
  const stateChanges: AgentStateChangeFact[] = [];
  const stepEvents: { kind: "completed" | "failed"; stepId: string; attempt: number }[] = [];
  return {
    get stateChanges(): readonly AgentStateChangeFact[] {
      return stateChanges;
    },
    get stepEvents(): readonly {
      readonly kind: "completed" | "failed";
      readonly stepId: string;
      readonly attempt: number;
    }[] {
      return stepEvents;
    },
    stateChanged(fact: AgentStateChangeFact): void {
      stateChanges.push(fact);
    },
    stepCompleted(_executionId, _agentId, step, attempt): void {
      stepEvents.push({ kind: "completed", stepId: step.id, attempt: attempt.attempt });
    },
    stepFailed(_executionId, _agentId, step, attempt): void {
      stepEvents.push({ kind: "failed", stepId: step.id, attempt: attempt.attempt });
    },
    publishFailures(): readonly [] {
      return Object.freeze([]);
    },
  };
}

/** A real bus, seeded with the platform vocabulary, and the envelopes it accepted. */
export interface BusFixture {
  readonly bus: EventBus;
  readonly published: readonly { readonly type: string; readonly payload: JsonValue }[];
  readonly publisher: AgentEventPublisher;
  readonly tenantId: TenantId;
}

/** Creates a bus that validates every payload against the registered `ai.*` contracts. */
export function busFixture(tenantId: TenantId = createTenantId()): BusFixture {
  const registry = createEventRegistry();
  registry.registerAll(PLATFORM_EVENT_DEFINITIONS);
  const bus = createInMemoryEventBus(registry);
  const published: { type: string; payload: JsonValue }[] = [];
  bus.subscribeAll((event) => {
    published.push({ type: String(event.type), payload: event.payload });
  });
  return {
    bus,
    tenantId,
    get published(): readonly { readonly type: string; readonly payload: JsonValue }[] {
      return published;
    },
    publisher: createAgentEventPublisher({ bus, tenantId }),
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Registers an agent with the least interesting descriptor there is. */
export function registerAgent(
  registry: AgentRegistry,
  overrides: Partial<AgentRegistrationInput> = {},
): AgentDescriptor {
  return registry.register({
    slug: "assistant",
    displayName: "Assistant",
    description: "A fixture agent.",
    kind: "reactive",
    status: "active",
    version: "1.0.0",
    capabilities: ["tool_use"],
    instructions: { system: "Answer briefly.", prohibitions: ["never invent a citation"] },
    ...overrides,
  });
}

/** A minimal, valid execution request, for tests that plan without running. */
export function executionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return Object.freeze({
    id: createExecutionId(),
    kind: "agent",
    correlationId: createCorrelationId(),
    causationId: null,
    traceId: null,
    tenantId: null,
    parentExecutionId: null,
    agentId: createAgentId(),
    model: null,
    tool: null,
    input: Object.freeze({}),
    mode: "interactive",
    priority: "normal",
    policyId: null,
    budgetId: null,
    deadlineMs: null,
    metadata: Object.freeze({}),
    requestedAt: AT,
    ...overrides,
  });
}

/** A run input with a goal and nothing else. */
export function agentRun(
  goal: string = "summarise the brief",
  data: AiCoreMetadata = {},
): AgentRunInput {
  return { goal, data };
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/** What a fixture holds, so a test can assert on any layer of it. */
export interface AgentFixture {
  readonly registry: AgentRegistry;
  readonly kernel: ExecutionKernel;
  readonly runtime: AgentRuntime;
  readonly policyEngine: PolicyEngine;
  readonly budgetEngine: BudgetEngine;
  readonly clock: TestClock;
  readonly spans: readonly RecordedSpan[];
  /** The publisher the runtime uses. */
  readonly events: AgentEventPublisher;
  /** The recorder behind it, whether or not the runtime publishes to a bus. */
  readonly recorded: RecordingEventPublisher;
  readonly bus: BusFixture;
  readonly modelExecutor: ScriptedExecutor;
  readonly toolExecutor: ScriptedExecutor;
  readonly agent: AgentDescriptor;
}

/** How a fixture is assembled. */
export interface AgentFixtureOptions {
  /** A registry to use instead of the one the fixture builds. Its first agent is `fixture.agent`. */
  readonly registry?: AgentRegistry | null;
  readonly agents?: readonly Partial<AgentRegistrationInput>[];
  readonly clock?: TestClock;
  readonly policyEngine?: PolicyEngine | null;
  readonly budgetEngine?: BudgetEngine | null;
  readonly kernel?: ExecutionKernel | null;
  readonly runtime?: Partial<AgentRuntimeOptions>;
  readonly defaultPolicyIds?: readonly PolicyId[];
  readonly modelOutcomes?: readonly StepOutcome[];
  readonly toolOutcomes?: readonly StepOutcome[];
  /** `"bus"` publishes through a real bus that validates every payload. */
  readonly events?: AgentEventPublisher | "bus" | null;
  readonly tenantId?: TenantId;
}

/**
 * Builds a registry, a kernel with scripted executors, a policy engine, a budget
 * engine, a recording tracer and a runtime in one call.
 *
 * With no arguments it produces one active agent, one model executor that succeeds
 * and one tool executor that succeeds — the least interesting run there is, which is
 * what a test wants to start from.
 */
export function agentFixture(options: AgentFixtureOptions = {}): AgentFixture {
  const clock = options.clock ?? testClock();
  const registry = options.registry ?? createAgentRegistry({ clock: () => clock() });
  const policyEngine =
    options.policyEngine === null
      ? null
      : (options.policyEngine ?? createPolicyEngine({ clock: () => AT }));
  const budgetEngine =
    options.budgetEngine === null
      ? null
      : (options.budgetEngine ?? new InMemoryBudgetEngine({ clock: () => AT }));
  const modelExecutor = scriptedExecutor(
    "model",
    options.modelOutcomes ?? [succeededOutcome({ answered: true })],
  );
  const toolExecutor = scriptedExecutor(
    "tool",
    options.toolOutcomes ?? [succeededOutcome({ toolRan: true })],
  );
  // One tracer for the runtime and the kernel: a run is one trace, and a test that could
  // only see the agent's own spans could not check that the kernel's nested under it.
  const { tracer, spans } = recordingTracer();

  const kernel =
    options.kernel ??
    new InMemoryExecutionKernel({
      clock: () => clock(),
      tracer,
      policyEngine,
      budgetEngine,
      executors: [
        stepExecutor(modelExecutor.kind, (step, environment) =>
          modelExecutor.execute(step, environment),
        ),
        stepExecutor(toolExecutor.kind, (step, environment) =>
          toolExecutor.execute(step, environment),
        ),
      ],
      defaultDeadlineMs: null,
      retryDelayMs: 0,
    });

  const recorded = recordingEventPublisher();
  const bus = busFixture(options.tenantId);
  const events = options.events === "bus" ? bus.publisher : (options.events ?? recorded);

  const agents =
    options.registry !== undefined && options.registry !== null
      ? options.registry.list().map((descriptor) => descriptor)
      : (options.agents ?? [{}]).map((overrides) => registerAgent(registry, overrides));
  const agent = agents[0] as AgentDescriptor;

  const runtime = createAgentRuntime({
    registry,
    kernel,
    policyEngine,
    events,
    tracer,
    clock: () => clock(),
    resolvers: {
      // The fixture has no model or tool registry: a step that names one resolves by
      // slug to a deterministic placeholder, which is enough to prove the plumbing.
      modelId: (reference) => (reference.kind === "id" ? reference.modelId : null),
      toolId: (reference) => (reference.kind === "id" ? reference.toolId : null),
    },
    defaultPolicyIds: options.defaultPolicyIds ?? [],
    ...options.runtime,
  });

  return {
    registry,
    kernel,
    runtime,
    policyEngine: policyEngine ?? createPolicyEngine({ clock: () => AT }),
    budgetEngine: budgetEngine ?? new InMemoryBudgetEngine({ clock: () => AT }),
    clock,
    spans,
    events,
    recorded,
    bus,
    modelExecutor,
    toolExecutor,
    agent,
  };
}

/** The states an instance passed through, in order. */
export function statesOf(facts: readonly AgentStateChangeFact[]): readonly AgentStateName[] {
  const [first] = facts;
  return Object.freeze([
    ...(first === undefined ? [] : [first.from]),
    ...facts.map((fact) => fact.to),
  ]);
}

/** A policy set that denies everything, for testing the gate. */
export function denyAllPolicy(engine: PolicyEngine = createPolicyEngine({ clock: () => AT })): {
  engine: PolicyEngine;
  policyId: PolicyId;
} {
  const set = engine.registerPolicySet({
    name: "fixture-deny-all",
    description: "Denies every action, so a test can prove the gate runs before the work.",
    rules: [{ id: "deny-everything", name: "deny everything", outcome: "deny" }],
    defaultOutcome: "deny",
    createdAt: AT,
  });
  return { engine, policyId: set.id };
}

/** A policy set that requires an approval for everything, for testing the waiting state. */
export function approvalPolicy(engine: PolicyEngine = createPolicyEngine({ clock: () => AT })): {
  engine: PolicyEngine;
  policyId: PolicyId;
} {
  const set = engine.registerPolicySet({
    name: "fixture-approval",
    description:
      "Requires an approval for every action, so a test can prove the agent waits rather than fails.",
    rules: [{ id: "require-approval", name: "require an approval", outcome: "require_approval" }],
    defaultOutcome: "require_approval",
    createdAt: AT,
  });
  return { engine, policyId: set.id };
}

/** A budget that cannot cover anything, for testing the reservation gate. */
export function tinyBudget(engine: BudgetEngine = new InMemoryBudgetEngine({ clock: () => AT })): {
  engine: BudgetEngine;
  budgetId: BudgetId;
} {
  const budget = engine.registerBudget({
    name: "fixture-tiny",
    limits: [{ dimension: "requests", window: "execution", limit: 0 }],
    createdAt: AT,
  });
  return { engine, budgetId: budget.id };
}

/** A kernel that refuses every run, for testing what the runtime does with a refusal. */
export function refusingKernel(reason: string): ExecutionKernel {
  const kernel = new InMemoryExecutionKernel({ clock: () => Date.parse(AT) });
  return {
    ...kernel,
    get size(): number {
      return kernel.size;
    },
    registerExecutor: kernel.registerExecutor.bind(kernel),
    executorFor: kernel.executorFor.bind(kernel),
    unregisterExecutor: kernel.unregisterExecutor.bind(kernel),
    create: kernel.create.bind(kernel),
    getExecution: kernel.getExecution.bind(kernel),
    requireExecution: kernel.requireExecution.bind(kernel),
    listExecutions: kernel.listExecutions.bind(kernel),
    async execute(): Promise<never> {
      throw new Error(reason);
    },
    cancel: kernel.cancel.bind(kernel),
    transition: kernel.transition.bind(kernel),
    dispose: kernel.dispose.bind(kernel),
  };
}

/** Run options that name a tenant, so an envelope can be minted. */
export function runOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return { tenantId: createTenantId(), ...overrides };
}

/** The identifier of the agent a fixture registered first. */
export function agentIdOf(fixture: AgentFixture): AgentId {
  return fixture.agent.id;
}
