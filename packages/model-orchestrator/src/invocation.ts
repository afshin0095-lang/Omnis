/**
 * The provider boundary: what to send, how to bound it, and what came back.
 *
 * Everything in this file is pure. It turns a call and a model descriptor into the exact
 * {@link ModelRequest} an adapter receives, turns the execution scope into the
 * {@link ProviderInvocationContext} that tells an adapter how long it has and whether to stop, and
 * normalizes whatever an adapter returns into either a response or a classified failure.
 *
 * Two rules the rest of the orchestrator relies on:
 *
 * 1. **An adapter never has to consult a registry.** `providerModelName` is on the request, so a
 *    vendor implementation is a translation and nothing else.
 * 2. **An adapter's failure is already classified, or it becomes one here.** A throw is caught and
 *    classified by {@link failureFromError}; a `status: "failed"` result is passed through. Either
 *    way the retry and fallback decisions read one shape.
 */

import { modelCallHolds } from "@omnis/budget-engine";
import { toIso } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import {
  EMPTY_USAGE,
  createExecutionFailure,
  failureFromError,
  isRetryableFailureClass,
} from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  BudgetHold,
  ExecutionFailure,
  ExecutionId,
  ModelCapability,
  ModelDescriptor,
  ModelParameters,
  ModelRequest,
  ModelToolSpec,
  ProviderInvocationContext,
  ProviderInvocationResult,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { Message } from "@omnis/ai-core-types";
import { MAX_INVOCATION_RETRY_DELAY_MS } from "./ModelCall.js";
import type { ModelCallRequest } from "./ModelCall.js";

/** Characters per token used to estimate a hold before the call. Coarse, deterministic, documented. */
export const CHARACTERS_PER_ESTIMATED_TOKEN = 4;

/** The capabilities a call implies, before any the caller adds. */
export function impliedCapabilities(
  call: ModelCallRequest,
  parameters: ModelParameters,
): readonly ModelCapability[] {
  const capabilities: ModelCapability[] = ["chat"];
  if (call.streaming === true) {
    capabilities.push("streaming");
  }
  if ((call.tools ?? []).length > 0) {
    capabilities.push("tool_calling");
  }
  const format = parameters.responseFormat;
  if (format !== null && (format.type === "json_object" || format.type === "json_schema")) {
    capabilities.push("structured_output");
  }
  for (const capability of call.requiredCapabilities ?? []) {
    if (!capabilities.includes(capability)) {
      capabilities.push(capability);
    }
  }
  return Object.freeze(capabilities);
}

/**
 * Estimates the prompt tokens a conversation will cost.
 *
 * An estimate, and labelled as one everywhere it is used: it exists to hold budget *before* the
 * call, and the hold is settled against measured usage afterwards. The alternative — holding
 * nothing — would let a large prompt overspend a budget before any accounting noticed.
 */
export function estimateInputTokens(messages: readonly Message[]): number {
  let characters = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "text") {
        characters += part.text.length;
      } else if (part.type === "reasoning") {
        characters += part.text.length;
      }
    }
  }
  return Math.ceil(characters / CHARACTERS_PER_ESTIMATED_TOKEN);
}

/** The holds to reserve before a call: measured against the same formula the settlement uses. */
export function holdsForCall(
  descriptor: ModelDescriptor,
  parameters: ModelParameters,
  messages: readonly Message[],
): readonly BudgetHold[] {
  const inputTokens = estimateInputTokens(messages);
  const outputTokens = parameters.maxOutputTokens ?? descriptor.maxOutputTokens;
  return modelCallHolds(descriptor.pricing, {
    inputTokens,
    outputTokens: Math.max(0, outputTokens),
    requests: 1,
  });
}

/** The holds to commit after a call, from measured usage. */
export function holdsForUsage(
  descriptor: ModelDescriptor,
  usage: UsageSummary,
): readonly BudgetHold[] {
  return modelCallHolds(descriptor.pricing, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    requests: usage.requests,
  });
}

/** The request an adapter receives. */
export function buildModelRequest(
  descriptor: ModelDescriptor,
  call: ModelCallRequest,
  parameters: ModelParameters,
  streaming: boolean,
): ModelRequest {
  return Object.freeze({
    modelId: descriptor.id,
    providerId: descriptor.providerId,
    providerModelName: descriptor.providerModelName,
    messages: Object.freeze([...call.messages]),
    tools: Object.freeze([...(call.tools ?? [])]),
    parameters,
    streaming,
    metadata: Object.freeze({ ...(call.metadata ?? {}) }),
  });
}

/** What an adapter is told about the call it is making. */
export function invocationContext(input: {
  readonly context: ExecutionContext;
  readonly descriptor: ModelDescriptor;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly streaming: boolean;
  readonly remainingMs: () => number | null;
  readonly metadata?: AiCoreMetadata;
}): ProviderInvocationContext {
  const { context, descriptor } = input;
  return Object.freeze({
    modelId: descriptor.id,
    providerId: descriptor.providerId,
    attempt: input.attempt,
    timeoutMs: input.timeoutMs,
    streaming: input.streaming,
    isCancelled: () => context.cancellation.cancelled,
    remainingMs: input.remainingMs,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

/** The tightest of the caller's timeout, policy's limit and what is left on the deadline. */
export function invocationTimeoutMs(input: {
  readonly requested: number | null;
  readonly policyLimit: number | null;
  readonly remainingMs: number | null;
  readonly fallback: number;
}): number {
  const candidates: number[] = [];
  if (input.requested !== null && Number.isFinite(input.requested) && input.requested > 0) {
    candidates.push(input.requested);
  }
  if (input.policyLimit !== null && Number.isFinite(input.policyLimit) && input.policyLimit > 0) {
    candidates.push(input.policyLimit);
  }
  if (input.remainingMs !== null && Number.isFinite(input.remainingMs) && input.remainingMs > 0) {
    candidates.push(input.remainingMs);
  }
  if (candidates.length === 0) {
    return input.fallback;
  }
  return Math.max(1, Math.trunc(Math.min(...candidates)));
}

/**
 * Normalizes whatever an adapter produced.
 *
 * An adapter that throws is not a special case: the throw is classified here, so the retry and
 * fallback decisions read one shape no matter how the provider failed. An adapter that returns
 * something outside {@link ProviderInvocationResult} is a contract violation and is reported as one,
 * because silently treating it as a failure would hide a broken adapter behind a retry loop.
 */
export function normalizeInvocationResult(
  value: unknown,
  input: {
    readonly executionId: ExecutionId;
    readonly descriptor: ModelDescriptor;
    readonly attempt: number;
    readonly startedAtMs: number;
    readonly clock: () => number;
  },
): ProviderInvocationResult {
  const latencyMs = Math.max(0, input.clock() - input.startedAtMs);
  // A broken adapter is a fact about this provider, not about the request: retrying the same
  // endpoint would fail the same way, but another provider may well answer.
  const brokenAdapter = (message: string): ProviderInvocationResult => ({
    status: "failed",
    failure: createExecutionFailure({
      class: "provider_failure",
      code: "provider_failure",
      message,
      retryable: false,
      attempt: input.attempt,
      executionId: input.executionId,
      modelId: input.descriptor.id,
      providerId: input.descriptor.providerId,
      occurredAt: toIso(input.clock()),
    }),
    usage: EMPTY_USAGE,
    latencyMs,
  });

  if (value === null || typeof value !== "object") {
    return brokenAdapter(`adapter for provider ${input.descriptor.providerId} returned no result`);
  }
  const result = value as ProviderInvocationResult;
  if (result.status === "completed" && result.response !== undefined && result.response !== null) {
    return result;
  }
  if (result.status === "failed" && result.failure !== undefined && result.failure !== null) {
    return {
      status: "failed",
      failure: result.failure,
      usage: result.usage ?? EMPTY_USAGE,
      latencyMs: result.latencyMs ?? latencyMs,
    };
  }
  return brokenAdapter(
    `adapter for provider ${input.descriptor.providerId} returned an unrecognized result`,
  );
}

/**
 * Classifies a throw from an adapter into a failure the retry logic can read.
 *
 * A bare `Error` from a provider classifies as `unknown` everywhere else in the platform, which is
 * right when the throw could have come from anywhere. Here it cannot: the only code between the
 * orchestrator and the throw is the adapter, so it is reported as a provider failure — not worth
 * repeating against the same endpoint, and worth trying another one.
 */
export function failureFromAdapter(
  error: unknown,
  input: {
    readonly executionId: ExecutionId;
    readonly descriptor: ModelDescriptor;
    readonly attempt: number;
  },
): ExecutionFailure {
  const failure = failureFromError(error, {
    executionId: input.executionId,
    modelId: input.descriptor.id,
    providerId: input.descriptor.providerId,
    attempt: input.attempt,
  });
  if (failure.class !== "unknown") {
    return failure;
  }
  return createExecutionFailure({ ...failure, class: "provider_failure", retryable: false });
}

/**
 * True when the same provider is worth trying again.
 *
 * Only a failure the classifier calls retryable, in a class that describes the provider rather than
 * the request. A validation failure, a policy refusal, a budget refusal and a cancellation are all
 * facts about *this* call: repeating it against the same endpoint spends budget to reach the same
 * answer.
 */
export function isProviderRetryable(failure: ExecutionFailure): boolean {
  if (!failure.retryable || !isRetryableFailureClass(failure.class)) {
    return false;
  }
  return failure.class === "retryable" || failure.class === "provider_failure";
}

/**
 * True when another provider is worth trying after this one failed.
 *
 * Wider than {@link isProviderRetryable}: a provider that timed out is not going to answer faster on
 * a second attempt, but a different provider might answer at all. Still narrower than "anything":
 * a policy refusal, a budget refusal, a cancellation and a validation failure are properties of the
 * call, and trying another provider would be an attempt to route around governance.
 */
export function shouldTryNextProvider(failure: ExecutionFailure): boolean {
  if (
    failure.class === "cancelled" ||
    failure.class === "policy_blocked" ||
    failure.class === "budget_blocked" ||
    failure.class === "validation"
  ) {
    return false;
  }
  return (
    failure.class === "retryable" ||
    failure.class === "provider_failure" ||
    failure.class === "deadline_exceeded"
  );
}

/** How long to wait before the next attempt at the same provider. Fixed, bounded, deterministic. */
export function invocationDelayMs(
  failure: ExecutionFailure | null,
  fallbackMs: number,
  maximumMs: number = MAX_INVOCATION_RETRY_DELAY_MS,
): number {
  const requested = failure?.retryAfterMs ?? fallbackMs;
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(requested), Math.max(0, Math.trunc(maximumMs)));
}

/** A short, log-safe rendering of the target of a call. */
export function describeCallTarget(descriptor: ModelDescriptor): string {
  return `${descriptor.providerId}/${descriptor.slug}`;
}

/** The tool specs a call carries, frozen. */
export function toolsOf(call: ModelCallRequest): readonly ModelToolSpec[] {
  return Object.freeze([...(call.tools ?? [])]);
}
