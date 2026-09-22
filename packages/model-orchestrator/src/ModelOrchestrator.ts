/**
 * The model orchestrator: one call, from a model reference to a normalized response.
 *
 * This is the only place in AI Core that talks to a provider adapter, and it does so through the
 * {@link ProviderAdapter} contract — never through a vendor SDK. What it is responsible for, in the
 * order it does it:
 *
 * 1. **Resolve.** A caller names a model by identifier, slug or capability. Resolution returns every
 *    matching descriptor in deterministic order, which is also the fallback order.
 * 2. **Authorize.** Policy is evaluated per candidate, not once per call: the model and the provider
 *    are policy inputs, and a fallback changes both. A denial stops the call; a `constrain` outcome
 *    bounds its cost, duration, retries and provider set.
 * 3. **Reserve.** Budget is held before the call is made — from the declared maximum output, which is
 *    the only honest upper bound available beforehand — and settled against measured usage after.
 * 4. **Invoke.** One adapter call, bounded by a timeout, watched for cancellation, normalized into
 *    either a response or a classified failure.
 * 5. **Retry, then fall back.** A retryable provider failure is retried against the same provider up
 *    to a bounded number of times; anything wider than that moves to the next candidate, and moving
 *    re-runs steps 2 and 3. A fallback is a new decision, not a continuation of the old one.
 * 6. **Report.** Every attempt is recorded, provider health is observed, the budget is settled and
 *    the span is decorated, so the result alone answers "what happened, what did it cost, why did it
 *    stop".
 *
 * There is no backoff that grows with the attempt number. A delay is either what the provider asked
 * for or the configured fixed delay, clamped to a published maximum: an unbounded wait in a retry
 * loop is how a degraded provider turns into an execution that outlives its deadline.
 */

import { parseTrimmedString } from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import {
  addUsage,
  createExecutionFailure,
  describeFailure,
  EMPTY_USAGE,
  failureFromError,
  listConstraint,
  numericConstraint,
  textMessage,
} from "@omnis/ai-core-types";
import type {
  BudgetHold,
  BudgetId,
  BudgetReservation,
  ModelParameters,
  ExecutionFailure,
  ExecutionId,
  ModelCapability,
  ModelDescriptor,
  ModelReference,
  ModelResponse,
  StopReason,
  ModelStreamEvent,
  PolicyId,
  PolicyOutcome,
  ProviderAdapter,
  ProviderId,
  UsageSummary,
} from "@omnis/ai-core-types";
import { budgetLimitsCost, estimateCallCost, estimateTotalMicro } from "@omnis/budget-engine";
import type { BudgetEngine } from "@omnis/budget-engine";
import {
  contextTelemetryAttributes,
  ExecutionScope,
  systemClock,
  toIso,
  spanParentOf,
} from "@omnis/execution-context";
import type { Clock, ExecutionContext } from "@omnis/execution-context";
import { ValidationError } from "@omnis/errors";
import type { ModelRegistry } from "@omnis/model-registry";
import type { PolicyEngine } from "@omnis/policy-engine";
import { adapterSupportsAll } from "@omnis/provider-registry";
import type { ProviderRegistry } from "@omnis/provider-registry";
import { aiSpanAttributes, NOOP_TRACER } from "@omnis/telemetry";
import type { Span, Tracer } from "@omnis/telemetry";
import { validate } from "@omnis/validation";
import {
  DEFAULT_INVOCATION_RETRY_DELAY_MS,
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_MAX_FALLBACK_PROVIDERS,
  DEFAULT_MAX_PROVIDER_ATTEMPTS,
  MAX_INVOCATION_RETRY_DELAY_MS,
  MAX_PROVIDER_ATTEMPTS,
  callExecutionId,
  modelParameters,
  providerAttempt,
} from "./ModelCall.js";
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelCandidate,
  ProviderAttempt,
} from "./ModelCall.js";
import {
  buildModelRequest,
  describeCallTarget,
  estimateInputTokens,
  failureFromAdapter,
  holdsForCall,
  holdsForUsage,
  impliedCapabilities,
  invocationContext,
  invocationDelayMs,
  invocationTimeoutMs,
  isProviderRetryable,
  normalizeInvocationResult,
  shouldTryNextProvider,
} from "./invocation.js";
import {
  noModelForReference,
  noProviderAvailable,
  providerNotServable,
  streamingUnsupported,
} from "./errors.js";
import { modelCallRequestSchema } from "./orchestratorValidation.js";

/** The most candidates one call will consider, however many the registry returns. */
export const MAX_CALL_CANDIDATES = 8;

/** What the orchestrator needs to do its job. */
export interface ModelOrchestratorOptions {
  readonly modelRegistry: ModelRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly policyEngine?: PolicyEngine | null;
  readonly budgetEngine?: BudgetEngine | null;
  readonly tracer?: Tracer;
  readonly clock?: Clock;
  /** Per-invocation allowance when the caller and policy both say nothing. */
  readonly defaultTimeoutMs?: number;
  readonly defaultPolicyIds?: readonly PolicyId[];
  readonly defaultBudgetId?: BudgetId | null;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Overrides the holds the orchestrator reserves before a call. */
  readonly estimateHolds?: (
    descriptor: ModelDescriptor,
    call: ModelCallRequest,
  ) => ReturnType<typeof holdsForCall>;
}

/** The orchestrator's public surface. */
export interface ModelOrchestrator {
  /** Runs one call to completion and reports what happened. */
  call(request: ModelCallRequest, context?: ExecutionContext | null): Promise<ModelCallResult>;

  /**
   * Streams one call.
   *
   * Yields the provider's events and always ends with either a `completed` or a `failed` event: a
   * stream that simply stops leaves a caller waiting on something that never arrives.
   */
  stream(
    request: ModelCallRequest,
    context?: ExecutionContext | null,
  ): AsyncGenerator<ModelStreamEvent>;

  /** The candidates a reference resolves to, in the order the orchestrator would try them. */
  candidatesFor(reference: ModelReference): readonly ModelCandidate[];
}

/** Everything one call accumulates while it runs. Never shared between calls. */
interface CallState {
  readonly executionId: ExecutionId;
  readonly context: ExecutionContext;
  readonly attempts: ProviderAttempt[];
  /** True once an attempt has reported usage, so the total is seeded rather than summed from empty. */
  seeded: boolean;
  usage: UsageSummary;
  /** How far down the candidate list the call got: 0 for the first candidate, 1 for the first fallback. */
  fallbacks: number;
  /** Candidates an adapter was actually asked to serve. A skipped candidate is not a call. */
  modelCalls: number;
  policyOutcome: PolicyOutcome | null;
  policyId: PolicyId | null;
  budgetId: BudgetId | null;
  reservation: BudgetReservation | null;
  startedAtMs: number;
  span: Span | null;
  maxModelCalls: number | null;
  maxDurationMs: number | null;
  maxRetries: number | null;
  allowedProviders: readonly string[];
  deniedProviders: readonly string[];
  allowedModels: readonly string[];
  deniedModels: readonly string[];
  maxCostMicro: number | null;
  /** Policy's ceiling on generated tokens, or null when policy sets none. */
  maxOutputTokens: number | null;
  /** Why the most recent candidate was passed over, and whether policy said so. */
  lastSkip: { readonly reason: string; readonly policy: boolean } | null;
  /** The stream in flight, so abandoning one still leaves an attempt row and settles the hold. */
  pendingStream: {
    descriptor: ModelDescriptor;
    depth: number;
    startedAtMs: number;
    usage: UsageSummary;
    emitted: boolean;
  } | null;
}

/** What one candidate produced. */
interface InvocationOutcome {
  readonly response: ModelResponse | null;
  readonly failure: ExecutionFailure | null;
}

/** The in-memory orchestrator. It holds no state between calls beyond what it is given. */
export class InMemoryModelOrchestrator implements ModelOrchestrator {
  readonly #modelRegistry: ModelRegistry;
  readonly #providerRegistry: ProviderRegistry;
  readonly #policyEngine: PolicyEngine | null;
  readonly #budgetEngine: BudgetEngine | null;
  readonly #tracer: Tracer;
  readonly #clock: Clock;
  readonly #defaultTimeoutMs: number;
  readonly #defaultPolicyIds: readonly PolicyId[];
  readonly #defaultBudgetId: BudgetId | null;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #estimateHolds: ModelOrchestratorOptions["estimateHolds"];

  constructor(options: ModelOrchestratorOptions) {
    if (options.modelRegistry === undefined || options.providerRegistry === undefined) {
      throw new ValidationError(
        "a model orchestrator needs a model registry and a provider registry",
        {
          retryable: false,
          metadata: { registry: "orchestrator" },
        },
      );
    }
    this.#modelRegistry = options.modelRegistry;
    this.#providerRegistry = options.providerRegistry;
    this.#policyEngine = options.policyEngine ?? null;
    this.#budgetEngine = options.budgetEngine ?? null;
    this.#tracer = options.tracer ?? NOOP_TRACER;
    this.#clock = options.clock ?? systemClock;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS;
    this.#defaultPolicyIds = Object.freeze([...(options.defaultPolicyIds ?? [])]);
    this.#defaultBudgetId = options.defaultBudgetId ?? null;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_INVOCATION_RETRY_DELAY_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? MAX_INVOCATION_RETRY_DELAY_MS;
    this.#estimateHolds = options.estimateHolds;
  }

  candidatesFor(reference: ModelReference): readonly ModelCandidate[] {
    const resolution = this.#modelRegistry.resolve(reference);
    if (resolution === null) {
      return Object.freeze([]);
    }
    return Object.freeze(resolution.candidates.map(candidateOf));
  }

  async call(
    request: ModelCallRequest,
    context: ExecutionContext | null = null,
  ): Promise<ModelCallResult> {
    const call = validatedCall(validate(modelCallRequestSchema, request, "ModelCallRequest"));
    const parameters = modelParameters(call.parameters);
    const streaming = call.streaming === true;
    const capabilities = impliedCapabilities(call, parameters);
    const { scope, ownsScope } = this.#openScope(call, context);
    const state = this.#openState(call, scope);

    try {
      const prepared = this.#prepare(call, state);
      if (prepared.failure !== null) {
        return this.#finish(state, prepared.failure, prepared.descriptor, null);
      }

      for (const [depth, descriptor] of prepared.candidates.entries()) {
        state.fallbacks = depth;
        const stopped = this.#stoppedBefore(state, scope);
        if (stopped !== null) {
          return this.#finish(state, stopped, descriptor, null);
        }
        if (state.maxModelCalls !== null && state.modelCalls >= state.maxModelCalls) {
          return this.#finish(
            state,
            this.#refusal(
              state.executionId,
              "policy_blocked",
              "policy_violation",
              `policy allows at most ${String(state.maxModelCalls)} model call(s)`,
              {
                modelId: descriptor.id,
                providerId: descriptor.providerId,
              },
            ),
            descriptor,
            null,
          );
        }

        const authorized = this.#authorizeFor(state, scope, call, descriptor, capabilities);
        if (authorized !== null) {
          return this.#finish(state, authorized, descriptor, null);
        }

        const selection = this.#selectionRefusal(state, descriptor, call);
        if (selection !== null) {
          this.#skip(state, descriptor, depth, selection);
          continue;
        }

        const reserved = this.#reserveFor(state, descriptor, call);
        if (reserved !== null) {
          return this.#finish(state, reserved, descriptor, null);
        }

        const adapter = this.#providerRegistry.adapterFor(descriptor.providerId);
        if (adapter === null) {
          this.#skip(state, descriptor, depth, {
            reason: providerNotServable(descriptor.providerId, "no adapter is registered").message,
            policy: false,
          });
          continue;
        }
        const unservable = this.#unservableReason(descriptor, adapter, capabilities);
        if (unservable !== null) {
          this.#skip(state, descriptor, depth, { reason: unservable, policy: false });
          continue;
        }

        const affordable = this.#budgetAllowsAnotherCall(state, descriptor, call, depth);
        if (affordable !== null) {
          return this.#finish(state, affordable, descriptor, null);
        }

        // A caller that asked for a stream but reached an adapter without one still gets an answer:
        // `invoke` serves the call, and the response is reported whole.
        state.modelCalls += 1;
        const outcome = await this.#invokeWithRetries(
          state,
          scope,
          call,
          descriptor,
          adapter,
          parameters,
          capabilities,
          streaming,
          depth,
        );
        if (outcome.response !== null) {
          return this.#finish(state, null, descriptor, outcome.response);
        }
        if (outcome.failure !== null && !shouldTryNextProvider(outcome.failure)) {
          // A cancellation, a policy refusal, a budget refusal and a validation failure are facts
          // about this call. Another provider would not change any of them.
          return this.#finish(state, outcome.failure, descriptor, null);
        }
      }

      return this.#finish(
        state,
        this.#exhausted(state, call),
        prepared.candidates[0] ?? null,
        null,
      );
    } finally {
      this.#endSpan(state);
      if (ownsScope) {
        scope.dispose();
      }
    }
  }

  async *stream(
    request: ModelCallRequest,
    context: ExecutionContext | null = null,
  ): AsyncGenerator<ModelStreamEvent> {
    const call = validatedCall(
      validate(modelCallRequestSchema, { ...request, streaming: true }, "ModelCallRequest"),
    );
    const parameters = modelParameters(call.parameters);
    const capabilities = impliedCapabilities(call, parameters);
    const { scope, ownsScope } = this.#openScope(call, context);
    const state = this.#openState(call, scope);
    let finished = false;
    /** Every way a stream ends must settle its hold exactly once. */
    const finish = (
      failure: ExecutionFailure | null,
      descriptor: ModelDescriptor | null,
      response: ModelResponse | null,
    ): ModelCallResult => {
      finished = true;
      return this.#finish(state, failure, descriptor, response);
    };

    try {
      const prepared = this.#prepare(call, state);
      if (prepared.failure !== null) {
        yield failedEvent(prepared.failure);
        finish(prepared.failure, prepared.descriptor, null);
        return;
      }

      for (const [depth, descriptor] of prepared.candidates.entries()) {
        state.fallbacks = depth;
        const stopped = this.#stoppedBefore(state, scope);
        if (stopped !== null) {
          yield failedEvent(stopped);
          finish(stopped, descriptor, null);
          return;
        }
        const authorized = this.#authorizeFor(state, scope, call, descriptor, capabilities);
        if (authorized !== null) {
          yield failedEvent(authorized);
          finish(authorized, descriptor, null);
          return;
        }
        const selection = this.#selectionRefusal(state, descriptor, call);
        if (selection !== null) {
          this.#skip(state, descriptor, depth, selection);
          continue;
        }
        const reserved = this.#reserveFor(state, descriptor, call);
        if (reserved !== null) {
          yield failedEvent(reserved);
          finish(reserved, descriptor, null);
          return;
        }

        const adapter = this.#providerRegistry.adapterFor(descriptor.providerId);
        if (adapter === null) {
          this.#skip(state, descriptor, depth, {
            reason: providerNotServable(descriptor.providerId, "no adapter is registered").message,
            policy: false,
          });
          continue;
        }
        // Whether the adapter can stream is a capability question, and it is asked before anything is
        // synthesized: a provider that does not offer streaming must not answer a streaming call.
        const unservable = this.#unservableReason(descriptor, adapter, capabilities);
        if (unservable !== null) {
          this.#skip(state, descriptor, depth, { reason: unservable, policy: false });
          continue;
        }
        if (adapter.stream === undefined) {
          // No streaming adapter: answer with one invocation and report it as events.
          state.modelCalls += 1;
          const outcome = await this.#invokeWithRetries(
            state,
            scope,
            call,
            descriptor,
            adapter,
            parameters,
            capabilities,
            false,
            depth,
          );
          if (outcome.response !== null) {
            yield* synthesizedStream(descriptor, outcome.response);
            finish(null, descriptor, outcome.response);
            return;
          }
          if (outcome.failure !== null && !shouldTryNextProvider(outcome.failure)) {
            yield failedEvent(outcome.failure);
            finish(outcome.failure, descriptor, null);
            return;
          }
          continue;
        }

        state.modelCalls += 1;
        const streamed = yield* this.#streamFromAdapter(
          state,
          scope,
          call,
          descriptor,
          adapter,
          parameters,
          depth,
        );
        if (streamed.response !== null) {
          finish(null, descriptor, streamed.response);
          return;
        }
        if (streamed.emitted) {
          // Content already reached the caller. Restarting against another provider would produce a
          // second answer to one question, so the failure is reported rather than hidden.
          const failure =
            streamed.failure ??
            this.#refusal(
              state.executionId,
              "provider_failure",
              "provider_failure",
              "the stream stopped before it completed",
            );
          yield failedEvent(failure);
          finish(failure, descriptor, null);
          return;
        }
        if (streamed.failure !== null && !shouldTryNextProvider(streamed.failure)) {
          yield failedEvent(streamed.failure);
          finish(streamed.failure, descriptor, null);
          return;
        }
      }

      const failure = this.#exhausted(state, call);
      yield failedEvent(failure);
      finish(failure, prepared.candidates[0] ?? null, null);
    } finally {
      if (!finished) {
        // A consumer that stops reading is a cancellation the orchestrator did not ask for. The hold
        // is released and the abandonment is recorded, because a stream that leaks a reservation
        // would spend a budget nobody is using any more.
        const pending = state.pendingStream;
        const failure = this.#refusal(
          state.executionId,
          "cancelled",
          "execution_failed",
          "the stream was abandoned before it completed",
        );
        if (pending !== null) {
          this.#recordStreamAttempt(
            state,
            pending.descriptor,
            pending.depth,
            pending.startedAtMs,
            pending.usage,
            failure,
          );
          state.pendingStream = null;
        }
        finish(failure, pending?.descriptor ?? null, null);
      }
      this.#endSpan(state);
      if (ownsScope) {
        scope.dispose();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Preparation
  // -------------------------------------------------------------------------

  #openScope(
    call: ModelCallRequest,
    context: ExecutionContext | null,
  ): { scope: ExecutionScope; ownsScope: boolean } {
    const executionId = callExecutionId(call);
    const identity = {
      executionId,
      ...(call.correlationId === undefined || call.correlationId === null
        ? {}
        : { correlationId: call.correlationId }),
      ...(call.tenantId === undefined ? {} : { tenantId: call.tenantId }),
      ...(call.agentId === undefined ? {} : { agentId: call.agentId }),
      ...(call.deadlineMs === undefined ? {} : { deadlineMs: call.deadlineMs }),
    };
    const metadata = { ...(call.metadata ?? {}) };
    // A caller's context is a parent, not a template: the call gets its own scope so that cancelling
    // the call cannot cancel the caller, and the caller's deadline still bounds it.
    const scope =
      context === null
        ? ExecutionScope.createRoot(
            { ...identity, mode: call.streaming === true ? "streaming" : "interactive", metadata },
            { clock: this.#clock },
          )
        : ExecutionScope.createChildOfContext(
            context,
            { ...identity, mode: call.streaming === true ? "streaming" : context.mode, metadata },
            { clock: this.#clock },
          );
    return { scope, ownsScope: true };
  }

  #openState(call: ModelCallRequest, scope: ExecutionScope): CallState {
    const state: CallState = {
      executionId: scope.context.executionId,
      context: scope.context,
      attempts: [],
      seeded: false,
      usage: EMPTY_USAGE,
      fallbacks: 0,
      modelCalls: 0,
      policyOutcome: null,
      policyId: null,
      budgetId: call.budgetId ?? this.#defaultBudgetId,
      reservation: null,
      startedAtMs: scope.now(),
      span: null,
      maxModelCalls: null,
      maxDurationMs: null,
      maxRetries: null,
      allowedProviders: [],
      deniedProviders: [],
      allowedModels: [],
      deniedModels: [],
      maxCostMicro: null,
      maxOutputTokens: null,
      lastSkip: null,
      pendingStream: null,
    };
    state.span = this.#startSpan(state, call);
    return state;
  }

  /** Resolves the reference and bounds the candidate list. */
  #prepare(
    call: ModelCallRequest,
    state: CallState,
  ): {
    candidates: readonly ModelDescriptor[];
    failure: ExecutionFailure | null;
    descriptor: ModelDescriptor | null;
  } {
    const resolution = this.#modelRegistry.resolve(call.model);
    if (resolution === null) {
      return {
        candidates: [],
        failure: this.#failureFrom(noModelForReference(call.model), state),
        descriptor: null,
      };
    }
    // The registry's contract is that a resolution's candidates are selectable, so the orchestrator
    // bounds how many it will try and does not re-decide what "selectable" means.
    const limit = Math.min(
      Math.max(1, call.maxProviders ?? DEFAULT_MAX_FALLBACK_PROVIDERS),
      MAX_CALL_CANDIDATES,
    );
    const candidates = resolution.candidates.slice(0, limit);
    return { candidates, failure: null, descriptor: candidates[0] ?? resolution.descriptor };
  }

  // -------------------------------------------------------------------------
  // Governance
  // -------------------------------------------------------------------------

  /** Evaluates policy for one candidate, or returns the failure that stops the call. */
  #authorizeFor(
    state: CallState,
    scope: ExecutionScope,
    call: ModelCallRequest,
    descriptor: ModelDescriptor,
    capabilities: readonly ModelCapability[],
  ): ExecutionFailure | null {
    const policyIds = this.#policyIdsFor(call);
    if (this.#policyEngine === null || policyIds.length === 0) {
      return null;
    }
    try {
      const provider = this.#providerRegistry.get(descriptor.providerId);
      const gate = this.#policyEngine.gateWithContext(
        scope.context,
        {
          action: "model.call",
          subject: "model",
          resource: describeCallTarget(descriptor),
          toolId: null,
          modelId: descriptor.id,
          providerId: descriptor.providerId,
          budgetId: state.budgetId,
          attributes: {
            modelSlug: descriptor.slug,
            modelKind: descriptor.kind,
            modelStatus: descriptor.status,
            providerSlug: provider?.slug ?? null,
            providerStatus: provider?.status ?? null,
            streaming: call.streaming === true,
            capabilities: [...capabilities],
            contextWindowTokens: descriptor.contextWindowTokens,
            maxOutputTokens: descriptor.maxOutputTokens,
            priced: descriptor.pricing !== null,
            fallbackDepth: state.fallbacks,
            approved: call.approval?.approved ?? null,
            approvalGranted: call.approval?.approved === true,
          },
        },
        policyIds,
      );

      state.policyOutcome = gate.outcome;
      state.policyId = gate.decidedByPolicyId;
      state.maxDurationMs = numericConstraint(gate.constraints, "max_duration_ms");
      state.maxRetries = numericConstraint(gate.constraints, "max_retries");
      state.maxModelCalls = numericConstraint(gate.constraints, "max_model_calls");
      state.maxCostMicro = numericConstraint(gate.constraints, "max_cost_micro_usd");
      state.allowedProviders = listConstraint(gate.constraints, "allowed_providers");
      state.deniedProviders = listConstraint(gate.constraints, "denied_providers");
      state.allowedModels = listConstraint(gate.constraints, "allowed_models");
      state.deniedModels = listConstraint(gate.constraints, "denied_models");
      state.maxOutputTokens = numericConstraint(gate.constraints, "max_output_tokens");

      if (gate.outcome === "deny") {
        return this.#refusal(
          state.executionId,
          "policy_blocked",
          "policy_violation",
          gate.reason ?? `policy denied ${describeCallTarget(descriptor)}`,
          {
            policyId: gate.decidedByPolicyId,
            ruleId: gate.decidedByRuleId,
            modelId: descriptor.id,
            providerId: descriptor.providerId,
          },
        );
      }
      if (gate.outcome === "require_approval" && call.approval?.approved !== true) {
        return this.#refusal(
          state.executionId,
          "policy_blocked",
          "policy_violation",
          gate.reason ?? "the call requires an approval",
          {
            approvalRequired: true,
            modelId: descriptor.id,
            providerId: descriptor.providerId,
          },
        );
      }
      return null;
    } catch (error) {
      // Failing closed is the only safe reading of "we could not ask": a call whose policy could not
      // be evaluated is a call whose policy was not satisfied. The cause is reported, not swallowed.
      const cause = failureFromError(error, {
        executionId: state.executionId,
        modelId: descriptor.id,
        providerId: descriptor.providerId,
      });
      return this.#refusal(
        state.executionId,
        "policy_blocked",
        "policy_violation",
        `policy could not be evaluated for ${describeCallTarget(descriptor)}: ${cause.message}`,
        {
          policyEvaluationFailed: true,
          causeClass: cause.class,
        },
      );
    }
  }

  /**
   * Why policy passed this candidate over, or null when policy is content with it.
   *
   * A `deny` outcome and a missing approval stop the call: they are answers about the action. A
   * provider list or a cost ceiling is an answer about *this* candidate, and a cheaper or allowed
   * candidate may still serve the call — so it is a skip, recorded, not a refusal of the whole call.
   */
  #selectionRefusal(
    state: CallState,
    descriptor: ModelDescriptor,
    call: ModelCallRequest,
  ): { reason: string; policy: boolean } | null {
    if (state.deniedModels.includes(descriptor.id)) {
      return { reason: `policy denies model ${descriptor.slug}`, policy: true };
    }
    if (state.allowedModels.length > 0 && !state.allowedModels.includes(descriptor.id)) {
      return { reason: `policy does not allow model ${descriptor.slug}`, policy: true };
    }
    if (!providerAllowed(state, descriptor.providerId)) {
      return { reason: `policy does not allow provider ${descriptor.providerId}`, policy: true };
    }
    const estimated = estimatedCostMicro(descriptor, call);
    if (state.maxCostMicro !== null && estimated !== null && estimated > state.maxCostMicro) {
      return {
        reason: `the call is estimated at ${String(estimated)} micro-USD and policy allows ${String(state.maxCostMicro)}`,
        policy: true,
      };
    }
    return null;
  }

  /** Records a candidate the orchestrator passed over, and moves to the next one. */
  #skip(
    state: CallState,
    descriptor: ModelDescriptor,
    depth: number,
    skip: { reason: string; policy: boolean },
  ): void {
    state.attempts.push(this.#skippedAttempt(descriptor, depth, skip.reason));
    state.lastSkip = skip;
  }

  /**
   * The failure to report when every candidate was tried and none answered.
   *
   * When a provider actually ran and failed, its own failure is the answer: it says what went wrong,
   * and the attempt trail says how many times. A synthesized "no provider available" would replace a
   * cause with a summary, so it is reported only when nothing ran at all — every candidate was
   * passed over, or none matched.
   */
  #exhausted(state: CallState, call: ModelCallRequest): ExecutionFailure {
    const ranAndFailed = state.attempts.filter(
      (attempt) => attempt.status === "failed" && attempt.failure !== null,
    );
    const lastFailure = ranAndFailed[ranAndFailed.length - 1]?.failure ?? null;
    if (lastFailure !== null) {
      return lastFailure;
    }
    const skip = state.lastSkip;
    if (skip !== null && skip.policy) {
      return this.#refusal(state.executionId, "policy_blocked", "policy_violation", skip.reason, {
        candidatesTried: state.attempts.length,
      });
    }
    return noProviderAvailableFailure(call.model, state.attempts.length);
  }

  /** Reserves budget once per call, or reports why it could not. */
  #reserveFor(
    state: CallState,
    descriptor: ModelDescriptor,
    call: ModelCallRequest,
  ): ExecutionFailure | null {
    if (this.#budgetEngine === null || state.budgetId === null || state.reservation !== null) {
      // One reservation per call: a fallback is charged against the same hold, and a second
      // reservation would double-count work that has not happened yet.
      return null;
    }
    const holds =
      this.#estimateHolds?.(descriptor, call) ??
      holdsForCall(descriptor, modelParameters(call.parameters), call.messages);
    const refused = this.#budgetRefusal(state, holds, state.executionId);
    if (refused !== null) {
      return refused;
    }
    try {
      state.reservation = this.#budgetEngine.reserve({
        budgetId: state.budgetId,
        executionId: state.executionId,
        key: state.executionId,
        holds,
        sessionId: null,
      });
      return null;
    } catch (error) {
      return this.#failureFrom(error, state);
    }
  }

  /**
   * Asks the budget engine whether these holds fit, and reports a refusal as a budget refusal.
   *
   * Asking rather than catching: the engine's own refusal for a limit is an exception, and an
   * exception-driven classification would report a spent budget as whatever the error's code happens
   * to map to. Two things are checked, both before any money is spent — that priced work is priced
   * when the budget limits cost, and that the holds fit what is left.
   */
  #budgetRefusal(
    state: CallState,
    holds: readonly BudgetHold[],
    key: string,
  ): ExecutionFailure | null {
    const engine = this.#budgetEngine;
    const budgetId = state.budgetId;
    if (engine === null || budgetId === null) {
      return null;
    }
    const budget = engine.getBudget(budgetId);
    if (
      budget !== null &&
      budgetLimitsCost(budget) &&
      !holds.some((hold) => hold.dimension === "cost_micro_usd")
    ) {
      return this.#refusal(
        state.executionId,
        "budget_blocked",
        "conflict",
        "the model publishes no price and the budget limits cost",
        {
          blockingDimension: "cost_micro_usd",
        },
      );
    }
    try {
      const check = engine.check({
        budgetId,
        executionId: state.executionId,
        key,
        holds,
        sessionId: null,
      });
      if (check.allowed) {
        return null;
      }
      return this.#refusal(
        state.executionId,
        "budget_blocked",
        "conflict",
        check.reason ??
          `the budget does not allow this call (${check.blockingDimension ?? "unknown dimension"})`,
        { blockingDimension: check.blockingDimension },
      );
    } catch (error) {
      return this.#failureFrom(error, state);
    }
  }

  /** Re-validates budget before spending on another provider. */
  #budgetAllowsAnotherCall(
    state: CallState,
    descriptor: ModelDescriptor,
    call: ModelCallRequest,
    depth: number,
  ): ExecutionFailure | null {
    if (this.#budgetEngine === null || state.budgetId === null || depth === 0) {
      return null;
    }
    const holds =
      this.#estimateHolds?.(descriptor, call) ??
      holdsForCall(descriptor, modelParameters(call.parameters), call.messages);
    return this.#budgetRefusal(state, holds, `${state.executionId}:fallback-${String(depth)}`);
  }

  /** Why a candidate cannot be served at all, or null when it can. */
  #unservableReason(
    descriptor: ModelDescriptor,
    adapter: ProviderAdapter,
    capabilities: readonly ModelCapability[],
  ): string | null {
    const provider = this.#providerRegistry.get(descriptor.providerId);
    if (
      provider !== null &&
      (provider.status === "disabled" || provider.status === "unavailable")
    ) {
      return `provider status is ${provider.status}`;
    }
    if (provider !== null && !provider.credentialsConfigured) {
      // A provider without credentials cannot answer, and trying it would surface a vendor
      // authentication error as though it were a model failure.
      return "the provider has no credentials configured";
    }
    if (!adapterSupportsAll(adapter, capabilities, descriptor.id)) {
      return `the adapter does not serve ${capabilities.join(", ")}`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Invocation
  // -------------------------------------------------------------------------

  async #invokeWithRetries(
    state: CallState,
    scope: ExecutionScope,
    call: ModelCallRequest,
    descriptor: ModelDescriptor,
    adapter: ProviderAdapter,
    parameters: ReturnType<typeof modelParameters>,
    capabilities: readonly ModelCapability[],
    streaming: boolean,
    depth: number,
  ): Promise<InvocationOutcome> {
    const attemptsAllowed = attemptLimit(call, state);
    const modelRequest = buildModelRequest(
      descriptor,
      call,
      boundedParameters(parameters, state.maxOutputTokens),
      streaming,
    );
    let lastFailure: ExecutionFailure | null = null;

    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      const stopped = this.#stoppedBefore(state, scope);
      if (stopped !== null) {
        return { response: null, failure: stopped };
      }

      const timeoutMs = invocationTimeoutMs({
        requested: call.timeoutMs ?? null,
        policyLimit: state.maxDurationMs,
        remainingMs: scope.remainingMs(),
        fallback: this.#defaultTimeoutMs,
      });
      const startedAtMs = this.#clock();
      const invocation = invocationContext({
        context: scope.context,
        descriptor,
        attempt,
        timeoutMs,
        streaming,
        remainingMs: () => scope.remainingMs(),
        metadata: { fallbackDepth: depth, capabilities: [...capabilities] },
      });

      let normalized;
      try {
        normalized = normalizeInvocationResult(await adapter.invoke(modelRequest, invocation), {
          executionId: state.executionId,
          descriptor,
          attempt,
          startedAtMs,
          clock: this.#clock,
        });
      } catch (error) {
        normalized = {
          status: "failed" as const,
          failure: failureFromAdapter(error, {
            executionId: state.executionId,
            descriptor,
            attempt,
          }),
          usage: EMPTY_USAGE,
          latencyMs: Math.max(0, this.#clock() - startedAtMs),
        };
      }

      const finishedAtMs = this.#clock();
      const usage = normalized.usage;
      this.#accumulate(state, usage);
      state.attempts.push(
        providerAttempt({
          providerId: descriptor.providerId,
          modelId: descriptor.id,
          fallbackDepth: depth,
          attempt,
          status: normalized.status === "completed" ? "succeeded" : "failed",
          startedAt: toIso(startedAtMs),
          finishedAt: toIso(finishedAtMs),
          latencyMs: Math.max(0, normalized.latencyMs),
          // Whether the answer actually arrived as a stream, not whether one was asked for: an
          // adapter without `stream` still serves the call, and the row should not claim otherwise.
          streamed: normalized.status === "completed" ? normalized.response.streamed : false,
          usage,
          failure: normalized.status === "failed" ? normalized.failure : null,
        }),
      );

      if (normalized.status === "completed") {
        this.#observeHealth(descriptor.providerId, null, normalized.latencyMs);
        return { response: normalized.response, failure: null };
      }

      lastFailure = normalized.failure;
      this.#observeHealth(descriptor.providerId, normalized.failure.class, normalized.latencyMs);
      if (!isProviderRetryable(normalized.failure) || attempt >= attemptsAllowed) {
        break;
      }
      const waited = await this.#wait(
        scope,
        invocationDelayMs(normalized.failure, this.#retryDelayMs, this.#maxRetryDelayMs),
      );
      if (waited === "cancelled") {
        return { response: null, failure: cancellationFailure(scope, state.executionId) };
      }
      if (waited === "expired") {
        return { response: null, failure: deadlineFailure(scope, state.executionId) };
      }
    }

    return {
      response: null,
      failure:
        lastFailure ??
        this.#refusal(
          state.executionId,
          "provider_failure",
          "provider_failure",
          `${describeCallTarget(descriptor)} did not answer`,
        ),
    };
  }

  /** Streams from one adapter, accumulating what it emitted. */
  async *#streamFromAdapter(
    state: CallState,
    scope: ExecutionScope,
    call: ModelCallRequest,
    descriptor: ModelDescriptor,
    adapter: ProviderAdapter,
    parameters: ReturnType<typeof modelParameters>,
    depth: number,
  ): AsyncGenerator<
    ModelStreamEvent,
    { response: ModelResponse | null; failure: ExecutionFailure | null; emitted: boolean }
  > {
    const timeoutMs = invocationTimeoutMs({
      requested: call.timeoutMs ?? null,
      policyLimit: state.maxDurationMs,
      remainingMs: scope.remainingMs(),
      fallback: this.#defaultTimeoutMs,
    });
    const startedAtMs = this.#clock();
    const invocation = invocationContext({
      context: scope.context,
      descriptor,
      attempt: 1,
      timeoutMs,
      streaming: true,
      remainingMs: () => scope.remainingMs(),
      metadata: { fallbackDepth: depth },
    });
    const modelRequest = buildModelRequest(
      descriptor,
      call,
      boundedParameters(parameters, state.maxOutputTokens),
      true,
    );

    let emitted = false;
    let usage: UsageSummary = EMPTY_USAGE;
    let stopReason: StopReason = "stop";
    let terminated = false;
    let text = "";

    const events = adapter.stream?.(modelRequest, invocation);
    if (events === undefined) {
      const failure = this.#failureFrom(
        streamingUnsupported(descriptor.providerId, descriptor.id),
        state,
      );
      return { response: null, failure, emitted };
    }

    // Published as soon as the stream is open, so an abandonment can be reported against the
    // provider that was actually serving it.
    const pending = { descriptor, depth, startedAtMs, usage, emitted };
    state.pendingStream = pending;

    try {
      for await (const event of events) {
        if (scope.cancelled) {
          const failure = cancellationFailure(scope, state.executionId);
          state.pendingStream = null;
          this.#recordStreamAttempt(state, descriptor, depth, startedAtMs, usage, failure);
          return { response: null, failure, emitted };
        }
        if (event.type === "delta") {
          text += event.text;
          emitted = true;
          pending.emitted = true;
        } else if (event.type === "usage") {
          usage = event.usage;
          pending.usage = usage;
        } else if (event.type === "completed") {
          stopReason = event.stopReason;
          terminated = true;
        } else if (event.type === "failed") {
          const failure = this.#refusal(
            state.executionId,
            event.retryable ? "retryable" : "provider_failure",
            event.retryable ? "provider_failure" : "execution_failed",
            event.message,
            { errorCode: event.errorCode },
          );
          state.pendingStream = null;
          this.#recordStreamAttempt(state, descriptor, depth, startedAtMs, usage, failure);
          return { response: null, failure, emitted };
        }
        yield event;
      }
    } catch (error) {
      const failure = failureFromAdapter(error, {
        executionId: state.executionId,
        descriptor,
        attempt: 1,
      });
      state.pendingStream = null;
      this.#recordStreamAttempt(state, descriptor, depth, startedAtMs, usage, failure);
      return { response: null, failure, emitted };
    }

    const latencyMs = Math.max(0, this.#clock() - startedAtMs);
    state.pendingStream = null;
    if (!terminated) {
      // The provider stopped talking without saying it was finished. Reporting that as an answer
      // would hand the caller a truncated response labelled complete.
      const failure = this.#refusal(
        state.executionId,
        "provider_failure",
        "provider_failure",
        "the stream stopped before it completed",
      );
      this.#recordStreamAttempt(state, descriptor, depth, startedAtMs, usage, failure);
      this.#observeHealth(descriptor.providerId, failure.class, latencyMs);
      return { response: null, failure, emitted };
    }
    this.#recordStreamAttempt(state, descriptor, depth, startedAtMs, usage, null);
    this.#observeHealth(descriptor.providerId, null, latencyMs);
    return {
      response: streamResponse(
        descriptor,
        text,
        usage,
        stopReason,
        latencyMs,
        toIso(this.#clock()),
      ),
      failure: null,
      emitted: true,
    };
  }

  #recordStreamAttempt(
    state: CallState,
    descriptor: ModelDescriptor,
    depth: number,
    startedAtMs: number,
    usage: UsageSummary,
    failure: ExecutionFailure | null,
  ): void {
    const finishedAtMs = this.#clock();
    this.#accumulate(state, usage);
    state.attempts.push(
      providerAttempt({
        providerId: descriptor.providerId,
        modelId: descriptor.id,
        fallbackDepth: depth,
        attempt: 1,
        status: failure === null ? "succeeded" : "failed",
        startedAt: toIso(startedAtMs),
        finishedAt: toIso(finishedAtMs),
        latencyMs: Math.max(0, finishedAtMs - startedAtMs),
        streamed: true,
        usage,
        failure,
      }),
    );
  }

  /** Adds one attempt's usage to the total, seeding from the first rather than summing from empty. */
  #accumulate(state: CallState, usage: UsageSummary): void {
    // An attempt that consumed nothing must not make a priced call unpriced. `EMPTY_USAGE.costMicro`
    // is null, which means "unpriced" rather than "free", and `addUsage` propagates null to the
    // total: without this guard, one failed attempt in front of a successful fallback would report
    // the whole call as unpriced, and a cost ceiling could not see what the call cost.
    if (usage.requests === 0 && usage.totalTokens === 0 && usage.costMicro === null) {
      return;
    }
    // Seeding from the first attempt that consumed anything keeps a priced call priced.
    state.usage = state.seeded ? addUsage(state.usage, usage) : usage;
    state.seeded = true;
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /** Builds the result, settles the budget and decorates the span. */
  #finish(
    state: CallState,
    failure: ExecutionFailure | null,
    descriptor: ModelDescriptor | null,
    response: ModelResponse | null,
  ): ModelCallResult {
    const completedAtMs = this.#clock();
    const latencyMs = Math.max(0, completedAtMs - state.startedAtMs);
    const budgetStatus = this.#settle(state, descriptor);
    const base = {
      executionId: state.executionId,
      usage: state.usage,
      latencyMs,
      attempts: Object.freeze([...state.attempts]),
      fallbacks: state.fallbacks,
      policyOutcome: state.policyOutcome,
      policyId: state.policyId,
      budgetId: state.budgetId,
      budgetStatus,
      startedAt: toIso(state.startedAtMs),
      completedAt: toIso(completedAtMs),
    };
    const result: ModelCallResult =
      failure === null && response !== null && descriptor !== null
        ? Object.freeze({
            status: "succeeded",
            modelId: descriptor.id,
            providerId: descriptor.providerId,
            response: stampedResponse(response, descriptor),
            ...base,
          })
        : Object.freeze({
            status: "failed",
            modelId: descriptor?.id ?? null,
            providerId: descriptor?.providerId ?? null,
            failure:
              failure ??
              this.#refusal(
                state.executionId,
                "unknown",
                "execution_failed",
                "the call did not produce a response",
              ),
            ...base,
          });

    this.#decorateSpan(state, result);
    return result;
  }

  /**
   * Commits what was measured, or releases the hold when nothing was.
   *
   * The commit covers the whole call, including tokens a failed provider really did generate, priced
   * at the model that answered. Charging only the successful attempt would let a retry loop spend
   * against a budget without the ledger ever seeing it.
   */
  #settle(state: CallState, descriptor: ModelDescriptor | null): string | null {
    const reservation = state.reservation;
    if (reservation === null || this.#budgetEngine === null) {
      return reservation?.state ?? null;
    }
    if (reservation.state !== "held") {
      return reservation.state;
    }
    try {
      const actual = descriptor === null ? [] : holdsForUsage(descriptor, state.usage);
      const settled =
        actual.length === 0
          ? this.#budgetEngine.release(reservation.id)
          : this.#budgetEngine.commit(reservation.id, actual);
      state.reservation = settled;
      return settled.state;
    } catch {
      // Settlement is bookkeeping: a ledger that refuses to write must not erase the response the
      // caller already has. The hold stays as it was and the result reports that state.
      return reservation.state;
    }
  }

  #observeHealth(providerId: ProviderId, failureClass: string | null, latencyMs: number): void {
    const observedAt = toIso(this.#clock());
    if (failureClass === null) {
      this.#providerRegistry.recordSuccess(
        providerId,
        Math.max(0, Math.trunc(latencyMs)),
        observedAt,
      );
      return;
    }
    this.#providerRegistry.recordFailure(providerId, failureClass, observedAt);
  }

  #policyIdsFor(call: ModelCallRequest): readonly PolicyId[] {
    const resolved: PolicyId[] = [];
    const seen = new Set<string>();
    for (const candidate of [...(call.policyIds ?? []), ...this.#defaultPolicyIds]) {
      const policyId = this.#resolvePolicyId(candidate);
      if (policyId === null || seen.has(policyId)) {
        continue;
      }
      seen.add(policyId);
      resolved.push(policyId);
    }
    return Object.freeze(resolved);
  }

  /** Accepts an identifier or a registered name, because a caller may hold either. */
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

  #stoppedBefore(state: CallState, scope: ExecutionScope): ExecutionFailure | null {
    if (scope.cancelled) {
      return cancellationFailure(scope, state.executionId);
    }
    if (scope.isExpired()) {
      return deadlineFailure(scope, state.executionId);
    }
    return null;
  }

  #skippedAttempt(descriptor: ModelDescriptor, depth: number, reason: string): ProviderAttempt {
    const at = toIso(this.#clock());
    return providerAttempt({
      providerId: descriptor.providerId,
      modelId: descriptor.id,
      fallbackDepth: depth,
      attempt: 1,
      status: "skipped",
      startedAt: at,
      finishedAt: at,
      latencyMs: 0,
      streamed: false,
      usage: EMPTY_USAGE,
      failure: createExecutionFailure({
        class: "non_retryable",
        code: "provider_failure",
        message: reason,
        retryable: false,
        attempt: 1,
        modelId: descriptor.id,
        providerId: descriptor.providerId,
        occurredAt: at,
      }),
    });
  }

  #refusal(
    executionId: ExecutionId,
    failureClass:
      | "policy_blocked"
      | "budget_blocked"
      | "cancelled"
      | "provider_failure"
      | "retryable"
      | "non_retryable"
      | "unknown"
      | "deadline_exceeded"
      | "validation",
    code: "policy_violation" | "conflict" | "provider_failure" | "execution_failed" | "timeout",
    message: string,
    details: Record<string, JsonValue> = {},
  ): ExecutionFailure {
    return createExecutionFailure({
      class: failureClass,
      code,
      message,
      retryable: failureClass === "retryable",
      attempt: 1,
      executionId,
      details,
      occurredAt: toIso(this.#clock()),
    });
  }

  #failureFrom(error: unknown, state: CallState): ExecutionFailure {
    return failureFromError(error, { executionId: state.executionId, attempt: 1 });
  }

  async #wait(
    scope: ExecutionScope,
    delayMs: number,
  ): Promise<"completed" | "cancelled" | "expired"> {
    if (scope.cancelled) {
      return "cancelled";
    }
    if (scope.isExpired()) {
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
      const timer = setTimeout(() => finish(scope.isExpired() ? "expired" : "completed"), delayMs);
      const unsubscribe = scope.context.cancellation.onCancelled(() => finish("cancelled"));
    });
  }

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  #startSpan(state: CallState, call: ModelCallRequest): Span {
    const parent = spanParentOf(state.context);
    return this.#tracer.startSpan(parseTrimmedString(`model.call ${call.model.kind}`), {
      kind: "client",
      // Nested under whatever opened this call: a model call inside an execution is part of
      // that execution's trace, and a root span here would start a second story for one run.
      ...(parent === undefined ? {} : { parent }),
      attributes: {
        ...contextTelemetryAttributes(state.context),
        ...aiSpanAttributes({
          executionId: state.executionId,
          modelSlug: call.model.kind === "slug" ? call.model.slug : null,
          modelKind: call.model.kind,
          streamed: call.streaming === true,
          attempt: 1,
          fallbackDepth: 0,
        }),
      },
    });
  }

  #decorateSpan(state: CallState, result: ModelCallResult): void {
    const span = state.span;
    if (span === null) {
      return;
    }
    span.setAttributes(
      aiSpanAttributes({
        executionStatus: result.status,
        status: result.status,
        modelId: result.modelId,
        providerId: result.providerId,
        policyId: result.policyId,
        policyOutcome: result.policyOutcome,
        budgetId: result.budgetId,
        reservationId: state.reservation?.id ?? null,
        durationMs: result.latencyMs,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        requests: result.usage.requests,
        costMicroUsd: result.usage.costMicro,
        fallbackDepth: result.fallbacks,
        streamed: result.status === "succeeded" ? result.response.streamed : false,
        failureClass: result.status === "failed" ? result.failure.class : null,
        failureCode: result.status === "failed" ? result.failure.code : null,
        retryable: result.status === "failed" ? result.failure.retryable : null,
        cancelled: result.status === "failed" && result.failure.class === "cancelled",
        timedOut: result.status === "failed" && result.failure.class === "deadline_exceeded",
      }),
    );
    if (result.status === "succeeded") {
      span.setStatus("ok");
      return;
    }
    span.setStatus("error", describeFailure(result.failure));
  }

  #endSpan(state: CallState): void {
    if (state.span !== null && !state.span.ended) {
      state.span.end();
    }
  }
}

/** Builds a model orchestrator. */
export function createModelOrchestrator(options: ModelOrchestratorOptions): ModelOrchestrator {
  return new InMemoryModelOrchestrator(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Names the validated request as the published type.
 *
 * The schema is the check and {@link ModelCallRequest} is the shape: the two agree field by field,
 * and the complex ones (messages, tools, parameters) are validated by structural guards rather than
 * by a second copy of the type that could drift.
 */
function validatedCall(value: unknown): ModelCallRequest {
  return value as ModelCallRequest;
}

/**
 * Applies policy's ceiling on generated tokens to the parameters a provider is sent.
 *
 * A clamp rather than a refusal: the call can still be served, within the limit policy set, and
 * refusing outright would turn a guardrail into an outage.
 */
function boundedParameters(
  parameters: ModelParameters,
  policyMaxOutputTokens: number | null,
): ModelParameters {
  if (policyMaxOutputTokens === null) {
    return parameters;
  }
  const requested = parameters.maxOutputTokens;
  const bounded =
    requested === null ? policyMaxOutputTokens : Math.min(requested, policyMaxOutputTokens);
  if (bounded === requested) {
    return parameters;
  }
  return modelParameters({ ...parameters, maxOutputTokens: Math.max(0, bounded) });
}

/** How many times one provider may be tried: the caller's limit, the contract's, and policy's. */
function attemptLimit(call: ModelCallRequest, state: CallState): number {
  return Math.max(
    1,
    Math.min(
      call.maxAttemptsPerProvider ?? DEFAULT_MAX_PROVIDER_ATTEMPTS,
      MAX_PROVIDER_ATTEMPTS,
      state.maxRetries === null ? MAX_PROVIDER_ATTEMPTS : state.maxRetries + 1,
    ),
  );
}

/** What policy says about which providers this call may use. */
function providerAllowed(state: CallState, providerId: ProviderId): boolean {
  if (state.deniedProviders.includes(providerId)) {
    return false;
  }
  return state.allowedProviders.length === 0 || state.allowedProviders.includes(providerId);
}

/** The estimated cost of a call in integer micro-USD, or null when the model is unpriced. */
function estimatedCostMicro(descriptor: ModelDescriptor, call: ModelCallRequest): number | null {
  const parameters = modelParameters(call.parameters);
  return estimateTotalMicro(
    estimateCallCost(descriptor.pricing, {
      inputTokens: estimateInputTokens(call.messages),
      outputTokens: Math.max(0, parameters.maxOutputTokens ?? descriptor.maxOutputTokens),
      requests: 1,
    }),
  );
}

/** One resolved candidate, as the explainability surface reports it. */
function candidateOf(descriptor: ModelDescriptor): ModelCandidate {
  return Object.freeze({
    candidate: null,
    modelId: descriptor.id,
    providerId: descriptor.providerId,
    slug: descriptor.slug,
    priority: descriptor.priority,
  });
}

/**
 * Names the model and provider that actually answered on the response.
 *
 * An adapter translates a vendor payload; it is not the authority on which descriptor served the
 * call, and a caller comparing `response.modelId` with the descriptor it asked for should not have
 * to know that.
 */
function stampedResponse(response: ModelResponse, descriptor: ModelDescriptor): ModelResponse {
  if (response.modelId === descriptor.id && response.providerId === descriptor.providerId) {
    return response;
  }
  return Object.freeze({ ...response, modelId: descriptor.id, providerId: descriptor.providerId });
}

/** The failure reported when no candidate answered. */
function noProviderAvailableFailure(reference: ModelReference, tried: number): ExecutionFailure {
  const error = noProviderAvailable(
    reference,
    tried,
    tried === 0 ? "no candidate matched" : "every candidate failed",
  );
  return failureFromError(error, { attempt: 1 });
}

/** The failure for a cancelled scope. */
function cancellationFailure(scope: ExecutionScope, executionId: ExecutionId): ExecutionFailure {
  return createExecutionFailure({
    class: "cancelled",
    code: "execution_failed",
    message: `model call cancelled: ${scope.cancellationReason ?? "no reason recorded"}`,
    retryable: false,
    attempt: 1,
    executionId,
    occurredAt: toIso(scope.now()),
  });
}

/** The failure for an expired deadline. */
function deadlineFailure(scope: ExecutionScope, executionId: ExecutionId): ExecutionFailure {
  return createExecutionFailure({
    class: "deadline_exceeded",
    code: "timeout",
    message: `model call deadline of ${String(scope.context.deadline?.durationMs ?? 0)}ms exceeded`,
    retryable: false,
    attempt: 1,
    executionId,
    occurredAt: toIso(scope.now()),
  });
}

/** A `failed` stream event carrying a classified failure. */
function failedEvent(failure: ExecutionFailure): ModelStreamEvent {
  return Object.freeze({
    type: "failed",
    errorCode: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  });
}

/** The events a non-streaming response is reported as. */
function* synthesizedStream(
  descriptor: ModelDescriptor,
  response: ModelResponse,
): Generator<ModelStreamEvent> {
  yield Object.freeze({
    type: "started",
    modelId: descriptor.id,
    providerId: descriptor.providerId,
  });
  for (const part of response.message.content) {
    if (part.type === "text") {
      yield Object.freeze({ type: "delta", text: part.text });
    }
  }
  yield Object.freeze({ type: "usage", usage: response.usage });
  yield Object.freeze({
    type: "completed",
    stopReason: response.stopReason,
    latencyMs: response.latencyMs,
  });
}

/** The response a completed stream is reported as. */
function streamResponse(
  descriptor: ModelDescriptor,
  text: string,
  usage: UsageSummary,
  stopReason: StopReason,
  latencyMs: number,
  servedAt: string,
): ModelResponse {
  return Object.freeze({
    modelId: descriptor.id,
    providerId: descriptor.providerId,
    message: textMessage("assistant", text),
    stopReason,
    usage,
    latencyMs,
    streamed: true,
    providerDetails: null,
    servedAt,
  });
}
