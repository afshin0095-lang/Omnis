/**
 * The AI Core's composition root.
 *
 * Everything else in the AI Core is a package with one job: a registry remembers, a policy
 * engine decides, a budget engine accounts, an orchestrator calls models, a tool runtime
 * invokes tools, a kernel runs plans, an agent runtime drives agents. This file is the only
 * place those are wired together, and it is deliberately thin — it holds no execution logic
 * of its own, because a composition root that also decided things would be a second kernel.
 *
 * What it does hold is three commitments:
 *
 * 1. **Governance is not optional.** A policy engine, a budget engine and an evaluation
 *    engine always exist. A caller may inject their own; nobody may compose a runtime
 *    without them. A runtime that could be built ungoverned would eventually be.
 * 2. **One clock, one tracer, one set of registries.** Every composed part receives the
 *    same injected clock and tracer, so a run's timestamps and spans agree with each other
 *    instead of each subsystem reporting its own idea of when things happened.
 * 3. **The parts stay reachable.** Each composed object is exposed read-only, so a caller
 *    who needs the orchestrator's candidate ordering or the tool registry's risk filter can
 *    have it without this file growing a forwarding method for every one.
 */

import {
  createAgentEventPublisher,
  createAgentRegistry,
  createAgentRuntime,
  NOOP_AGENT_EVENT_PUBLISHER,
} from "@omnis/agent-runtime";
import type {
  AgentRegistrationInput,
  AgentRegistry,
  AgentRunInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntime,
} from "@omnis/agent-runtime";
import { createEvaluationEngine } from "@omnis/ai-evaluation";
import type {
  EvaluationEngine,
  EvaluationOptions,
  EvaluationRuleSet,
  EvaluationRuleSetInput,
} from "@omnis/ai-evaluation";
import { createExecutionFailure, isModelReference } from "@omnis/ai-core-types";
import type {
  AgentDescriptor,
  AgentReference,
  Budget,
  BudgetId,
  EvaluationInput,
  EvaluationResult,
  ExecutionId,
  ExecutionRecord,
  ModelDescriptor,
  ModelReference,
  ModelStreamEvent,
  PolicyId,
  PolicySet,
  ProviderAdapter,
  ProviderDescriptor,
  ToolDescriptor,
  ToolHandler,
  ToolResult,
} from "@omnis/ai-core-types";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import type { BudgetEngine, BudgetInput } from "@omnis/budget-engine";
import { ValidationError } from "@omnis/errors";
import {
  createInMemoryEventBus,
  createEventRegistry,
  PLATFORM_EVENT_DEFINITIONS,
} from "@omnis/events";
import type { EventBus } from "@omnis/events";
import { systemClock } from "@omnis/execution-context";
import type { Clock, ExecutionContext } from "@omnis/execution-context";
import { InMemoryExecutionKernel } from "@omnis/execution-kernel";
import type { ExecutionKernel } from "@omnis/execution-kernel";
import { createModelOrchestrator } from "@omnis/model-orchestrator";
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelOrchestrator,
} from "@omnis/model-orchestrator";
import { createModelRegistry } from "@omnis/model-registry";
import type { ModelRegistrationInput, ModelRegistry } from "@omnis/model-registry";
import { createPolicyEngine } from "@omnis/policy-engine";
import type { PolicyEngine, PolicySetInput } from "@omnis/policy-engine";
import { createProviderRegistry } from "@omnis/provider-registry";
import type { ProviderRegistrationInput, ProviderRegistry } from "@omnis/provider-registry";
import { createNoopTracer } from "@omnis/telemetry";
import type { Tracer } from "@omnis/telemetry";
import { createConcurrencyGate, createToolRegistry, createToolRuntime } from "@omnis/tool-runtime";
import type {
  AuditSink,
  ToolDescriptorInput,
  ToolInvocationRequest,
  ToolRegistry,
  ToolRuntime,
} from "@omnis/tool-runtime";
import { parseTrimmedString } from "@omnis/types";
import type { TenantId } from "@omnis/types";
import { modelStepExecutor, toolStepExecutor } from "./stepExecutors.js";
import { aiCoreHealth, describeAiCoreRuntime } from "./runtimeHealth.js";
import type { AiCoreHealth } from "./runtimeHealth.js";

/** The contract name a composition error reports against. */
export const AI_CORE_RUNTIME_CONTRACT = "AiCoreRuntimeOptions";

/** How a runtime is composed. Every part is injectable; every governance part is mandatory. */
export interface AiCoreRuntimeOptions {
  /** Epoch-millisecond clock shared by every composed part. */
  readonly clock?: Clock;
  /** Tracer shared by every composed part, so one run is one trace. */
  readonly tracer?: Tracer;
  readonly policyEngine?: PolicyEngine | null;
  readonly budgetEngine?: BudgetEngine | null;
  readonly evaluation?: EvaluationEngine | null;
  readonly models?: ModelRegistry | null;
  readonly providers?: ProviderRegistry | null;
  readonly tools?: ToolRegistry | null;
  readonly agents?: AgentRegistry | null;
  /**
   * The bus agent lifecycle events are published to.
   *
   * Optional because publishing is infrastructure a caller may not have wired yet. When it
   * is supplied, {@link AiCoreRuntimeOptions.tenantId} must be too: an event envelope
   * requires a tenant, and a runtime cannot invent one without putting platform work into
   * somebody's audit view.
   */
  readonly events?: EventBus | null;
  readonly tenantId?: TenantId | null;
  /** Where tool audit records go. Defaults to the tool runtime's own discarding sink. */
  readonly audit?: AuditSink | null;
  /** Policy sets every model call, tool invocation and agent run is gated by. */
  readonly defaultPolicyIds?: readonly PolicyId[];
  /** Budget every execution charges unless the caller names another. */
  readonly defaultBudgetId?: BudgetId | null;
  /** Default execution deadline, or `null` for unbounded. */
  readonly defaultDeadlineMs?: number | null;
  /** Delay between retries. Zero keeps a test run deterministic and instant. */
  readonly retryDelayMs?: number;
  /** How many agent instances the agent runtime tracks at once. */
  readonly maxAgentInstances?: number;
  /** Rule set the kernel grades executions with. Defaults to the shipped rule set. */
  readonly evaluationRuleSet?: string | null;
}

/** The composed runtime's surface. */
export interface AiCoreRuntime {
  // -- the composed parts, exposed so a caller never has to build a second composition --
  readonly models: ModelRegistry;
  readonly providers: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly policy: PolicyEngine;
  readonly budgets: BudgetEngine;
  readonly evaluation: EvaluationEngine;
  readonly kernel: ExecutionKernel;
  readonly orchestrator: ModelOrchestrator;
  readonly toolRuntime: ToolRuntime;
  readonly agentRuntime: AgentRuntime;
  /** The bus agent events are published to, or `null` when the composition has none. */
  readonly events: EventBus | null;

  // -- registration --
  registerModel(input: ModelRegistrationInput): ModelDescriptor;
  registerProvider(input: ProviderRegistrationInput, adapter: ProviderAdapter): ProviderDescriptor;
  registerTool(input: ToolDescriptorInput, handler: ToolHandler): ToolDescriptor;
  registerAgent(input: AgentRegistrationInput): AgentDescriptor;
  registerPolicySet(input: PolicySetInput): PolicySet;
  registerBudget(input: BudgetInput): Budget;
  registerRuleSet(input: EvaluationRuleSetInput): EvaluationRuleSet;

  // -- execution --
  /** One model call, through selection, policy, budget, retry and fallback. */
  executeModel(
    request: ModelCallRequest,
    context?: ExecutionContext | null,
  ): Promise<ModelCallResult>;
  /** One streaming model call. Always ends with a `completed` or `failed` event. */
  streamModel(
    request: ModelCallRequest,
    context?: ExecutionContext | null,
  ): AsyncGenerator<ModelStreamEvent>;
  /** One tool invocation, through permissions, policy, approval and a timeout. */
  executeTool(request: ToolInvocationRequest): Promise<ToolResult>;
  /** One agent run: resolve, plan, gate, execute, settle. */
  executeAgent(
    reference: AgentReference,
    input: AgentRunInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
  /** Continues an agent run that stopped waiting for an approval. */
  approveAgent(
    executionId: ExecutionId,
    approval: AgentRunOptions["approval"],
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
  /** Stops an agent run, or records an idle agent instance as cancelled. */
  cancelAgent(executionId: ExecutionId, reason: string): Promise<AgentRunResult["instance"]>;
  /** Grades one execution's output with deterministic rules. */
  evaluate(input: EvaluationInput, options?: EvaluationOptions): EvaluationResult;

  // -- inspection and control --
  getExecution(executionId: ExecutionId): ExecutionRecord | null;
  requireExecution(executionId: ExecutionId): ExecutionRecord;
  listExecutions(): readonly ExecutionRecord[];
  cancelExecution(executionId: ExecutionId, reason: string): Promise<ExecutionRecord>;

  /** What this composition holds, as a JSON-safe snapshot. */
  health(): AiCoreHealth;
  /** Releases every composed part that holds resources. */
  dispose(): void;
}

/** An in-memory bus with every platform event definition registered. */
export function createAiCoreEventBus(): EventBus {
  const registry = createEventRegistry();
  registry.registerAll(PLATFORM_EVENT_DEFINITIONS);
  return createInMemoryEventBus(registry);
}

/** The composed runtime. */
class ComposedAiCoreRuntime implements AiCoreRuntime {
  readonly models: ModelRegistry;
  readonly providers: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly policy: PolicyEngine;
  readonly budgets: BudgetEngine;
  readonly evaluation: EvaluationEngine;
  readonly kernel: ExecutionKernel;
  readonly orchestrator: ModelOrchestrator;
  readonly toolRuntime: ToolRuntime;
  readonly agentRuntime: AgentRuntime;
  readonly events: EventBus | null;

  readonly #clock: Clock;
  readonly #tracer: Tracer;
  readonly #evaluationRuleSet: string | null;
  readonly #defaultPolicyIds: readonly PolicyId[];
  readonly #disposables: { dispose(): void }[] = [];

  constructor(options: AiCoreRuntimeOptions = {}) {
    if (
      options.events !== undefined &&
      options.events !== null &&
      (options.tenantId === undefined || options.tenantId === null)
    ) {
      // Refused at composition rather than at the first publish: a bus with no tenant would
      // fail every event, and a run would keep succeeding while nobody could see it.
      throw new ValidationError(
        `${AI_CORE_RUNTIME_CONTRACT}: an event bus requires a tenantId to publish under`,
        {
          metadata: { field: "tenantId" },
        },
      );
    }

    this.#clock = options.clock ?? systemClock;
    this.#tracer = options.tracer ?? createNoopTracer(parseTrimmedString("ai-core-runtime"));
    this.#evaluationRuleSet = options.evaluationRuleSet ?? null;
    this.#defaultPolicyIds = Object.freeze([...(options.defaultPolicyIds ?? [])]);
    const iso = (): string => new Date(this.#clock()).toISOString();

    this.policy = options.policyEngine ?? createPolicyEngine({ clock: iso });
    this.budgets = options.budgetEngine ?? new InMemoryBudgetEngine({ clock: iso });
    this.evaluation = options.evaluation ?? createEvaluationEngine({ clock: this.#clock });
    this.models = options.models ?? createModelRegistry({ clock: iso });
    this.providers = options.providers ?? createProviderRegistry({ clock: iso });
    this.tools = options.tools ?? createToolRegistry({ clock: iso });
    this.agents = options.agents ?? createAgentRegistry({ clock: this.#clock });
    this.events = options.events ?? null;

    this.orchestrator = createModelOrchestrator({
      modelRegistry: this.models,
      providerRegistry: this.providers,
      policyEngine: this.policy,
      budgetEngine: this.budgets,
      tracer: this.#tracer,
      clock: this.#clock,
      defaultPolicyIds: this.#defaultPolicyIds,
      ...(options.defaultBudgetId === undefined
        ? {}
        : { defaultBudgetId: options.defaultBudgetId }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    });

    this.toolRuntime = createToolRuntime({
      registry: this.tools,
      policyEngine: this.policy,
      tracer: this.#tracer,
      clock: this.#clock,
      concurrency: createConcurrencyGate(),
      defaultPolicyIds: this.#defaultPolicyIds,
      ...(options.audit === undefined || options.audit === null ? {} : { audit: options.audit }),
    });

    this.kernel = new InMemoryExecutionKernel({
      clock: this.#clock,
      policyEngine: this.policy,
      budgetEngine: this.budgets,
      tracer: this.#tracer,
      // The kernel runs steps; these two executors are what make a step into a governed call.
      executors: [
        modelStepExecutor({
          orchestrator: this.orchestrator,
          defaultPolicyIds: this.#defaultPolicyIds.map((id) => String(id)),
        }),
        toolStepExecutor({ runtime: this.toolRuntime, defaultPolicyIds: this.#defaultPolicyIds }),
      ],
      // Grading is part of the record, so the kernel is given the engine rather than asked
      // to call it: evaluation stays deterministic rules in another package's hands.
      evaluate: (input: EvaluationInput): EvaluationResult | null =>
        this.evaluation.evaluate(
          input,
          this.#evaluationRuleSet === null ? {} : { ruleSet: this.#evaluationRuleSet },
        ),
      ...(options.defaultDeadlineMs === undefined
        ? {}
        : { defaultDeadlineMs: options.defaultDeadlineMs }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    });

    const tenantId = options.tenantId ?? null;
    this.agentRuntime = createAgentRuntime({
      registry: this.agents,
      kernel: this.kernel,
      policyEngine: this.policy,
      tracer: this.#tracer,
      clock: this.#clock,
      events:
        this.events === null || tenantId === null
          ? NOOP_AGENT_EVENT_PUBLISHER
          : createAgentEventPublisher({ bus: this.events, tenantId }),
      // An agent's plan names models and tools by reference; the registries here are what
      // those references resolve against, so a plan can only contain work this composition
      // can actually govern.
      resolvers: {
        modelId: (reference: ModelReference) =>
          isModelReference(reference)
            ? (this.models.resolve(reference)?.descriptor.id ?? null)
            : null,
        toolId: (reference) => this.tools.resolve(reference)?.id ?? null,
      },
      defaultPolicyIds: this.#defaultPolicyIds,
      ...(options.defaultBudgetId === undefined
        ? {}
        : { defaultBudgetId: options.defaultBudgetId }),
      ...(options.maxAgentInstances === undefined
        ? {}
        : { maxInstances: options.maxAgentInstances }),
    });

    for (const part of [this.toolRuntime, this.agentRuntime, this.kernel]) {
      if (typeof part.dispose === "function") {
        this.#disposables.push(part);
      }
    }
  }

  registerModel(input: ModelRegistrationInput): ModelDescriptor {
    return this.models.register(input);
  }

  registerProvider(input: ProviderRegistrationInput, adapter: ProviderAdapter): ProviderDescriptor {
    return this.providers.register(input, adapter);
  }

  registerTool(input: ToolDescriptorInput, handler: ToolHandler): ToolDescriptor {
    return this.tools.register(input, handler);
  }

  registerAgent(input: AgentRegistrationInput): AgentDescriptor {
    return this.agents.register(input);
  }

  registerPolicySet(input: PolicySetInput): PolicySet {
    return this.policy.registerPolicySet(input);
  }

  registerBudget(input: BudgetInput): Budget {
    return this.budgets.registerBudget(input);
  }

  registerRuleSet(input: EvaluationRuleSetInput): EvaluationRuleSet {
    return this.evaluation.registerRuleSet(input);
  }

  executeModel(
    request: ModelCallRequest,
    context: ExecutionContext | null = null,
  ): Promise<ModelCallResult> {
    return this.orchestrator.call(request, context);
  }

  streamModel(
    request: ModelCallRequest,
    context: ExecutionContext | null = null,
  ): AsyncGenerator<ModelStreamEvent> {
    return this.orchestrator.stream(request, context);
  }

  executeTool(request: ToolInvocationRequest): Promise<ToolResult> {
    return this.toolRuntime.invoke(request);
  }

  executeAgent(
    reference: AgentReference,
    input: AgentRunInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.agentRuntime.run(reference, input, options);
  }

  approveAgent(
    executionId: ExecutionId,
    approval: AgentRunOptions["approval"],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    if (approval === undefined || approval === null) {
      // An approval of nothing is not a refusal, it is a mistake: a refusal is
      // `{ approved: false }`, and silently treating an absent one as granted would run
      // work a policy said needed a human.
      throw new ValidationError(
        "approveAgent requires an approval; a refusal is `{ approved: false }`",
        {
          metadata: { executionId: String(executionId) },
        },
      );
    }
    return this.agentRuntime.approve(executionId, approval, options);
  }

  cancelAgent(executionId: ExecutionId, reason: string): Promise<AgentRunResult["instance"]> {
    return this.agentRuntime.cancel(executionId, reason);
  }

  evaluate(input: EvaluationInput, options: EvaluationOptions = {}): EvaluationResult {
    return this.evaluation.evaluate(
      input,
      this.#evaluationRuleSet === null ? options : { ruleSet: this.#evaluationRuleSet, ...options },
    );
  }

  getExecution(executionId: ExecutionId): ExecutionRecord | null {
    return this.kernel.getExecution(executionId);
  }

  requireExecution(executionId: ExecutionId): ExecutionRecord {
    return this.kernel.requireExecution(executionId);
  }

  listExecutions(): readonly ExecutionRecord[] {
    return this.kernel.listExecutions();
  }

  cancelExecution(executionId: ExecutionId, reason: string): Promise<ExecutionRecord> {
    return this.kernel.cancel(executionId, reason);
  }

  health(): AiCoreHealth {
    // Stamped with the composition's own clock: a health snapshot taken from the wall clock
    // would disagree with every other timestamp in the same run.
    return aiCoreHealth(this, new Date(this.#clock()).toISOString());
  }

  dispose(): void {
    // Reverse order: the agent runtime stops asking the kernel for work before the kernel
    // stops accepting it, and the tool runtime releases handlers before the registries go.
    for (let index = this.#disposables.length - 1; index >= 0; index -= 1) {
      this.#disposables[index]?.dispose();
    }
    this.#disposables.length = 0;
  }
}

/** Composes the AI Core into one runtime. */
export function createAiCoreRuntime(options: AiCoreRuntimeOptions = {}): AiCoreRuntime {
  return new ComposedAiCoreRuntime(options);
}

/** A readable rendering of a composition, for logs and startup banners. */
export function describeRuntime(runtime: AiCoreRuntime): string {
  return describeAiCoreRuntime(runtime);
}

/**
 * The failure a step reports when the composition could not run it.
 *
 * Exported because a caller wiring their own kernel executors needs the same shape, and
 * because a step failure that is not an {@link ExecutionFailure} would be dropped by the
 * kernel's normalization instead of being recorded.
 */
export function compositionFailure(message: string, executionId: ExecutionId | null = null) {
  return createExecutionFailure({
    class: "non_retryable",
    code: "configuration_invalid",
    message,
    retryable: false,
    ...(executionId === null ? {} : { executionId }),
  });
}
