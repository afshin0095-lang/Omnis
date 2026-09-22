/**
 * The agent runtime: instances, lifecycle and the hand-off to the kernel.
 *
 * WHAT THIS PACKAGE DOES AND DOES NOT DO
 * --------------------------------------
 * It resolves an agent, decides what its run consists of, tracks the run's
 * lifecycle state, and hands a validated plan to the execution kernel. It never
 * calls a model, a tool or an evaluator: those are the kernel's registered step
 * executors, supplied by the layers that own them. An agent runtime that invoked a
 * provider directly would be a second execution path with no policy gate, no
 * reservation and no attempt record — exactly the thing the kernel exists to
 * prevent.
 *
 * ORDER OF OPERATIONS
 * -------------------
 * 1. **Resolve** the descriptor. A name no registry holds is an error, not an empty
 *    plan.
 * 2. **Status.** Only an `active` agent runs, so a draft or retired descriptor
 *    cannot be provoked into executing by a well-formed request.
 * 3. **Constraints → policy.** The descriptor's ceilings are registered as a policy
 *    set and handed to the kernel with the run, so the *kernel* enforces them at the
 *    same gate as every other policy.
 * 4. **Plan.** The planner turns the run input into steps, applying the same
 *    ceilings structurally. A rejected plan is reported before any budget is
 *    reserved for it.
 * 5. **Execute** through the kernel, with hooks that move the instance's state and
 *    publish `ai.agent.*` events.
 * 6. **Settle** the instance into a terminal state — or into `waiting`, when the
 *    reason the run stopped is that a human has not approved it yet.
 *
 * PAUSE IS NOT CANCEL
 * -------------------
 * The kernel has no suspend primitive, so a live execution cannot be paused: there
 * is nowhere to put the half-finished step. `pause` is therefore legal only before
 * a run starts or while the agent is waiting, and says so with a typed error
 * otherwise. Pretending otherwise — cancelling a run and calling the result
 * "paused" — would report a resumable state for work that has been destroyed.
 */

import { createCorrelationId, createExecutionId, parseTrimmedString } from "@omnis/types";
import type { CorrelationId, JsonValue, TenantId } from "@omnis/types";
import {
  assertJsonSafe,
  describeFailure,
  isExecutableAgentStatus,
  totalRecordUsage,
} from "@omnis/ai-core-types";
import type {
  AgentDescriptor,
  AgentId,
  AgentInstance,
  AgentReference,
  AgentStateName,
  BudgetId,
  EvaluationResult,
  ExecutionAttempt,
  ExecutionFailure,
  ExecutionId,
  ExecutionMode,
  ExecutionPlan,
  ExecutionPriority,
  ExecutionStep,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionStatus,
  PolicyId,
  UsageSummary,
} from "@omnis/ai-core-types";
import { isOmnisError, redactAttributes } from "@omnis/errors";
import { ExecutionScope, sanitizeMetadata, systemClock, toIso } from "@omnis/execution-context";
import type { Clock } from "@omnis/execution-context";
import { compositeHooks } from "@omnis/execution-kernel";
import type {
  ExecutionApproval,
  ExecutionHooks,
  ExecutionKernel,
  ExecutionRunOptions,
  StatusChange,
} from "@omnis/execution-kernel";
import type { PolicyEngine } from "@omnis/policy-engine";
import { aiSpanAttributes, NOOP_TRACER } from "@omnis/telemetry";
import type { Span, Tracer } from "@omnis/telemetry";
import { validate } from "@omnis/validation";
import { agentRunInputSchema } from "./agentValidation.js";
import type { AgentPlanResolvers, AgentPlanner } from "./agentPlanning.js";
import type { AgentRunInput } from "./agentValidation.js";
import { createAgentPlanner } from "./agentPlanning.js";
import type { AgentRegistry } from "./AgentRegistry.js";
import { assertAgentStateTransition } from "./AgentStateMachine.js";
import { AgentConstraintPolicies } from "./AgentConstraints.js";
import { guardAgentEventPublisher, NOOP_AGENT_EVENT_PUBLISHER } from "./agentEvents.js";
import type { AgentEventPublisher, AgentEventPublishFailure } from "./agentEvents.js";
import {
  agentCannotPauseWhileRunning,
  agentInstanceCapacityExceeded,
  agentInstanceNotFound,
  agentNotExecutable,
  invalidAgentRunInput,
} from "./errors.js";

/** The most agent instances a runtime tracks by default. */
export const DEFAULT_MAX_AGENT_INSTANCES = 256;

/**
 * Kernel statuses that move an agent, and the state each one means.
 *
 * The gate statuses — `created`, `validated`, `authorized`, `reserved`, `planned` —
 * are deliberately absent. They are the kernel's internal bookkeeping, and from an
 * agent's point of view the work has already started: mapping each of them to a
 * different agent state would produce a lifecycle that narrates the kernel's
 * implementation rather than the agent's progress.
 *
 * Terminal statuses are handled where the record is available, because "failed" and
 * "blocked on an approval" are the same kernel status and different agent states.
 */
export const AGENT_STATE_FOR_EXECUTION_STATUS: Readonly<
  Partial<Record<ExecutionStatus, AgentStateName>>
> = Object.freeze({
  running: "running",
  waiting: "waiting",
});

/** Runtime configuration. */
export interface AgentRuntimeOptions {
  readonly registry: AgentRegistry;
  readonly kernel: ExecutionKernel;
  /** When present, agent ceilings are registered as policy and enforced by the kernel. */
  readonly policyEngine?: PolicyEngine | null;
  /** When present, `ai.agent.*` events are published. */
  readonly events?: AgentEventPublisher | null;
  readonly tracer?: Tracer;
  readonly clock?: Clock;
  readonly planner?: AgentPlanner | null;
  /** How plan steps resolve model and tool references to identifiers. */
  readonly resolvers?: AgentPlanResolvers | null;
  readonly hooks?: ExecutionHooks | null;
  readonly defaultPolicyIds?: readonly PolicyId[];
  readonly defaultBudgetId?: BudgetId | null;
  readonly maxInstances?: number;
}

/** Options for one run. */
export interface AgentRunOptions {
  readonly executionId?: ExecutionId | null;
  readonly correlationId?: CorrelationId | null;
  readonly tenantId?: TenantId | null;
  readonly mode?: ExecutionMode | null;
  readonly priority?: ExecutionPriority | null;
  readonly deadlineMs?: number | null;
  readonly policyIds?: readonly PolicyId[] | null;
  readonly budgetId?: BudgetId | null;
  readonly approval?: ExecutionApproval | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly hooks?: ExecutionHooks | null;
  readonly parentExecutionId?: ExecutionId | null;
  /**
   * Which run this is within one instance lineage.
   *
   * The runtime sets it when an approved run replaces one that stopped waiting, so
   * an audit reader can see that two executions are the same decision rather than
   * two unrelated ones.
   */
  readonly attempt?: number;
}

/** What one agent run produced. */
export interface AgentRunResult {
  readonly instance: AgentInstance;
  readonly record: ExecutionRecord;
  readonly status: ExecutionStatus;
  readonly succeeded: boolean;
  /**
   * What the run produced when it succeeded, otherwise `null`.
   *
   * This is the kernel's own result value: for a plan of several steps it is an object
   * keyed by step identifier, because "the last step's output" would silently discard the
   * work the other steps did.
   */
  readonly output: JsonValue | null;
  readonly usage: UsageSummary;
  readonly evaluation: EvaluationResult | null;
  readonly failure: ExecutionFailure | null;
  /**
   * An agent ceiling this run crossed, or `null` when it stayed inside every one.
   *
   * Set even for a run that succeeded: a ceiling crossed by the final call cannot stop
   * anything, and reporting nothing would let a run that overspent look like one that
   * did not.
   */
  readonly ceilingBreach: string | null;
}

/** The runtime's public surface. */
export interface AgentRuntime {
  readonly registry: AgentRegistry;
  /** Instances currently tracked. */
  readonly size: number;

  instance(executionId: ExecutionId): AgentInstance | null;
  requireInstance(executionId: ExecutionId): AgentInstance;
  /** Instances for one agent, or every instance when no agent is named. */
  instances(agentId?: AgentId | null): readonly AgentInstance[];

  /** Creates an instance in `ready` without starting a run. */
  createInstance(reference: AgentReference, options?: AgentRunOptions): AgentInstance;

  /** Resolves, plans and runs an agent through the kernel. */
  run(
    reference: AgentReference,
    input: AgentRunInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;

  /** Moves an instance to another state, if the lifecycle allows it. */
  transition(executionId: ExecutionId, to: AgentStateName, reason?: string | null): AgentInstance;

  /** Suspends an instance that is not inside a live execution. */
  pause(executionId: ExecutionId, reason: string): AgentInstance;
  /** Returns a paused instance to `ready`. */
  resume(executionId: ExecutionId, reason?: string | null): AgentInstance;

  /** Asks a live execution to stop, or records an idle instance as cancelled. */
  cancel(executionId: ExecutionId, reason: string): Promise<AgentInstance>;

  /**
   * Starts a new run for an instance that stopped waiting for an approval.
   *
   * The waiting instance is cancelled — its execution is over, and the kernel has
   * no way to reopen it — and the approved run is a child of it, so the audit trail
   * still reads as one decision that needed a human.
   */
  approve(
    executionId: ExecutionId,
    approval: ExecutionApproval,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;

  /** Publish failures so far. Empty for a runtime with no bus. */
  publishFailures(): readonly AgentEventPublishFailure[];

  /** Cancels every live run and forgets every instance. */
  dispose(): void;
}

/** What the runtime remembers about one instance, beyond the published record. */
interface InstanceEntry {
  readonly key: string;
  readonly startedAtMs: number;
  instance: AgentInstance;
  descriptor: AgentDescriptor;
  /** The run input, kept so an approval can start the same run again. */
  run: {
    readonly reference: AgentReference;
    readonly input: AgentRunInput;
    readonly options: AgentRunOptions;
  } | null;
  live: boolean;
  /**
   * What this run has consumed against the ceilings the kernel does not enforce.
   *
   * The kernel bounds a plan's length, a step's retries and an execution's duration
   * from policy constraints. It has no notion of how many model or tool calls a plan
   * makes, or of what they cost, so those three ceilings are counted here — during the
   * run, where crossing one can still stop the next call.
   */
  readonly usage: { modelCalls: number; toolCalls: number; costMicroUsd: number };
  /** Why the runtime stopped a run itself, when it did. */
  ceilingBreach: string | null;
}

/** The failure that stopped a record, if one is recorded. */
function recordFailure(record: ExecutionRecord): ExecutionFailure | null {
  const result = record.result;
  if (result !== null && result.status !== "succeeded" && "failure" in result) {
    return result.failure;
  }
  for (let index = record.attempts.length - 1; index >= 0; index -= 1) {
    const failure = record.attempts[index]?.failure;
    if (failure !== null && failure !== undefined) {
      return failure;
    }
  }
  return null;
}

/**
 * True when a run stopped because a human has not approved it.
 *
 * The kernel reports this as a failure — it cannot proceed — but the agent is not
 * broken, it is blocked, and the two need different operator responses. The marker
 * is set by `approvalRequiredError` and survives into the failure's details.
 */
export function isApprovalRequiredFailure(failure: ExecutionFailure | null): boolean {
  return failure !== null && failure.details["approvalRequired"] === true;
}

/** The in-memory agent runtime. */
export class InMemoryAgentRuntime implements AgentRuntime {
  readonly #registry: AgentRegistry;
  readonly #kernel: ExecutionKernel;
  readonly #policyEngine: PolicyEngine | null;
  readonly #constraints: AgentConstraintPolicies | null;
  readonly #events: AgentEventPublisher;
  readonly #tracer: Tracer;
  readonly #clock: Clock;
  readonly #planner: AgentPlanner;
  readonly #resolvers: AgentPlanResolvers;
  readonly #hooks: ExecutionHooks | null;
  readonly #defaultPolicyIds: readonly PolicyId[];
  readonly #defaultBudgetId: BudgetId | null;
  readonly #maxInstances: number;

  readonly #entries = new Map<string, InstanceEntry>();
  readonly #keyByExecution = new Map<ExecutionId, string>();
  readonly #keysByAgent = new Map<AgentId, string[]>();
  #sequence = 0;

  constructor(options: AgentRuntimeOptions) {
    if (options.registry === undefined || options.registry === null) {
      throw invalidAgentRunInput("an agent runtime needs a registry");
    }
    if (options.kernel === undefined || options.kernel === null) {
      throw invalidAgentRunInput("an agent runtime needs an execution kernel");
    }
    this.#registry = options.registry;
    this.#kernel = options.kernel;
    this.#policyEngine = options.policyEngine ?? null;
    this.#constraints =
      this.#policyEngine === null ? null : new AgentConstraintPolicies(this.#policyEngine);
    // Guarded even when the publisher already guards itself: the interface is public, and a
    // throwing implementation must not be able to fail a run.
    this.#events = guardAgentEventPublisher(options.events ?? NOOP_AGENT_EVENT_PUBLISHER);
    this.#tracer = options.tracer ?? NOOP_TRACER;
    this.#clock = options.clock ?? systemClock;
    this.#planner = options.planner ?? createAgentPlanner({ clock: this.#clock });
    this.#resolvers = options.resolvers ?? {};
    this.#hooks = options.hooks ?? null;
    this.#defaultPolicyIds = Object.freeze([...(options.defaultPolicyIds ?? [])]);
    this.#defaultBudgetId = options.defaultBudgetId ?? null;
    this.#maxInstances = Math.max(
      1,
      Math.trunc(options.maxInstances ?? DEFAULT_MAX_AGENT_INSTANCES),
    );
  }

  get registry(): AgentRegistry {
    return this.#registry;
  }

  get size(): number {
    return this.#entries.size;
  }

  instance(executionId: ExecutionId): AgentInstance | null {
    const key = this.#keyByExecution.get(executionId);
    return key === undefined ? null : (this.#entries.get(key)?.instance ?? null);
  }

  requireInstance(executionId: ExecutionId): AgentInstance {
    const instance = this.instance(executionId);
    if (instance === null) {
      throw agentInstanceNotFound(executionId);
    }
    return instance;
  }

  instances(agentId: AgentId | null = null): readonly AgentInstance[] {
    const keys =
      agentId === null ? [...this.#entries.keys()] : (this.#keysByAgent.get(agentId) ?? []);
    return Object.freeze(
      keys
        .map((key) => this.#entries.get(key)?.instance)
        .filter((instance): instance is AgentInstance => instance !== undefined),
    );
  }

  createInstance(reference: AgentReference, options: AgentRunOptions = {}): AgentInstance {
    const descriptor = this.#registry.requireResolution(reference).descriptor;
    if (!isExecutableAgentStatus(descriptor.status)) {
      throw agentNotExecutable(descriptor.id, descriptor.slug, descriptor.status);
    }
    // A caller-supplied execution identifier makes the idle instance addressable: without
    // one there is nothing to name it by, and `pause`, `resume` and `cancel` all take an
    // execution identifier. Inventing one here would report an execution the kernel has
    // never seen.
    const entry = this.#openEntry(descriptor, options.executionId ?? null, options);
    this.#move(entry, "ready", "the instance was created and its descriptor accepted", null);
    return entry.instance;
  }

  async run(
    reference: AgentReference,
    input: AgentRunInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    // Thrown before an instance exists: there is no identifier to build a lifecycle around.
    const descriptor = this.#registry.requireResolution(reference).descriptor;
    if (!isExecutableAgentStatus(descriptor.status)) {
      throw agentNotExecutable(descriptor.id, descriptor.slug, descriptor.status);
    }

    const parsedInput = validate(agentRunInputSchema, input, "AgentRunInput");
    const entry = this.#openEntry(descriptor, null, options);
    entry.run = { reference, input: parsedInput, options };
    this.#move(entry, "ready", "the descriptor was accepted", null);

    const executionId = options.executionId ?? createExecutionId();
    const request = this.#buildRequest(descriptor, executionId, parsedInput, options);
    entry.instance = withExecution(entry.instance, executionId);
    this.#keyByExecution.set(executionId, entry.key);

    const policyIds = this.#policyIdsFor(descriptor, options);
    const span = this.#startSpan(descriptor, request);
    const scope = ExecutionScope.createRoot(
      {
        executionId,
        correlationId: request.correlationId,
        tenantId: request.tenantId,
        agentId: descriptor.id,
        traceId: span.context.traceId,
        parentSpanId: span.context.spanId,
        deadlineMs: request.deadlineMs,
        mode: request.mode,
        priority: request.priority,
        metadata: request.metadata,
      },
      { clock: this.#clock },
    );

    this.#move(entry, "planning", "the plan is being built", null);
    let plan: ExecutionPlan;
    try {
      plan = this.#planner.plan({
        descriptor,
        request,
        input: parsedInput,
        resolvers: this.#resolvers,
      });
    } catch (error) {
      this.#move(entry, "failed", planningFailureReason(error), null);
      this.#endSpan(span, entry, null, error);
      scope.dispose();
      throw error;
    }

    this.#move(entry, "running", `the plan has ${String(plan.steps.length)} step(s)`, null);
    entry.live = true;

    const runOptions: ExecutionRunOptions = {
      scope,
      plan,
      policyIds,
      budgetId: request.budgetId,
      approval: options.approval ?? null,
      metadata: request.metadata,
      hooks: compositeHooks(
        this.#runHooks(entry, span),
        this.#hooks ?? compositeHooks(),
        options.hooks ?? compositeHooks(),
      ),
    };

    let record: ExecutionRecord;
    try {
      record = await this.#kernel.execute(request, runOptions);
    } catch (error) {
      entry.live = false;
      this.#move(entry, "failed", kernelFailureReason(error), null);
      this.#endSpan(span, entry, null, error);
      scope.dispose();
      throw error;
    }

    entry.live = false;
    this.#settle(entry, record);
    this.#endSpan(span, entry, record, null);
    scope.dispose();
    return this.#result(entry, record);
  }

  transition(
    executionId: ExecutionId,
    to: AgentStateName,
    reason: string | null = null,
  ): AgentInstance {
    const entry = this.#requireEntry(executionId);
    this.#move(
      entry,
      to,
      reason ?? `an operator moved the agent to "${to}"`,
      to === "waiting" ? entry.instance.waitingOn : null,
    );
    return entry.instance;
  }

  pause(executionId: ExecutionId, reason: string): AgentInstance {
    const entry = this.#requireEntry(executionId);
    if (entry.live) {
      throw agentCannotPauseWhileRunning(executionId, entry.instance.state);
    }
    this.#move(entry, "paused", reason, null);
    return entry.instance;
  }

  resume(executionId: ExecutionId, reason: string | null = null): AgentInstance {
    const entry = this.#requireEntry(executionId);
    // Resuming returns to `ready` rather than to `running`: whether the next move is
    // to plan or to run is the caller's decision, and a runtime that guessed would
    // re-run a plan nobody asked for again.
    this.#move(entry, "ready", reason ?? "an operator resumed the agent", null);
    return entry.instance;
  }

  async cancel(executionId: ExecutionId, reason: string): Promise<AgentInstance> {
    const entry = this.#requireEntry(executionId);
    if (entry.live) {
      // The kernel owns the live run: asking it to stop is what makes the attempt
      // rows, the reservation and the record agree with the state change.
      await this.#kernel.cancel(executionId, reason);
    }
    if (entry.instance.state !== "cancelled") {
      this.#move(entry, "cancelled", reason, null);
    }
    return entry.instance;
  }

  async approve(
    executionId: ExecutionId,
    approval: ExecutionApproval,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const entry = this.#requireEntry(executionId);
    if (entry.instance.state !== "waiting" || entry.instance.waitingOn !== "approval") {
      throw invalidAgentRunInput(
        `execution ${String(executionId)} is "${entry.instance.state}" and is not waiting for an approval`,
      );
    }
    if (entry.run === null) {
      throw invalidAgentRunInput(
        `execution ${String(executionId)} has no recorded run input to approve`,
      );
    }
    const { reference, input, options: original } = entry.run;
    await this.cancel(executionId, "superseded by an approved run");
    return this.run(reference, input, {
      ...original,
      ...options,
      executionId: options.executionId ?? null,
      approval,
      attempt: entry.instance.attempt + 1,
      parentExecutionId: options.parentExecutionId ?? executionId,
    });
  }

  publishFailures(): readonly AgentEventPublishFailure[] {
    return this.#events.publishFailures();
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      const executionId = entry.instance.executionId;
      if (entry.live && executionId !== null) {
        // Disposal does not block on a kernel that may be slow, but the cancellation
        // is requested and a rejection is recorded rather than left unhandled.
        void this.#kernel
          .cancel(executionId, "the agent runtime was disposed")
          .catch(() => undefined);
      }
    }
    this.#entries.clear();
    this.#keyByExecution.clear();
    this.#keysByAgent.clear();
    this.#constraints?.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #requireEntry(executionId: ExecutionId): InstanceEntry {
    const key = this.#keyByExecution.get(executionId);
    const entry = key === undefined ? undefined : this.#entries.get(key);
    if (entry === undefined) {
      throw agentInstanceNotFound(executionId);
    }
    return entry;
  }

  #openEntry(
    descriptor: AgentDescriptor,
    executionId: ExecutionId | null,
    options: AgentRunOptions,
  ): InstanceEntry {
    if (this.#entries.size >= this.#maxInstances) {
      throw agentInstanceCapacityExceeded(this.#maxInstances);
    }
    this.#sequence += 1;
    const key = executionId === null ? `instance-${String(this.#sequence)}` : String(executionId);
    const startedAtMs = this.#clock();
    const now = toIso(startedAtMs);
    const entry: InstanceEntry = {
      key,
      startedAtMs,
      descriptor,
      run: null,
      live: false,
      usage: { modelCalls: 0, toolCalls: 0, costMicroUsd: 0 },
      ceilingBreach: null,
      instance: Object.freeze({
        agentId: descriptor.id,
        executionId,
        state: "created",
        descriptorVersion: descriptor.version,
        attempt: Math.max(1, Math.trunc(options.attempt ?? 1)),
        createdAt: now,
        updatedAt: now,
        waitingOn: null,
        metadata: sanitizeMetadata(
          {
            agentSlug: descriptor.slug,
            agentKind: descriptor.kind,
            ...(options.tenantId === undefined || options.tenantId === null
              ? {}
              : { tenantId: String(options.tenantId) }),
          },
          "agent instance metadata",
        ),
      }),
    };
    this.#entries.set(key, entry);
    const keys = this.#keysByAgent.get(descriptor.id) ?? [];
    keys.push(key);
    this.#keysByAgent.set(descriptor.id, keys);
    if (executionId !== null) {
      this.#keyByExecution.set(executionId, key);
    }
    return entry;
  }

  /** Moves an instance, refusing an illegal move and publishing the one that happened. */
  #move(
    entry: InstanceEntry,
    to: AgentStateName,
    reason: string | null,
    waitingOn: AgentInstance["waitingOn"],
  ): void {
    const from = entry.instance.state;
    if (from === to) {
      return;
    }
    assertAgentStateTransition(entry.instance.agentId, from, to);
    const changedAt = toIso(this.#clock());
    entry.instance = Object.freeze({
      ...entry.instance,
      state: to,
      // Only `waiting` carries what the agent is waiting for; anything else clears it,
      // so a stale `waitingOn` can never outlive the state it belongs to.
      waitingOn: to === "waiting" ? (waitingOn ?? "model_response") : null,
      updatedAt: changedAt,
    });
    this.#events.stateChanged({
      executionId: entry.instance.executionId,
      agentId: entry.instance.agentId,
      from,
      to,
      waitingOn: entry.instance.waitingOn,
      reason,
      changedAt,
    });
  }

  /** The request the kernel runs, built from the descriptor and the caller's options. */
  #buildRequest(
    descriptor: AgentDescriptor,
    executionId: ExecutionId,
    input: AgentRunInput,
    options: AgentRunOptions,
  ): ExecutionRequest {
    // The steps are not repeated here: they become the plan, and the plan is part of
    // the execution record. Two copies of a plan is two things that can disagree.
    const payload: Record<string, JsonValue> = {
      ...(input.goal === undefined || input.goal === null ? {} : { goal: input.goal }),
      ...(input.data ?? {}),
    };
    assertJsonSafe(payload, "agent run input");

    const metadata = sanitizeMetadata(
      redactAttributes({
        agentSlug: descriptor.slug,
        agentVersion: descriptor.version,
        agentKind: descriptor.kind,
        ...(options.metadata ?? {}),
      }),
      "agent execution metadata",
    );

    return Object.freeze({
      id: executionId,
      kind: "agent",
      correlationId: options.correlationId ?? createCorrelationId(),
      causationId: null,
      traceId: null,
      tenantId: options.tenantId ?? null,
      parentExecutionId: options.parentExecutionId ?? null,
      agentId: descriptor.id,
      model: descriptor.defaultModel,
      tool: null,
      input: Object.freeze(payload),
      mode: options.mode ?? "interactive",
      priority: options.priority ?? "normal",
      policyId: descriptor.policyId,
      budgetId: options.budgetId ?? descriptor.budgetId ?? this.#defaultBudgetId,
      deadlineMs: options.deadlineMs ?? descriptor.constraints.maxDurationMs,
      metadata,
      requestedAt: toIso(this.#clock()),
    });
  }

  /** The policy sets this run is gated by: the agent's own ceilings first. */
  #policyIdsFor(descriptor: AgentDescriptor, options: AgentRunOptions): readonly PolicyId[] {
    const ids: PolicyId[] = [];
    const constraintPolicy = this.#constraints?.policyIdFor(descriptor) ?? null;
    if (constraintPolicy !== null) {
      ids.push(constraintPolicy);
    }
    for (const id of [...(options.policyIds ?? []), ...this.#defaultPolicyIds]) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
    return Object.freeze(ids);
  }

  /** The hooks that make a kernel run visible as an agent lifecycle. */
  #runHooks(entry: InstanceEntry, span: Span): ExecutionHooks {
    return {
      onStatusChange: (change: StatusChange): void => {
        const state = AGENT_STATE_FOR_EXECUTION_STATUS[change.to];
        if (state === undefined) {
          return;
        }
        this.#move(
          entry,
          state,
          change.note ?? `the execution moved to "${change.to}"`,
          state === "waiting" ? "approval" : null,
        );
        span.setAttributes(aiSpanAttributes({ status: change.to }));
      },
      afterStep: (step, attempt): void => {
        const executionId = entry.instance.executionId;
        if (executionId === null) {
          return;
        }
        if (attempt.status === "succeeded") {
          this.#events.stepCompleted(executionId, entry.instance.agentId, step, attempt);
        } else {
          this.#events.stepFailed(executionId, entry.instance.agentId, step, attempt);
        }
        this.#enforceCeilings(entry, executionId, step, attempt);
      },
    };
  }

  /**
   * Counts one attempt against the ceilings the kernel does not enforce, and stops the
   * run when one is crossed.
   *
   * A skipped attempt is not a call: nothing was invoked, so nothing was consumed. The
   * cost of an attempt is only known after it runs, which is why this stops the *next*
   * call rather than the one that crossed the line — a ceiling that could only be
   * checked in advance would need pricing the runtime does not have, and a ceiling
   * checked only afterwards would report a limit after the money was spent.
   */
  #enforceCeilings(
    entry: InstanceEntry,
    executionId: ExecutionId,
    step: ExecutionStep,
    attempt: ExecutionAttempt,
  ): void {
    if (attempt.status === "skipped") {
      return;
    }
    const ceilings = entry.descriptor.constraints;
    if (step.kind === "model") {
      entry.usage.modelCalls += 1;
    } else if (step.kind === "tool") {
      entry.usage.toolCalls += 1;
    }
    if (attempt.usage.costMicro !== null) {
      entry.usage.costMicroUsd += attempt.usage.costMicro;
    }

    const breach =
      ceilings.maxModelCalls !== null && entry.usage.modelCalls > ceilings.maxModelCalls
        ? `the agent allows ${String(ceilings.maxModelCalls)} model call(s) and this run made ${String(entry.usage.modelCalls)}`
        : ceilings.maxToolCalls !== null && entry.usage.toolCalls > ceilings.maxToolCalls
          ? `the agent allows ${String(ceilings.maxToolCalls)} tool call(s) and this run made ${String(entry.usage.toolCalls)}`
          : ceilings.maxCostMicroUsd !== null && entry.usage.costMicroUsd > ceilings.maxCostMicroUsd
            ? `the agent allows ${String(ceilings.maxCostMicroUsd)} micro-USD and this run has spent ${String(entry.usage.costMicroUsd)}`
            : null;
    if (breach === null || entry.ceilingBreach !== null) {
      return;
    }
    entry.ceilingBreach = breach;
    // Cancellation is the kernel's own stop: asking for it is what makes the attempt rows,
    // the reservation and the record agree with the reason the run ended.
    void this.#kernel
      .cancel(executionId, `an agent ceiling was crossed: ${breach}`)
      .catch(() => undefined);
  }

  /** Brings the instance to the state the record actually describes. */
  #settle(entry: InstanceEntry, record: ExecutionRecord): void {
    const failure = recordFailure(record);
    const target: AgentStateName =
      record.status === "succeeded"
        ? "completed"
        : record.status === "cancelled"
          ? "cancelled"
          : isApprovalRequiredFailure(failure)
            ? "waiting"
            : "failed";
    const reason =
      record.status === "succeeded"
        ? "every step of the plan succeeded"
        : record.status === "cancelled"
          ? (entry.ceilingBreach ?? "the execution was cancelled")
          : isApprovalRequiredFailure(failure)
            ? "policy requires an approval before this agent may continue"
            : (failure?.message ?? `the execution ended as "${record.status}"`);
    this.#move(entry, target, reason, target === "waiting" ? "approval" : null);
  }

  #startSpan(descriptor: AgentDescriptor, request: ExecutionRequest): Span {
    return this.#tracer.startSpan(parseTrimmedString(`agent.run ${descriptor.slug}`), {
      kind: "internal",
      attributes: aiSpanAttributes({
        executionId: String(request.id),
        agentId: String(descriptor.id),
        agentName: descriptor.slug,
        executionMode: request.mode,
        executionPriority: request.priority,
        tenantId: request.tenantId === null ? null : String(request.tenantId),
      }),
    });
  }

  #endSpan(span: Span, entry: InstanceEntry, record: ExecutionRecord | null, error: unknown): void {
    const usage = record === null ? null : totalRecordUsage(record);
    span.setAttributes(
      aiSpanAttributes({
        status: entry.instance.state,
        executionStatus: record?.status ?? null,
        durationMs: Math.max(0, this.#clock() - entry.startedAtMs),
        ...(usage === null
          ? {}
          : {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              costMicroUsd: usage.costMicro,
            }),
      }),
    );
    if (error !== null && error !== undefined) {
      span.recordException(error);
      span.setStatus(
        "error",
        isOmnisError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } else if (record !== null && record.status !== "succeeded") {
      span.setStatus("error", record.status);
    } else {
      span.setStatus("ok");
    }
    span.end();
  }

  #result(entry: InstanceEntry, record: ExecutionRecord): AgentRunResult {
    const result = record.result;
    return Object.freeze({
      instance: entry.instance,
      record,
      status: record.status,
      succeeded: record.status === "succeeded",
      output: result !== null && result.status === "succeeded" ? result.output : null,
      usage: totalRecordUsage(record),
      evaluation: record.evaluation,
      failure: recordFailure(record),
      ceilingBreach: entry.ceilingBreach,
    });
  }
}

/** An instance that has been given an execution to run. */
function withExecution(instance: AgentInstance, executionId: ExecutionId): AgentInstance {
  return Object.freeze({ ...instance, executionId });
}

/** Why a plan could not be built, in one line. */
function planningFailureReason(error: unknown): string {
  return `the plan was rejected: ${isOmnisError(error) || error instanceof Error ? error.message : String(error)}`;
}

/** Why the kernel refused to run, in one line. */
function kernelFailureReason(error: unknown): string {
  return `the execution kernel refused the run: ${isOmnisError(error) || error instanceof Error ? error.message : String(error)}`;
}

/** Creates an agent runtime. */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new InMemoryAgentRuntime(options);
}

/** A readable rendering of a run result, for logs and error messages. */
export function describeAgentRun(result: AgentRunResult): string {
  const failure = result.failure === null ? "" : `: ${describeFailure(result.failure)}`;
  const breach =
    result.ceilingBreach === null ? "" : ` (an agent ceiling was crossed: ${result.ceilingBreach})`;
  return `agent run ${String(result.record.request.id)} ended ${result.status}${failure}${breach}`;
}
