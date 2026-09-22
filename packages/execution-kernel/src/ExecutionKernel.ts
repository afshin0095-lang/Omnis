/**
 * The execution kernel: the lifecycle every unit of AI work passes through.
 *
 * Order of operations, and why it is that order:
 *
 * 1. **Validate** the request against its contract. Nothing downstream may reason about a shape
 *    the platform has not agreed to.
 * 2. **Authorize** through the policy engine. Policy runs before reservation and before planning,
 *    because a denied execution must not consume budget, must not appear in a plan, and must not
 *    open a span that implies work happened.
 * 3. **Reserve** against a budget, when one applies. Reservation precedes execution so expensive
 *    work is bounded before it starts rather than billed after it finishes.
 * 4. **Plan**, then validate the plan structurally.
 * 5. **Run** the plan's steps in topological order, sequentially.
 * 6. **Settle** the reservation against what was actually consumed, evaluate, record.
 *
 * Sequential, deterministic execution is a deliberate limit. A kernel that ran independent steps
 * concurrently would produce attempt orders that depend on scheduler timing, which would make an
 * execution record impossible to reproduce and a retry policy impossible to reason about. Where
 * concurrency is wanted it belongs one level up, in a planner that expresses it as separate
 * executions with their own identities.
 *
 * The kernel never calls a model, a tool or an evaluator. Those arrive as a {@link StepExecutor}
 * per step kind and as an injected evaluation function, which is what keeps this file free of
 * vendor imports and testable without a network.
 */

import { parseTrimmedString } from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import {
  addUsage,
  approvalRequiredError,
  budgetHold,
  createExecutionFailure,
  deadlineExceededError,
  describeFailure,
  describeModelReference,
  duplicateRegistrationError,
  EMPTY_USAGE,
  executionCancelledError,
  failureFromError,
  initialExecutionMetadata,
  isTerminalExecutionStatus,
  MAX_RETRY_ATTEMPTS,
  numericConstraint,
  policyDeniedError,
  stepTimeoutError,
  topologicalStepOrder,
  withExecutionTiming,
  withGovernanceOutcome,
} from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  AttemptStatus,
  BudgetHold,
  BudgetId,
  BudgetReservation,
  EvaluationInput,
  EvaluationResult,
  ExecutionAttempt,
  ExecutionFailure,
  ExecutionId,
  ExecutionKind,
  ExecutionMetadata,
  ExecutionPlan,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStep,
  PolicyId,
  PolicyOutcome,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { BudgetEngine } from "@omnis/budget-engine";
import { isOmnisError, ValidationError } from "@omnis/errors";
import {
  contextTelemetryAttributes,
  createExecutionContext,
  deadlineIso,
  sanitizeMetadata,
  systemClock,
  toIso,
  ExecutionScope,
  spanParentOf,
} from "@omnis/execution-context";
import type { Clock, ExecutionContext } from "@omnis/execution-context";
import type { PolicyEngine } from "@omnis/policy-engine";
import { aiSpanAttributes, NOOP_TRACER } from "@omnis/telemetry";
import type { Span, Tracer } from "@omnis/telemetry";
import { validate } from "@omnis/validation";
import {
  duplicateExecution,
  executionAlreadyTerminal,
  executionNotFound,
  invalidExecutor,
  kernelCapacityExceeded,
  noStepExecutor,
  planRejected,
} from "./errors.js";
import { assertExecutionStatusTransition } from "./ExecutionStateMachine.js";
import { compositeHooks, NOOP_HOOKS } from "./ExecutionHooks.js";
import type { ExecutionHooks, HookPoint, RetryDecision, StatusChange } from "./ExecutionHooks.js";
import { assertValidPlan, singleStepPlan } from "./plans.js";
import { retryDelayMs, shouldRetry, stepEnvironment, stepOutcome } from "./StepExecutor.js";
import type { StepEnvironment, StepExecutor, StepOutcome } from "./StepExecutor.js";
import { executionAttemptSchema, executionRequestSchema } from "./kernelValidation.js";

/** How many execution records a kernel keeps by default. */
export const DEFAULT_MAX_EXECUTIONS = 1_024;

/** The default fixed delay before a retry, in milliseconds. */
export const DEFAULT_RETRY_DELAY_MS = 0;

/** The longest delay a failure's `retryAfterMs` may ask for. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * An approval recorded for an execution a policy said needs one.
 *
 * Re-exported from `@omnis/ai-core-types`, where the shape lives so the orchestrator and the
 * tool runtime can accept the same approval the kernel was given.
 */
export type { ExecutionApproval } from "@omnis/ai-core-types";
import type { ExecutionApproval } from "@omnis/ai-core-types";

/** Options for one run. */
export interface ExecutionRunOptions {
  /** A caller-owned scope. Its execution identifier must match the request's. */
  readonly scope?: ExecutionScope | null;
  /** The plan to run. Defaults to the kernel's planner, then to the one-step plan a request implies. */
  readonly plan?: ExecutionPlan | null;
  /** Executors for this run, consulted before the registered ones. */
  readonly executors?: readonly StepExecutor[] | null;
  /** Policy sets to evaluate, in addition to the request's own and the kernel defaults. */
  readonly policyIds?: readonly PolicyId[] | null;
  /** Budget to charge, overriding the request's. */
  readonly budgetId?: BudgetId | null;
  /** Amounts to hold, overriding the kernel's estimator. */
  readonly holds?: readonly BudgetHold[] | null;
  /** Approval, when policy requires one. */
  readonly approval?: ExecutionApproval | null;
  /** Extra JSON-safe tags for the scope's metadata. Redacted before storage. */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  /** Hooks for this run only, composed after the kernel's. */
  readonly hooks?: ExecutionHooks | null;
}

/** Kernel configuration. */
export interface ExecutionKernelOptions {
  readonly clock?: Clock;
  readonly policyEngine?: PolicyEngine | null;
  readonly budgetEngine?: BudgetEngine | null;
  readonly tracer?: Tracer;
  readonly hooks?: ExecutionHooks;
  readonly executors?: readonly StepExecutor[];
  readonly maxExecutions?: number;
  /** Allowance for executions that do not ask for one. `null` means unbounded. */
  readonly defaultDeadlineMs?: number | null;
  readonly defaultPolicyIds?: readonly PolicyId[];
  readonly defaultBudgetId?: BudgetId | null;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** How much to hold before the work runs. Defaults to one request. */
  readonly estimateHolds?: (request: ExecutionRequest) => readonly BudgetHold[];
  /** Produces a plan for a request, or `null` to fall back to the one-step plan. */
  readonly planFor?: (request: ExecutionRequest) => ExecutionPlan | null;
  /** Grades the execution. Injected, because evaluation is another package's job. */
  readonly evaluate?: (input: EvaluationInput) => EvaluationResult | null;
}

/** The kernel's public surface. */
export interface ExecutionKernel {
  /** Number of stored execution records. */
  readonly size: number;

  registerExecutor(executor: StepExecutor): void;
  executorFor(kind: ExecutionKind): StepExecutor | null;
  unregisterExecutor(kind: ExecutionKind): boolean;

  /** Stores a `created` record without running it. */
  create(request: ExecutionRequest): ExecutionRecord;
  getExecution(executionId: ExecutionId): ExecutionRecord | null;
  requireExecution(executionId: ExecutionId): ExecutionRecord;
  listExecutions(): readonly ExecutionRecord[];

  /** Runs the full lifecycle and returns the terminal record. */
  execute(request: ExecutionRequest, options?: ExecutionRunOptions): Promise<ExecutionRecord>;

  /** Asks a live execution to stop, or records a stored one as cancelled. */
  cancel(executionId: ExecutionId, reason: string): Promise<ExecutionRecord>;

  /** Moves a stored execution to another legal state. */
  transition(
    executionId: ExecutionId,
    to: ExecutionStatus,
    note?: string | null,
  ): Promise<ExecutionRecord>;

  /** Cancels every live execution and drops every record. */
  dispose(): void;
}

/** Fields of a record the kernel replaces as it advances. */
interface RecordPatch {
  readonly plan?: ExecutionPlan | null;
  readonly governance?: ExecutionMetadata;
  readonly attempts?: readonly ExecutionAttempt[];
  readonly result?: ExecutionResult | null;
  readonly evaluation?: EvaluationResult | null;
}

/** Everything one run remembers between gates. Never shared across runs. */
interface RunState {
  record: ExecutionRecord;
  scope: ExecutionScope;
  /** True when the kernel created the scope and may therefore dispose it. */
  ownsScope: boolean;
  hooks: ExecutionHooks;
  span: Span | null;
  usage: UsageSummary;
  stepStatuses: Map<string, AttemptStatus>;
  stepOutputs: Map<string, JsonValue | null>;
  reservation: BudgetReservation | null;
  plan: ExecutionPlan | null;
  policyMaxDurationMs: number | null;
  policyMaxRetries: number | null;
  policyMaxSteps: number | null;
  approval: ExecutionApproval | null;
  startedAtMs: number;
}

/** The in-memory kernel. */
export class InMemoryExecutionKernel implements ExecutionKernel {
  readonly #records = new Map<ExecutionId, ExecutionRecord>();
  readonly #executors = new Map<ExecutionKind, StepExecutor>();
  readonly #live = new Map<ExecutionId, RunState>();
  readonly #clock: Clock;
  readonly #policyEngine: PolicyEngine | null;
  readonly #budgetEngine: BudgetEngine | null;
  readonly #tracer: Tracer;
  readonly #hooks: ExecutionHooks;
  readonly #maxExecutions: number;
  readonly #defaultDeadlineMs: number | null;
  readonly #defaultPolicyIds: readonly PolicyId[];
  readonly #defaultBudgetId: BudgetId | null;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #estimateHolds: ((request: ExecutionRequest) => readonly BudgetHold[]) | null;
  readonly #planFor: ((request: ExecutionRequest) => ExecutionPlan | null) | null;
  readonly #evaluate: ((input: EvaluationInput) => EvaluationResult | null) | null;

  constructor(options: ExecutionKernelOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#policyEngine = options.policyEngine ?? null;
    this.#budgetEngine = options.budgetEngine ?? null;
    this.#tracer = options.tracer ?? NOOP_TRACER;
    this.#hooks = options.hooks ?? NOOP_HOOKS;
    const maxExecutions = options.maxExecutions ?? DEFAULT_MAX_EXECUTIONS;
    if (!Number.isInteger(maxExecutions) || maxExecutions < 1) {
      throw new RangeError(
        `maxExecutions must be a positive integer, received ${String(maxExecutions)}`,
      );
    }
    this.#maxExecutions = maxExecutions;
    this.#defaultDeadlineMs = options.defaultDeadlineMs ?? null;
    this.#defaultPolicyIds = Object.freeze([...(options.defaultPolicyIds ?? [])]);
    this.#defaultBudgetId = options.defaultBudgetId ?? null;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    this.#estimateHolds = options.estimateHolds ?? null;
    this.#planFor = options.planFor ?? null;
    this.#evaluate = options.evaluate ?? null;
    for (const executor of options.executors ?? []) {
      this.registerExecutor(executor);
    }
  }

  get size(): number {
    return this.#records.size;
  }

  registerExecutor(executor: StepExecutor): void {
    if (typeof executor.execute !== "function") {
      throw invalidExecutor(String(executor.kind), "execute must be a function");
    }
    const existing = this.#executors.get(executor.kind);
    if (existing !== undefined && existing !== executor) {
      // Silently replacing an executor is how a routing change goes unnoticed: every execution
      // would keep succeeding while doing something else entirely.
      throw duplicateRegistrationError("step-executor", executor.kind);
    }
    this.#executors.set(executor.kind, executor);
  }

  executorFor(kind: ExecutionKind): StepExecutor | null {
    return this.#executors.get(kind) ?? null;
  }

  unregisterExecutor(kind: ExecutionKind): boolean {
    return this.#executors.delete(kind);
  }

  create(request: ExecutionRequest): ExecutionRecord {
    const validated = validateRequest(request);
    if (this.#records.has(validated.id)) {
      throw duplicateExecution(validated.id);
    }
    const context = this.#bareContext(validated);
    const record = createRecord(validated, context);
    this.#store(record);
    return record;
  }

  getExecution(executionId: ExecutionId): ExecutionRecord | null {
    return this.#records.get(executionId) ?? null;
  }

  requireExecution(executionId: ExecutionId): ExecutionRecord {
    const record = this.#records.get(executionId);
    if (record === undefined) {
      throw executionNotFound(executionId);
    }
    return record;
  }

  listExecutions(): readonly ExecutionRecord[] {
    return Object.freeze(
      [...this.#records.values()].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.request.id.localeCompare(right.request.id),
      ),
    );
  }

  async execute(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<ExecutionRecord> {
    const validated = validateRequest(request);
    const existing = this.#records.get(validated.id);
    if (
      this.#live.has(validated.id) ||
      (existing !== undefined && isTerminalExecutionStatus(existing.status))
    ) {
      throw duplicateExecution(validated.id);
    }

    const callerScope = options.scope ?? null;
    if (callerScope !== null && callerScope.context.executionId !== validated.id) {
      throw new ValidationError(
        `execution scope is for ${callerScope.context.executionId} but the request is for ${validated.id}`,
        { retryable: false, metadata: { registry: "kernel", executionId: validated.id } },
      );
    }

    const scope = callerScope ?? this.#rootScope(validated, options);
    const state: RunState = {
      record: existing ?? createRecord(validated, scope.context),
      scope,
      ownsScope: callerScope === null,
      hooks: compositeHooks(this.#hooks, options.hooks ?? NOOP_HOOKS),
      span: null,
      usage: EMPTY_USAGE,
      stepStatuses: new Map(),
      stepOutputs: new Map(),
      reservation: null,
      plan: null,
      policyMaxDurationMs: null,
      policyMaxRetries: null,
      policyMaxSteps: null,
      approval: options.approval ?? null,
      startedAtMs: scope.now(),
    };
    this.#store(state.record);
    this.#live.set(validated.id, state);
    state.span = this.#startExecutionSpan(state);

    try {
      await this.#runHook(state, "beforeExecution", (hooks) =>
        hooks.beforeExecution?.(state.record),
      );

      if (scope.cancelled) {
        return await this.#finishEarly(
          state,
          "cancelled",
          cancellationFailure(scope, validated.id),
          "cancelled before the first gate",
        );
      }
      if (scope.isExpired()) {
        return await this.#finishEarly(
          state,
          "timed_out",
          deadlineFailure(scope, validated.id),
          "deadline passed before the first gate",
        );
      }

      state.record = await this.#advance(
        state,
        "validated",
        "request satisfied the ExecutionRequest contract",
      );

      state.record = await this.#authorize(state, validated, options);
      if (isTerminalExecutionStatus(state.record.status)) {
        return await this.#wrapUp(state);
      }

      state.record = await this.#reserve(state, validated, options);
      if (isTerminalExecutionStatus(state.record.status)) {
        return await this.#wrapUp(state);
      }

      state.record = await this.#planExecution(state, validated, options);
      if (isTerminalExecutionStatus(state.record.status)) {
        return await this.#wrapUp(state);
      }

      state.record = await this.#advance(
        state,
        "running",
        `running ${String(state.plan?.steps.length ?? 0)} step(s)`,
      );
      state.record = await this.#runSteps(state, options);
      return await this.#wrapUp(state);
    } catch (error) {
      // A throw here is a kernel or configuration fault — an illegal transition, a full record
      // store, an executor that is not a function. It is still recorded, because an execution that
      // leaves no record cannot be audited, and then rethrown so the caller sees the fault.
      const failure = failureFromError(error, { executionId: validated.id, attempt: 1 });
      if (!isTerminalExecutionStatus(state.record.status)) {
        state.record = await this.#failWith(
          state,
          failure,
          state.record.governance,
          `kernel fault: ${describeFailure(failure)}`,
        );
      }
      await this.#wrapUp(state);
      throw error;
    } finally {
      this.#endSpan(state);
      this.#live.delete(validated.id);
      if (state.ownsScope) {
        scope.dispose();
      }
    }
  }

  async cancel(executionId: ExecutionId, reason: string): Promise<ExecutionRecord> {
    const record = this.requireExecution(executionId);
    if (isTerminalExecutionStatus(record.status)) {
      throw executionAlreadyTerminal(record.request.id, record.status);
    }
    const state = this.#live.get(executionId);
    if (state !== undefined) {
      // The run observes cancellation cooperatively: cancelling the scope is the whole action, and
      // the run loop records the terminal state so the record and the result agree.
      state.scope.cancel(reason);
      return state.record;
    }
    const failure = createExecutionFailure({
      class: "cancelled",
      code: "execution_failed",
      message: reason,
      retryable: false,
      attempt: 1,
      executionId: record.request.id,
      occurredAt: toIso(this.#clock()),
      details: { cancelledBy: "kernel" },
    });
    return this.#cancelStored(record, failure);
  }

  async transition(
    executionId: ExecutionId,
    to: ExecutionStatus,
    note: string | null = null,
  ): Promise<ExecutionRecord> {
    const record = this.requireExecution(executionId);
    const state = this.#live.get(executionId);
    if (state !== undefined) {
      return this.#advance(state, to, note);
    }
    assertExecutionStatusTransition(record.status, to, record.request.id);
    const at = toIso(this.#clock());
    const next = freezeRecord({
      ...record,
      status: to,
      updatedAt: at,
      timeline: [...record.timeline, timelineEntry(at, to, note, null)],
    });
    this.#store(next);
    return next;
  }

  dispose(): void {
    for (const state of this.#live.values()) {
      state.scope.cancel("kernel disposed");
      if (state.ownsScope) {
        state.scope.dispose();
      }
    }
    this.#live.clear();
    this.#records.clear();
    this.#executors.clear();
  }

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  async #authorize(
    state: RunState,
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<ExecutionRecord> {
    const policyIds = this.#resolvePolicyIds(request, options);
    if (this.#policyEngine === null) {
      return this.#advance(state, "authorized", "no policy engine configured");
    }
    if (policyIds.length === 0) {
      return this.#advance(state, "authorized", "no policy set applies");
    }

    try {
      const gate = this.#policyEngine.gateWithContext(
        state.scope.context,
        {
          action: "execution.run",
          subject: request.kind,
          resource: describeExecution(request),
          toolId: request.tool !== null && request.tool.kind === "id" ? request.tool.toolId : null,
          modelId:
            request.model !== null && request.model.kind === "id" ? request.model.modelId : null,
          providerId:
            request.model !== null && request.model.kind !== "id" ? request.model.providerId : null,
          budgetId: options.budgetId ?? request.budgetId,
          attributes: {
            executionMode: request.mode,
            executionPriority: request.priority,
            agentId: request.agentId,
            parentExecutionId: request.parentExecutionId,
            approved: state.approval === null ? null : state.approval.approved,
            approvalGranted: state.approval?.approved === true,
            // Input keys are facts a policy may use; input values are user content and are not
            // telemetry, not policy input and not audit material.
            inputKeys: Object.keys(request.input).sort(),
          },
        },
        policyIds,
      );

      state.policyMaxDurationMs = numericConstraint(gate.constraints, "max_duration_ms");
      const maxRetries = numericConstraint(gate.constraints, "max_retries");
      state.policyMaxRetries = maxRetries === null ? null : Math.max(0, Math.trunc(maxRetries));
      const maxSteps = numericConstraint(gate.constraints, "max_steps");
      state.policyMaxSteps = maxSteps === null ? null : Math.max(0, Math.trunc(maxSteps));

      const governance = withGovernanceOutcome(state.record.governance, {
        policyId: gate.decidedByPolicyId,
        policyOutcome: gate.outcome,
        budgetId: options.budgetId ?? request.budgetId,
        reservationState: null,
      });

      if (gate.outcome === "deny") {
        const refusal = policyDeniedError(
          gate.decidedByPolicyId ?? "kernel",
          gate.decidedByRuleId ?? "default",
          gate.reason ?? "policy denied the execution",
        );
        return this.#failWith(
          state,
          failureFromError(refusal, { executionId: request.id }),
          governance,
          `policy denied: ${gate.reason ?? "no reason recorded"}`,
        );
      }
      if (gate.outcome === "require_approval" && state.approval?.approved !== true) {
        const refusal = approvalRequiredError(
          gate.decidedByPolicyId ?? "kernel",
          gate.decidedByRuleId ?? "default",
          gate.reason ?? "policy requires an approval",
        );
        return this.#failWith(
          state,
          failureFromError(refusal, { executionId: request.id }),
          governance,
          `approval required: ${gate.reason ?? "no reason recorded"}`,
        );
      }

      const note =
        gate.outcome === "allow"
          ? `policy allowed (${String(policyIds.length)} set(s))`
          : `${gate.outcome} by ${gate.decidedByPolicyId ?? "policy"}${gate.decidedByRuleId === null ? "" : ` rule ${gate.decidedByRuleId}`}`;
      return this.#advance(state, "authorized", note, { governance });
    } catch (error) {
      // A policy engine that throws is a configuration fault, and it must not become an authorized
      // execution: failing closed is the only safe reading of "we could not ask".
      const failure = failureFromError(error, { executionId: request.id });
      return this.#failWith(
        state,
        failure,
        state.record.governance,
        `policy evaluation failed: ${describeFailure(failure)}`,
      );
    }
  }

  async #reserve(
    state: RunState,
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<ExecutionRecord> {
    const budgetId = options.budgetId ?? request.budgetId ?? this.#defaultBudgetId;
    if (this.#budgetEngine === null || budgetId === null) {
      // Nothing to reserve, so the record stays `authorized` and the plan moves it to `planned`.
      // Claiming `reserved` without a reservation would be a lie an auditor cannot check.
      return state.record;
    }

    const holds = options.holds ?? this.#estimateHolds?.(request) ?? [budgetHold("requests", 1)];
    try {
      const reservation = this.#budgetEngine.reserveFromContext(state.scope.context, {
        budgetId,
        key: request.id,
        holds,
        sessionId: null,
      });
      state.reservation = reservation;
      const governance = withGovernanceOutcome(state.record.governance, {
        policyId: state.record.governance.policyId,
        policyOutcome: policyOutcomeOf(state.record.governance),
        budgetId,
        reservationState: reservation.state,
      });
      return this.#advance(
        state,
        "reserved",
        `reserved ${describeHolds(holds)} against ${budgetId}`,
        { governance },
      );
    } catch (error) {
      const failure = failureFromError(error, { executionId: request.id });
      const governance = withGovernanceOutcome(state.record.governance, {
        policyId: state.record.governance.policyId,
        policyOutcome: policyOutcomeOf(state.record.governance),
        budgetId,
        reservationState: null,
      });
      return this.#failWith(
        state,
        failure,
        governance,
        `budget refused the reservation: ${describeFailure(failure)}`,
      );
    }
  }

  async #planExecution(
    state: RunState,
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<ExecutionRecord> {
    let plan: ExecutionPlan;
    try {
      plan = options.plan ?? this.#planFor?.(request) ?? singleStepPlan(request, this.#clock);
      assertValidPlan(plan);
      if (state.policyMaxSteps !== null && plan.steps.length > state.policyMaxSteps) {
        throw planRejected(
          [
            {
              code: "too_many_steps",
              message: `policy allows at most ${String(state.policyMaxSteps)} step(s), the plan declares ${String(plan.steps.length)}`,
              stepId: null,
            },
          ],
          request.id,
        );
      }
    } catch (error) {
      const failure = failureFromError(error, { executionId: request.id });
      return this.#failWith(
        state,
        failure,
        state.record.governance,
        `plan rejected: ${describeFailure(failure)}`,
      );
    }

    state.plan = plan;
    return this.#advance(
      state,
      "planned",
      `plan ${plan.id} with ${String(plan.steps.length)} step(s)`,
      { plan },
    );
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  async #runSteps(state: RunState, options: ExecutionRunOptions): Promise<ExecutionRecord> {
    const plan = state.plan;
    if (plan === null) {
      const failure = failureFromError(
        new Error("the kernel reached the run phase without a plan"),
        {
          executionId: state.record.request.id,
        },
      );
      return this.#failWith(state, failure, state.record.governance, "no plan was produced");
    }

    const ordered = topologicalStepOrder(plan);
    for (const step of ordered) {
      const interrupted = await this.#interruptedBefore(state, step);
      if (interrupted !== null) {
        return interrupted;
      }

      const blockedBy = unmetDependency(step, state.stepStatuses);
      if (blockedBy !== null) {
        const reason = `dependency "${blockedBy.stepId}" ${blockedBy.status}`;
        if (step.optional) {
          state.stepStatuses.set(step.id, "skipped");
          this.#appendAttempt(
            state,
            step,
            1,
            stepOutcome({ status: "skipped" }),
            `optional step skipped: ${reason}`,
          );
          continue;
        }
        const failure = createExecutionFailure({
          class: "non_retryable",
          code: "execution_failed",
          message: `step "${step.id}" cannot run because ${reason}`,
          retryable: false,
          attempt: 1,
          stepId: step.id,
          executionId: state.record.request.id,
          details: { dependency: blockedBy.stepId, dependencyStatus: blockedBy.status },
        });
        state.stepStatuses.set(step.id, "skipped");
        this.#appendAttempt(state, step, 1, stepOutcome({ status: "skipped", failure }), reason);
        return await this.#terminate(state, "failed", failure, reason);
      }

      state.record = await this.#runStep(state, step, options);
      if (isTerminalExecutionStatus(state.record.status)) {
        return state.record;
      }
    }

    return await this.#terminate(
      state,
      "succeeded",
      null,
      `all ${String(ordered.length)} step(s) succeeded`,
    );
  }

  /** A record ending the run because the scope was cancelled or expired before a step. */
  async #interruptedBefore(state: RunState, step: ExecutionStep): Promise<ExecutionRecord | null> {
    if (state.scope.cancelled) {
      const failure = cancellationFailure(state.scope, state.record.request.id);
      state.stepStatuses.set(step.id, "cancelled");
      this.#appendAttempt(
        state,
        step,
        1,
        stepOutcome({ status: "cancelled", failure }),
        "cancelled before the step ran",
      );
      return await this.#terminate(
        state,
        "cancelled",
        failure,
        `cancelled: ${state.scope.cancellationReason ?? "no reason recorded"}`,
      );
    }
    if (state.scope.isExpired()) {
      const failure = deadlineFailure(state.scope, state.record.request.id);
      state.stepStatuses.set(step.id, "timed_out");
      this.#appendAttempt(
        state,
        step,
        1,
        stepOutcome({ status: "timed_out", failure }),
        "deadline passed before the step ran",
      );
      return await this.#terminate(
        state,
        "timed_out",
        failure,
        "deadline passed before the step ran",
      );
    }
    return null;
  }

  async #runStep(
    state: RunState,
    step: ExecutionStep,
    options: ExecutionRunOptions,
  ): Promise<ExecutionRecord> {
    const executor = this.#executorFor(step, options);
    if (executor === null) {
      const failure = failureFromError(
        noStepExecutor(step.kind, step.id, state.record.request.id),
        {
          executionId: state.record.request.id,
          stepId: step.id,
        },
      );
      state.stepStatuses.set(step.id, "failed");
      this.#appendAttempt(
        state,
        step,
        1,
        stepOutcome({ status: "failed", failure }),
        `no executor for kind "${step.kind}"`,
      );
      return step.optional
        ? this.#note(
            state,
            `optional step "${step.id}" failed: no executor for kind "${step.kind}"`,
            step.id,
          )
        : await this.#terminate(state, "failed", failure, `no executor for kind "${step.kind}"`);
    }

    const maxAttempts = attemptLimit(step, state);
    let outcome: StepOutcome = stepOutcome({ status: "failed" });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const interrupted = await this.#interruptedBefore(state, step);
      if (interrupted !== null) {
        return interrupted;
      }

      const boundMs = stepDeadlineMs(state, step);
      const stepScope = state.scope.child(
        {
          deadlineMs: boundMs,
          // A step reports under the run's own span rather than under whatever span the run
          // was started from. Without this the model call and the tool invocation become
          // siblings of the execution they belong to, and a trace of one agent run with two
          // executions would not show which call belonged to which run.
          ...(state.span === null ? {} : { parentSpanId: state.span.context.spanId }),
          metadata: { stepId: step.id, attempt },
        },
        { clock: this.#clock },
      );
      const environment = stepEnvironment(stepScope, step, attempt, maxAttempts, {
        executionId: state.record.request.id,
        approval: state.approval,
      });
      const startedMs = this.#clock();
      await this.#runHook(state, "beforeStep", (hooks) => hooks.beforeStep?.(step, environment));

      try {
        outcome = await this.#raceAttempt(executor, step, environment, stepScope, boundMs, attempt);
      } finally {
        // Disposing the child scope cancels whatever the executor left running, which is what makes
        // a step timeout a bound rather than an opinion.
        stepScope.dispose();
      }

      state.usage = accumulateUsage(state.usage, outcome.usage, state.record.attempts.length > 0);
      const row = this.#appendAttempt(
        state,
        step,
        attempt,
        outcome,
        attemptNote(step, attempt, outcome, this.#clock() - startedMs),
      );
      await this.#runHook(state, "afterStep", (hooks) => hooks.afterStep?.(step, row));

      if (outcome.status === "succeeded") {
        state.stepStatuses.set(step.id, "succeeded");
        state.stepOutputs.set(step.id, outcome.output);
        return this.#note(
          state,
          `step "${step.id}" succeeded on attempt ${String(attempt)}`,
          step.id,
        );
      }
      state.stepStatuses.set(step.id, outcome.status);

      if (!shouldRetry(outcome, attempt, maxAttempts)) {
        break;
      }

      const delay = retryDelayMs(outcome.failure, this.#retryDelayMs, this.#maxRetryDelayMs);
      const decision: RetryDecision = {
        executionId: state.record.request.id,
        stepId: step.id,
        attempt,
        nextAttempt: attempt + 1,
        delayMs: delay,
        failureCode: outcome.failure?.code ?? "unknown",
        failureClass: outcome.failure?.class ?? "unknown",
      };
      await this.#runHook(state, "onRetry", (hooks) => hooks.onRetry?.(decision));
      const waited = await this.#wait(state, delay);
      if (waited === "cancelled") {
        const failure = cancellationFailure(state.scope, state.record.request.id);
        return await this.#terminate(
          state,
          "cancelled",
          failure,
          `cancelled during the retry wait: ${state.scope.cancellationReason ?? "no reason recorded"}`,
        );
      }
      if (waited === "expired") {
        const failure = deadlineFailure(state.scope, state.record.request.id);
        return await this.#terminate(
          state,
          "timed_out",
          failure,
          "deadline passed during the retry wait",
        );
      }
    }

    if (step.optional) {
      return this.#note(state, `optional step "${step.id}" ${outcome.status}`, step.id);
    }
    // When the scope was cancelled, the scope's reason is the authoritative one: an executor that
    // noticed the cancellation reports what it saw, which is not the same as who stopped the run.
    const failure =
      outcome.status === "cancelled" && state.scope.cancelled
        ? cancellationFailure(state.scope, state.record.request.id)
        : (outcome.failure ??
          createExecutionFailure({
            class: "unknown",
            code: "execution_failed",
            message: `step "${step.id}" ${outcome.status} without a recorded failure`,
            retryable: false,
            attempt: 1,
            stepId: step.id,
            executionId: state.record.request.id,
          }));
    const status: "failed" | "cancelled" | "timed_out" =
      outcome.status === "cancelled"
        ? "cancelled"
        : outcome.status === "timed_out"
          ? "timed_out"
          : "failed";
    return await this.#terminate(state, status, failure, `step "${step.id}" ${outcome.status}`);
  }

  /** Runs one attempt, bounded by a timeout and by cancellation. */
  async #raceAttempt(
    executor: StepExecutor,
    step: ExecutionStep,
    environment: StepEnvironment,
    scope: ExecutionScope,
    boundMs: number | null,
    attempt: number,
  ): Promise<StepOutcome> {
    const executionId = environment.executionId;
    const failureContext = {
      executionId,
      stepId: step.id,
      attempt,
      modelId: step.modelId,
      providerId: step.providerId,
      toolId: step.toolId,
    };

    // Wrapping in `then` turns a synchronous throw inside an executor into a rejection, so one
    // code path handles both.
    const work = Promise.resolve()
      .then(() => executor.execute(step, environment))
      .then(
        (outcome) => outcome,
        (error: unknown) =>
          stepOutcome({ status: "failed", failure: failureFromError(error, failureContext) }),
      );

    if (boundMs === null) {
      return work;
    }

    return new Promise<StepOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(
          stepOutcome({
            status: "timed_out",
            failure: failureFromError(stepTimeoutError(step.id, boundMs), failureContext),
          }),
        );
      }, boundMs);
      const unsubscribe = scope.context.cancellation.onCancelled((reason) => {
        finish(
          stepOutcome({
            status: "cancelled",
            failure: failureFromError(
              executionCancelledError(executionId, reason ?? "cancelled"),
              failureContext,
            ),
          }),
        );
      });

      function finish(outcome: StepOutcome): void {
        if (settled) {
          return;
        }
        settled = true;
        // Both are always released: a pending timer per attempt keeps a process alive long after
        // the execution it belonged to has finished, and a live listener leaks the scope.
        clearTimeout(timer);
        unsubscribe();
        resolve(outcome);
      }

      void work.then(finish);
    });
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  async #advance(
    state: RunState,
    to: ExecutionStatus,
    note: string | null,
    patch: RecordPatch = {},
  ): Promise<ExecutionRecord> {
    const from = state.record.status;
    assertExecutionStatusTransition(from, to, state.record.request.id);
    const at = toIso(this.#clock());
    const next = freezeRecord({
      ...state.record,
      ...patch,
      status: to,
      updatedAt: at,
      timeline: [...state.record.timeline, timelineEntry(at, to, note, null)],
    });
    state.record = next;
    this.#store(next);
    const change: StatusChange = { executionId: next.request.id, from, to, at, note, stepId: null };
    await this.#runHook(state, "onStatusChange", (hooks) => hooks.onStatusChange?.(change));
    return next;
  }

  /** Records a timeline note without changing status. */
  #note(state: RunState, note: string, stepId: string | null = null): ExecutionRecord {
    const at = toIso(this.#clock());
    state.record = freezeRecord({
      ...state.record,
      updatedAt: at,
      timeline: [...state.record.timeline, timelineEntry(at, state.record.status, note, stepId)],
    });
    this.#store(state.record);
    return state.record;
  }

  /** Appends an attempt row, validated against the published contract, and returns it. */
  #appendAttempt(
    state: RunState,
    step: ExecutionStep,
    attempt: number,
    outcome: StepOutcome,
    note: string,
  ): ExecutionAttempt {
    const startedAtMs = state.scope.now();
    const finishedAtMs = this.#clock();
    const row = validate(
      executionAttemptSchema,
      {
        stepId: step.id,
        kind: step.kind,
        attempt,
        status: outcome.status,
        startedAt: toIso(startedAtMs),
        finishedAt: toIso(finishedAtMs),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        failure: outcome.failure,
        usage: outcome.usage,
        modelId: outcome.modelId ?? step.modelId,
        providerId: outcome.providerId ?? step.providerId,
        toolId: outcome.toolId ?? step.toolId,
        metadata: sanitizeMetadata(outcome.metadata, "attempt metadata"),
      },
      "ExecutionAttempt",
    );
    const at = toIso(finishedAtMs);
    state.record = freezeRecord({
      ...state.record,
      attempts: [...state.record.attempts, row],
      updatedAt: at,
      timeline: [...state.record.timeline, timelineEntry(at, state.record.status, note, step.id)],
    });
    this.#store(state.record);
    return row;
  }

  /** Ends a run with a terminal status, a result and a settled reservation. */
  async #terminate(
    state: RunState,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    failure: ExecutionFailure | null,
    note: string,
  ): Promise<ExecutionRecord> {
    const from = state.record.status;
    const request = state.record.request;
    const completedAtMs = this.#clock();
    const durationMs = Math.max(0, completedAtMs - state.startedAtMs);
    const completedAt = toIso(completedAtMs);
    const output = aggregateOutput(state);
    const resultFailure = failure ?? unknownFailure(request.id, note);
    const resultMetadata = sanitizeMetadata(
      {
        steps: state.plan?.steps.length ?? 0,
        attempts: state.record.attempts.length,
        stepStatuses: Object.fromEntries(
          [...state.stepStatuses.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
        policyOutcome: state.record.governance.policyOutcome,
        budgetStatus: state.reservation?.state ?? null,
      },
      "execution result metadata",
    );

    this.#settleBudget(state);
    const evaluation = this.#evaluateResult(
      state,
      request,
      status,
      output,
      status === "succeeded" ? null : resultFailure,
      durationMs,
    );
    const governance = withExecutionTiming(
      withGovernanceOutcome(state.record.governance, {
        policyId: state.record.governance.policyId,
        policyOutcome: policyOutcomeOf(state.record.governance),
        budgetId: state.record.governance.budgetId,
        reservationState: state.reservation?.state ?? null,
      }),
      {
        startedAt: state.record.governance.startedAt ?? toIso(state.startedAtMs),
        finishedAt: completedAt,
        durationMs,
        attemptCount: state.record.attempts.length,
      },
    );

    const result = buildResult({
      status,
      executionId: request.id,
      output,
      failure: resultFailure,
      usage: state.usage,
      evaluation,
      completedAt,
      durationMs,
      metadata: resultMetadata,
    });

    const at = toIso(this.#clock());
    state.record = freezeRecord({
      ...state.record,
      status,
      result,
      evaluation,
      governance,
      updatedAt: at,
      timeline: [...state.record.timeline, timelineEntry(at, status, note, null)],
    });
    this.#store(state.record);
    // The terminal move is a status move like any other: a hook that only learns about the run when
    // it is still `running` would publish a start it can never finish.
    const change: StatusChange = {
      executionId: request.id,
      from,
      to: status,
      at,
      note,
      stepId: null,
    };
    await this.#runHook(state, "onStatusChange", (hooks) => hooks.onStatusChange?.(change));
    return state.record;
  }

  /** Ends a run that stopped before it ever ran a step. */
  async #finishEarly(
    state: RunState,
    status: "cancelled" | "timed_out",
    failure: ExecutionFailure,
    note: string,
  ): Promise<ExecutionRecord> {
    if (state.record.status === "created") {
      state.record = await this.#advance(
        state,
        "validated",
        "request satisfied the ExecutionRequest contract",
      );
    }
    state.record = await this.#terminate(state, status, failure, note);
    return this.#wrapUp(state);
  }

  /** Settles the budget, runs the terminal hooks and decorates the span. */
  async #wrapUp(state: RunState): Promise<ExecutionRecord> {
    this.#settleBudget(state);
    const record = state.record;
    await this.#runHook(state, "afterExecution", (hooks) => hooks.afterExecution?.(record));
    this.#decorateSpan(state, record);
    return record;
  }

  /** Records a governance refusal as a terminal failure. */
  async #failWith(
    state: RunState,
    failure: ExecutionFailure,
    governance: ExecutionMetadata,
    note: string,
  ): Promise<ExecutionRecord> {
    const status: "failed" | "cancelled" | "timed_out" =
      failure.class === "cancelled"
        ? "cancelled"
        : failure.class === "deadline_exceeded"
          ? "timed_out"
          : "failed";
    const completedAtMs = this.#clock();
    const durationMs = Math.max(0, completedAtMs - state.startedAtMs);
    const result = buildResult({
      status,
      executionId: state.record.request.id,
      output: null,
      failure,
      usage: state.usage,
      evaluation: null,
      completedAt: toIso(completedAtMs),
      durationMs,
      metadata: Object.freeze({ stoppedAt: state.record.status }),
    });
    return this.#advance(state, status, note, { result, governance });
  }

  /** Cancels a stored record that is not being run. */
  #cancelStored(record: ExecutionRecord, failure: ExecutionFailure): ExecutionRecord {
    const at = toIso(this.#clock());
    const startedAtMs = Date.parse(record.governance.startedAt ?? record.createdAt);
    const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, this.#clock() - startedAtMs) : 0;
    const result = buildResult({
      status: "cancelled",
      executionId: record.request.id,
      output: null,
      failure,
      usage: EMPTY_USAGE,
      evaluation: null,
      completedAt: at,
      durationMs,
      metadata: Object.freeze({ cancelledWithoutRun: true }),
    });
    const next = freezeRecord({
      ...record,
      status: "cancelled",
      result,
      updatedAt: at,
      governance: withExecutionTiming(record.governance, {
        startedAt: record.governance.startedAt ?? record.createdAt,
        finishedAt: at,
        durationMs,
        attemptCount: record.attempts.length,
      }),
      timeline: [...record.timeline, timelineEntry(at, "cancelled", failure.message, null)],
    });
    this.#store(next);
    return next;
  }

  #settleBudget(state: RunState): void {
    const reservation = state.reservation;
    if (reservation === null || this.#budgetEngine === null || reservation.state !== "held") {
      return;
    }
    try {
      // Charge what was consumed, not what was guessed. An estimate is a hold, and keeping it after
      // the work finished would either overcharge the budget or hide an overspend.
      const actual = actualHolds(state.usage);
      const settled =
        actual.length === 0
          ? this.#budgetEngine.release(reservation.id)
          : this.#budgetEngine.commit(reservation.id, actual);
      state.reservation = settled;
      state.record = freezeRecord({
        ...state.record,
        governance: withGovernanceOutcome(state.record.governance, {
          policyId: state.record.governance.policyId,
          policyOutcome: policyOutcomeOf(state.record.governance),
          budgetId: state.record.governance.budgetId,
          reservationState: settled.state,
        }),
      });
      this.#store(state.record);
    } catch (error) {
      // Settling is bookkeeping. A budget engine that refuses to settle must not erase the result of
      // work that already happened, but the refusal is recorded rather than swallowed.
      const at = toIso(this.#clock());
      state.record = freezeRecord({
        ...state.record,
        updatedAt: at,
        timeline: [
          ...state.record.timeline,
          timelineEntry(
            at,
            state.record.status,
            `budget settlement failed: ${isOmnisError(error) ? error.message : String(error)}`,
            null,
          ),
        ],
      });
      this.#store(state.record);
    }
  }

  #evaluateResult(
    state: RunState,
    request: ExecutionRequest,
    status: ExecutionStatus,
    output: JsonValue | null,
    failure: ExecutionFailure | null,
    durationMs: number,
  ): EvaluationResult | null {
    if (this.#evaluate === null) {
      return null;
    }
    const input: EvaluationInput = Object.freeze({
      executionId: request.id,
      output: status === "succeeded" ? output : null,
      expected: jsonOrNull(request.input["expected"]),
      requestedResponseFormat: stringOrNull(request.input["responseFormat"]),
      schemaName: stringOrNull(request.input["schemaName"]),
      outputMatchesRequestedFormat: request.input["outputMatchesRequestedFormat"] === true,
      modelId: request.model !== null && request.model.kind === "id" ? request.model.modelId : null,
      providerId:
        request.model !== null && request.model.kind !== "id" ? request.model.providerId : null,
      usage: state.usage,
      latencyMs: durationMs,
      policyOutcome: policyOutcomeOf(state.record.governance),
      toolResults: Object.freeze(
        state.record.attempts
          .filter((attempt) => attempt.toolId !== null)
          .map((attempt) => ({
            toolId: attempt.toolId as NonNullable<ExecutionAttempt["toolId"]>,
            name: attempt.stepId,
            status:
              attempt.status === "succeeded"
                ? ("succeeded" as const)
                : attempt.status === "skipped"
                  ? ("denied" as const)
                  : ("failed" as const),
            durationMs: attempt.durationMs ?? 0,
            errorCode: attempt.failure?.code ?? null,
          })),
      ),
      failure,
      cancelled: status === "cancelled",
      timedOut: status === "timed_out",
    });
    try {
      return this.#evaluate(input);
    } catch {
      // Evaluation grades the work; it is not the work. An evaluator that throws must not turn a
      // successful execution into a failed one.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Support
  // -------------------------------------------------------------------------

  #bareContext(request: ExecutionRequest): ExecutionContext {
    return createExecutionContext(
      {
        executionId: request.id,
        correlationId: request.correlationId,
        causationId: request.causationId,
        tenantId: request.tenantId,
        agentId: request.agentId,
        traceId: request.traceId,
        mode: request.mode,
        priority: request.priority,
        deadlineMs: request.deadlineMs ?? this.#defaultDeadlineMs,
        metadata: request.metadata,
      },
      { clock: this.#clock },
    );
  }

  #rootScope(request: ExecutionRequest, options: ExecutionRunOptions): ExecutionScope {
    return ExecutionScope.createRoot(
      {
        executionId: request.id,
        correlationId: request.correlationId,
        causationId: request.causationId,
        tenantId: request.tenantId,
        agentId: request.agentId,
        traceId: request.traceId,
        mode: request.mode,
        priority: request.priority,
        deadlineMs: request.deadlineMs ?? this.#defaultDeadlineMs,
        metadata: { ...request.metadata, ...(options.metadata ?? {}) },
      },
      { clock: this.#clock, defaultDeadlineMs: this.#defaultDeadlineMs },
    );
  }

  #executorFor(step: ExecutionStep, options: ExecutionRunOptions): StepExecutor | null {
    for (const executor of options.executors ?? []) {
      if (executor.kind === step.kind) {
        return executor;
      }
    }
    return this.#executors.get(step.kind) ?? null;
  }

  #resolvePolicyIds(request: ExecutionRequest, options: ExecutionRunOptions): readonly PolicyId[] {
    const candidates: string[] = [];
    if (request.policyId !== null) {
      candidates.push(request.policyId);
    }
    for (const policyId of this.#defaultPolicyIds) {
      candidates.push(policyId);
    }
    for (const policyId of options.policyIds ?? []) {
      candidates.push(policyId);
    }

    const resolved: PolicyId[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const policyId = this.#resolvePolicyId(candidate);
      if (policyId === null || seen.has(policyId)) {
        continue;
      }
      seen.add(policyId);
      resolved.push(policyId);
    }
    return Object.freeze(resolved);
  }

  /** Accepts an identifier or a registered name, because a request may carry either. */
  #resolvePolicyId(candidate: string): PolicyId | null {
    if (candidate.startsWith("pol_")) {
      return candidate as PolicyId;
    }
    if (this.#policyEngine === null) {
      return null;
    }
    const byName = this.#policyEngine.list().find((set) => set.name === candidate);
    return byName === undefined ? null : byName.id;
  }

  #store(record: ExecutionRecord): void {
    if (!this.#records.has(record.request.id) && this.#records.size >= this.#maxExecutions) {
      throw kernelCapacityExceeded(this.#maxExecutions);
    }
    this.#records.set(record.request.id, record);
  }

  #startExecutionSpan(state: RunState): Span {
    const context = state.scope.context;
    const request = state.record.request;
    return this.#tracer.startSpan(parseTrimmedString(`execution.run ${request.kind}`), {
      kind: "internal",
      parent: spanParentOf(context),
      attributes: {
        ...contextTelemetryAttributes(context),
        ...aiSpanAttributes({
          executionId: context.executionId,
          executionMode: context.mode,
          executionPriority: context.priority,
          executionDepth: context.depth,
          agentId: context.agentId,
          tenantId: context.tenantId,
          correlationId: context.correlationId,
          causationId: context.causationId,
          modelId:
            request.model !== null && request.model.kind === "id" ? request.model.modelId : null,
          modelSlug:
            request.model !== null && request.model.kind === "slug" ? request.model.slug : null,
          toolId: request.tool !== null && request.tool.kind === "id" ? request.tool.toolId : null,
          budgetId: request.budgetId,
          attempt: 1,
        }),
      },
    });
  }

  #decorateSpan(state: RunState, record: ExecutionRecord): void {
    const span = state.span;
    if (span === null) {
      return;
    }
    const failure =
      record.result !== null && record.result.status !== "succeeded" ? record.result.failure : null;
    span.setAttributes(
      aiSpanAttributes({
        executionStatus: record.status,
        status: record.status,
        policyId: record.governance.policyId,
        policyOutcome: policyOutcomeOf(record.governance),
        reservationId: state.reservation?.id ?? null,
        budgetId: record.governance.budgetId,
        evaluationId: record.evaluation?.id ?? null,
        evaluationScore: record.evaluation?.overallScore ?? null,
        durationMs: record.governance.durationMs,
        totalTokens: state.usage.totalTokens,
        costMicroUsd: state.usage.costMicro,
        cancelled: record.status === "cancelled",
        timedOut: record.status === "timed_out",
        failureClass: failure?.class ?? null,
        failureCode: failure?.code ?? null,
        retryable: failure?.retryable ?? null,
      }),
    );
    if (record.status === "succeeded") {
      span.setStatus("ok");
      return;
    }
    span.setStatus("error", failure === null ? record.status : describeFailure(failure));
  }

  #endSpan(state: RunState): void {
    if (state.span !== null && !state.span.ended) {
      state.span.end();
    }
  }

  async #runHook(
    state: RunState,
    point: HookPoint,
    invoke: (hooks: ExecutionHooks) => void | Promise<void>,
  ): Promise<void> {
    try {
      await invoke(state.hooks);
    } catch (error) {
      // A hook is an observer. Its failure is recorded and reported to whichever hooks can report
      // it, and the execution continues: telemetry must never be able to fail production work.
      const message = isOmnisError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.#note(state, `hook ${point} failed: ${message}`);
      try {
        await state.hooks.onHookError?.(point, error, state.record.request.id);
      } catch {
        // Nothing left to do: the observer of observers failed too.
      }
    }
  }

  /** Waits, watching cancellation and the deadline, and reports why it stopped. */
  async #wait(state: RunState, delayMs: number): Promise<"completed" | "cancelled" | "expired"> {
    if (state.scope.cancelled) {
      return "cancelled";
    }
    if (state.scope.isExpired()) {
      return "expired";
    }
    if (delayMs <= 0) {
      return "completed";
    }
    return new Promise<"completed" | "cancelled" | "expired">((resolve) => {
      let settled = false;
      const finish = (outcome: "completed" | "cancelled" | "expired"): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        // A deadline has no callback, so it is checked when the wait ends: a retry that would start
        // after the deadline must not start at all.
        finish(state.scope.isExpired() ? "expired" : "completed");
      }, delayMs);
      const unsubscribe = state.scope.context.cancellation.onCancelled(() => finish("cancelled"));
    });
  }
}

/** Builds an execution kernel. */
export function createExecutionKernel(options: ExecutionKernelOptions = {}): ExecutionKernel {
  return new InMemoryExecutionKernel(options);
}

// ---------------------------------------------------------------------------
// Record and outcome helpers
// ---------------------------------------------------------------------------

/** Everything needed to build a result, whichever variant it turns out to be. */
interface ResultFacts {
  readonly status: "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly executionId: ExecutionId;
  readonly output: JsonValue | null;
  readonly failure: ExecutionFailure | null;
  readonly usage: UsageSummary;
  readonly evaluation: EvaluationResult | null;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly metadata: AiCoreMetadata;
}

/**
 * Builds the result for a terminal status.
 *
 * A `switch` rather than a ternary: `ExecutionResult` is a discriminated union, and an object whose
 * `status` is a union of three literals is not assignable to it. Each branch has to name one status.
 */
function buildResult(facts: ResultFacts): ExecutionResult {
  switch (facts.status) {
    case "succeeded":
      return Object.freeze({
        status: "succeeded",
        executionId: facts.executionId,
        output: facts.output,
        usage: facts.usage,
        evaluation: facts.evaluation,
        completedAt: facts.completedAt,
        durationMs: facts.durationMs,
        metadata: facts.metadata,
      });
    case "cancelled":
      return Object.freeze({
        status: "cancelled",
        executionId: facts.executionId,
        failure: facts.failure ?? unknownFailure(facts.executionId, "cancelled"),
        usage: facts.usage,
        completedAt: facts.completedAt,
        durationMs: facts.durationMs,
        metadata: facts.metadata,
      });
    case "timed_out":
      return Object.freeze({
        status: "timed_out",
        executionId: facts.executionId,
        failure: facts.failure ?? unknownFailure(facts.executionId, "deadline exceeded"),
        usage: facts.usage,
        completedAt: facts.completedAt,
        durationMs: facts.durationMs,
        metadata: facts.metadata,
      });
    default:
      return Object.freeze({
        status: "failed",
        executionId: facts.executionId,
        failure: facts.failure ?? unknownFailure(facts.executionId, "execution failed"),
        usage: facts.usage,
        // The failed variant carries an evaluation: a failed execution is exactly the one worth
        // grading, and a result that could not hold one would force every reader to special-case it.
        evaluation: facts.evaluation,
        completedAt: facts.completedAt,
        durationMs: facts.durationMs,
        metadata: facts.metadata,
      });
  }
}

/**
 * Adds one attempt's usage to the run total.
 *
 * The first attempt seeds the total instead of being added to {@link EMPTY_USAGE}. An empty summary
 * is *unpriced* — `costMicro: null` — and {@link addUsage} propagates that, so seeding with it would
 * report every run as unpriced even when every attempt reported a cost, and the budget settlement
 * that reads the total would then never charge for anything.
 */
function accumulateUsage(total: UsageSummary, next: UsageSummary, seeded: boolean): UsageSummary {
  return seeded ? addUsage(total, next) : next;
}

function validateRequest(request: ExecutionRequest): ExecutionRequest {
  return validate(executionRequestSchema, request, "ExecutionRequest");
}

function createRecord(request: ExecutionRequest, context: ExecutionContext): ExecutionRecord {
  return freezeRecord({
    request,
    status: "created",
    plan: null,
    attempts: [],
    result: null,
    governance: initialExecutionMetadata(
      context.deadline === null ? null : deadlineIso(context.deadline),
    ),
    timeline: [timelineEntry(context.startedAt, "created", "execution created", null)],
    evaluation: null,
    createdAt: context.startedAt,
    updatedAt: context.startedAt,
  });
}

function freezeRecord(record: ExecutionRecord): ExecutionRecord {
  return Object.freeze({
    ...record,
    attempts: Object.freeze([...record.attempts]),
    timeline: Object.freeze([...record.timeline]),
  });
}

function timelineEntry(
  at: string,
  status: ExecutionStatus,
  note: string | null,
  stepId: string | null,
) {
  return Object.freeze({ at, status, note, stepId });
}

/** Reads a governance outcome back as the union the policy engine expects. */
function policyOutcomeOf(governance: ExecutionMetadata): PolicyOutcome | null {
  const outcome = governance.policyOutcome;
  if (
    outcome === "allow" ||
    outcome === "constrain" ||
    outcome === "require_approval" ||
    outcome === "deny"
  ) {
    return outcome;
  }
  return null;
}

/** How many attempts a step gets: its own limit, the contract's, and policy's, tightest first. */
function attemptLimit(step: ExecutionStep, state: RunState): number {
  const limits = [step.maxAttempts, MAX_RETRY_ATTEMPTS];
  if (state.policyMaxRetries !== null) {
    // `max_retries` counts retries, so it allows one more try than its value.
    limits.push(state.policyMaxRetries + 1);
  }
  return Math.max(1, Math.min(...limits));
}

/** The output of a run: one step's output, or a map of every step's. */
function aggregateOutput(state: RunState): JsonValue | null {
  const entries = [...state.stepOutputs.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    return entries[0]?.[1] ?? null;
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** What was actually consumed, as budget holds. */
function actualHolds(usage: UsageSummary): readonly BudgetHold[] {
  const holds: BudgetHold[] = [];
  if (usage.requests > 0) {
    holds.push(budgetHold("requests", usage.requests));
  }
  if (usage.totalTokens > 0) {
    holds.push(budgetHold("tokens", usage.totalTokens));
  }
  if (usage.costMicro !== null && usage.costMicro > 0) {
    holds.push(budgetHold("cost_micro_usd", usage.costMicro));
  }
  return Object.freeze(holds);
}

function describeHolds(holds: readonly BudgetHold[]): string {
  return holds.map((hold) => `${hold.dimension}=${String(hold.amount)}`).join(", ");
}

function describeExecution(request: ExecutionRequest): string {
  if (request.model !== null) {
    return `${request.kind}:${describeModelReference(request.model)}`;
  }
  if (request.tool !== null) {
    return `${request.kind}:${request.tool.kind === "id" ? request.tool.toolId : request.tool.name}`;
  }
  return request.agentId === null ? request.kind : `${request.kind}:${request.agentId}`;
}

/** A step's bound: its own timeout, policy's duration limit and the deadline, tightest first. */
function stepDeadlineMs(state: RunState, step: ExecutionStep): number | null {
  const candidates: number[] = [];
  if (step.timeoutMs !== null) {
    candidates.push(step.timeoutMs);
  }
  if (state.policyMaxDurationMs !== null) {
    candidates.push(state.policyMaxDurationMs);
  }
  const remaining = state.scope.remainingMs();
  if (remaining !== null) {
    candidates.push(remaining);
  }
  if (candidates.length === 0) {
    return null;
  }
  const tightest = Math.min(...candidates);
  return tightest > 0 ? Math.trunc(tightest) : 1;
}

function unmetDependency(
  step: ExecutionStep,
  statuses: Map<string, AttemptStatus>,
): { stepId: string; status: AttemptStatus } | null {
  for (const dependency of step.dependsOn) {
    const status = statuses.get(dependency);
    if (status !== "succeeded") {
      return { stepId: dependency, status: status ?? "skipped" };
    }
  }
  return null;
}

function attemptNote(
  step: ExecutionStep,
  attempt: number,
  outcome: StepOutcome,
  durationMs: number,
): string {
  const base = `step "${step.id}" attempt ${String(attempt)} ${outcome.status} in ${String(Math.max(0, Math.trunc(durationMs)))}ms`;
  return outcome.failure === null ? base : `${base}: ${describeFailure(outcome.failure)}`;
}

function cancellationFailure(scope: ExecutionScope, executionId: ExecutionId): ExecutionFailure {
  return failureFromError(
    executionCancelledError(executionId, scope.cancellationReason ?? "cancelled"),
    { executionId },
  );
}

function deadlineFailure(scope: ExecutionScope, executionId: ExecutionId): ExecutionFailure {
  const deadline = scope.context.deadline;
  return failureFromError(
    deadlineExceededError(executionId, deadline === null ? 0 : deadline.durationMs),
    { executionId },
  );
}

function unknownFailure(executionId: ExecutionId, note: string): ExecutionFailure {
  return createExecutionFailure({
    class: "unknown",
    code: "execution_failed",
    message: note,
    retryable: false,
    attempt: 1,
    executionId,
  });
}

function jsonOrNull(value: unknown): JsonValue | null {
  return value === undefined ? null : (value as JsonValue);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
