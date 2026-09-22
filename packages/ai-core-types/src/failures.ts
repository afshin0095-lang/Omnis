/**
 * Failure classification and typed AI Core errors.
 *
 * WHY classification is a first-class contract
 * -------------------------------------------
 * "Should this be retried?" is the single most consequential question in an execution
 * pipeline, and answering it by inspecting an error *message* is how systems retry
 * non-idempotent writes, hammer a provider that rate-limited them, and re-run work a
 * policy deliberately denied. {@link FailureClass} makes the answer a value: retry,
 * fallback, abort and alert all branch on the class, never on a string.
 *
 * WHY these are factories and not new error classes
 * -------------------------------------------------
 * `@omnis/errors` already owns the thirteen-class OMNIS hierarchy and the closed set
 * of error codes, and the platform's serialization, redaction and HTTP mapping are
 * written against it. A parallel AI Core hierarchy would fork all of that. So AI Core
 * failures are the *existing* classes, carrying an AI Core `FailureClass` in metadata
 * and a structured {@link ExecutionFailure} record for audit. Cancellation has no
 * code of its own in the platform set; it is an `execution_failed` error whose class
 * is `cancelled`, which keeps the wire contract unchanged while still being
 * distinguishable to the kernel.
 */

import type { JsonObject } from "@omnis/types";
import { nowIso } from "@omnis/types";
import {
  ConflictError,
  ContractError,
  ExecutionError,
  NotFoundError,
  isOmnisError,
  PolicyViolationError,
  ProviderError,
  TimeoutError,
  ValidationError,
  type OmnisErrorCode,
} from "@omnis/errors";
import type { AiCoreMetadata } from "./constants.js";
import type {
  BudgetId,
  ExecutionId,
  ModelId,
  PolicyId,
  ProviderId,
  ToolId,
} from "./identifiers.js";
import { assertJsonSafe } from "./json.js";
import { describeModelReference, type ModelReference } from "./model.js";

/**
 * The closed set of failure classes.
 *
 * Each class names a *recovery strategy*, not a cause: `policy_blocked` means "do not
 * retry, do not fall back, tell a human", while `provider_failure` means "another
 * provider may succeed".
 */
export const FAILURE_CLASSES = [
  "retryable",
  "non_retryable",
  "policy_blocked",
  "budget_blocked",
  "validation",
  "cancelled",
  "deadline_exceeded",
  "provider_failure",
  "tool_failure",
  "unknown",
] as const;

/** One failure class. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Default retryability per class. An explicit `retryable` on a failure always wins. */
const RETRYABLE_BY_CLASS: Readonly<Record<FailureClass, boolean>> = Object.freeze({
  retryable: true,
  // A provider failure is retryable *elsewhere*: the orchestrator may fall back to
  // another provider, which is a different action from retrying the same one.
  provider_failure: true,
  non_retryable: false,
  policy_blocked: false,
  budget_blocked: false,
  validation: false,
  cancelled: false,
  deadline_exceeded: false,
  // A tool may already have produced its side effect; retryability is decided by the
  // Tool Runtime from the descriptor's side-effect classification and passed in.
  tool_failure: false,
  unknown: false,
});

/**
 * A policy identifier: either a branded {@link PolicyId} or the name of a built-in
 * policy set. Built-in policies are addressable by name so a caller can request the
 * default policy without first minting an identifier.
 */
export type PolicyIdLike = PolicyId | string;

/** True when a failure of this class may be retried or fallen back from by default. */
export function isRetryableFailureClass(failureClass: FailureClass): boolean {
  return RETRYABLE_BY_CLASS[failureClass];
}

/** True when the class means governance stopped the work, as opposed to a fault. */
export function isGovernanceFailureClass(failureClass: FailureClass): boolean {
  return failureClass === "policy_blocked" || failureClass === "budget_blocked";
}

/** True when the class means the caller stopped the work. */
export function isTerminalIntentFailureClass(failureClass: FailureClass): boolean {
  return failureClass === "cancelled" || failureClass === "deadline_exceeded";
}

/** An immutable failure record, safe to store, serialize and send to a model. */
export interface ExecutionFailure {
  readonly class: FailureClass;
  readonly code: OmnisErrorCode;
  /** Redacted human-readable explanation. Never a stack trace, never a secret. */
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  /** 1-based attempt number during which the failure occurred. */
  readonly attempt: number;
  readonly stepId: string | null;
  readonly executionId: ExecutionId | null;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly toolId: ToolId | null;
  /** Structured, JSON-safe diagnostics. */
  readonly details: AiCoreMetadata;
  readonly occurredAt: string;
}

/** Input for {@link createExecutionFailure}. */
export interface ExecutionFailureInput {
  readonly class: FailureClass;
  readonly code: OmnisErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | null;
  readonly attempt?: number;
  readonly stepId?: string | null;
  readonly executionId?: ExecutionId | null;
  readonly modelId?: ModelId | null;
  readonly providerId?: ProviderId | null;
  readonly toolId?: ToolId | null;
  readonly details?: Readonly<JsonObject>;
  readonly occurredAt?: string;
}

/**
 * Builds an immutable failure record.
 *
 * Asserts the details bag is JSON-safe: failures are stored in audit rows and emitted
 * in events, and a details object carrying a function or `undefined` member would
 * silently serialize into a different record than the one that was classified.
 */
export function createExecutionFailure(input: ExecutionFailureInput): ExecutionFailure {
  const details = input.details ?? {};
  assertJsonSafe(details, "execution failure details");
  return Object.freeze({
    class: input.class,
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? RETRYABLE_BY_CLASS[input.class],
    retryAfterMs: input.retryAfterMs ?? null,
    attempt: input.attempt ?? 1,
    stepId: input.stepId ?? null,
    executionId: input.executionId ?? null,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    toolId: input.toolId ?? null,
    details: Object.freeze({ ...details }),
    occurredAt: input.occurredAt ?? nowIso(),
  });
}

/**
 * Classifies an unknown thrown value.
 *
 * Accepts `unknown` because that is what a `catch` block yields, and because an
 * adapter may reject with a vendor error the AI Core has never seen. Unrecognized
 * values classify as `unknown`, which is *not* retryable: guessing "probably
 * transient" for an error nobody understands is how a system retries forever.
 */
export function classifyError(error: unknown): FailureClass {
  if (!isOmnisError(error)) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return error.name === "AbortError" ? "cancelled" : "deadline_exceeded";
    }
    return "unknown";
  }

  const metadata = error.metadata;
  // Explicit AI Core markers win over the code, because they describe an intent the
  // generic code cannot: an `execution_failed` error can be a cancellation.
  if (metadata["omnis.failure.class"] === "cancelled" || metadata["omnis.cancelled"] === true) {
    return "cancelled";
  }
  if (
    metadata["omnis.failure.class"] === "budget_blocked" ||
    metadata["omnis.budget.blocked"] === true
  ) {
    return "budget_blocked";
  }
  if (typeof metadata["omnis.failure.class"] === "string") {
    const declared = metadata["omnis.failure.class"];
    if ((FAILURE_CLASSES as readonly string[]).includes(declared)) {
      return declared as FailureClass;
    }
  }

  const declared = CLASS_BY_ERROR_CODE[error.code];
  // Codes whose class depends on the error's own retryability hint: a retryable
  // infrastructure failure is worth another attempt, a non-retryable one is not.
  if (declared === "retryable") {
    return error.retryable ? "retryable" : "non_retryable";
  }
  return declared;
}

/**
 * Failure class implied by each platform error code.
 *
 * Declared as a `Record` over the closed {@link OmnisErrorCode} union so that adding
 * a code to `@omnis/errors` is a compile error here until it has been classified —
 * an unclassified code silently becoming `unknown` would disable retry for a whole
 * failure mode.
 */
const CLASS_BY_ERROR_CODE: Readonly<Record<OmnisErrorCode, FailureClass>> = Object.freeze({
  timeout: "deadline_exceeded",
  policy_violation: "policy_blocked",
  authorization_failed: "policy_blocked",
  authentication_failed: "policy_blocked",
  validation_failed: "validation",
  contract_violation: "validation",
  configuration_invalid: "validation",
  provider_failure: "provider_failure",
  not_found: "non_retryable",
  conflict: "non_retryable",
  not_implemented: "non_retryable",
  infrastructure_failure: "retryable",
  execution_failed: "retryable",
  unknown: "unknown",
});

/** Context attached to a failure derived from a caught error. */
export interface FailureContext {
  readonly attempt?: number;
  readonly stepId?: string | null;
  readonly executionId?: ExecutionId | null;
  readonly modelId?: ModelId | null;
  readonly providerId?: ProviderId | null;
  readonly toolId?: ToolId | null;
}

/** Converts any thrown value into an {@link ExecutionFailure}. */
export function failureFromError(error: unknown, context: FailureContext = {}): ExecutionFailure {
  const failureClass = classifyError(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "execution failed with a non-error value";
  return createExecutionFailure({
    class: failureClass,
    code: isOmnisError(error) ? error.code : "unknown",
    message,
    retryable: isOmnisError(error)
      ? error.retryable && isRetryableFailureClass(failureClass)
      : false,
    retryAfterMs: isOmnisError(error) ? (error.retryAfterMs ?? null) : null,
    attempt: context.attempt,
    stepId: context.stepId ?? null,
    executionId: context.executionId ?? null,
    modelId: context.modelId ?? null,
    providerId: context.providerId ?? null,
    toolId: context.toolId ?? null,
    details: isOmnisError(error) ? error.metadata : {},
  });
}

/** A one-line, secret-safe rendering of a failure for logs and model-visible text. */
export function describeFailure(failure: ExecutionFailure): string {
  return `${failure.class}(${failure.code}): ${failure.message}`;
}

// ---------------------------------------------------------------------------
// Typed factories. Each returns a platform error class carrying the AI Core
// failure class in metadata, so `classifyError` round-trips the intent.
// ---------------------------------------------------------------------------

const FAILURE_CLASS_KEY = "omnis.failure.class";

/** A referenced model is not registered, or is not selectable. */
export function modelNotFoundError(
  reference: ModelReference,
  providerSlug: string | null = null,
): NotFoundError {
  return new NotFoundError("model", describeModelReference(reference), {
    metadata: { modelReference: describeModelReference(reference), providerSlug },
  });
}

/** A referenced provider is not registered. */
export function providerNotFoundError(providerId: ProviderId): NotFoundError {
  return new NotFoundError("provider", providerId);
}

/** A referenced tool is not registered. */
export function toolNotFoundError(toolId: ToolId | string): NotFoundError {
  return new NotFoundError("tool", String(toolId));
}

/** A provider was reachable but could not serve the request. */
export function providerInvocationError(
  providerId: ProviderId,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly cause?: unknown;
    readonly retryAfterMs?: number;
  } = {},
): ProviderError {
  return new ProviderError("ai-core", message, {
    cause: options.cause,
    retryable: options.retryable ?? true,
    retryAfterMs: options.retryAfterMs,
    metadata: { providerId, [FAILURE_CLASS_KEY]: "provider_failure" },
  });
}

/** A provider exists but cannot currently serve work. */
export function providerUnavailableError(providerId: ProviderId, reason: string): ProviderError {
  return new ProviderError("ai-core", `provider is unavailable: ${reason}`, {
    retryable: true,
    metadata: { providerId, reason, [FAILURE_CLASS_KEY]: "provider_failure" },
  });
}

/** No registered provider can serve the resolved model. */
export function noProviderAvailableError(modelId: ModelId, reason: string): ProviderError {
  return new ProviderError("ai-core", `no provider available for model: ${reason}`, {
    retryable: true,
    metadata: { modelId, reason, [FAILURE_CLASS_KEY]: "provider_failure" },
  });
}

/** A policy set denied the execution. */
export function policyDeniedError(
  policyId: PolicyIdLike,
  ruleId: string,
  reason: string,
): PolicyViolationError {
  return new PolicyViolationError(String(policyId), `policy denied execution: ${reason}`, {
    retryable: false,
    metadata: { ruleId, reason, [FAILURE_CLASS_KEY]: "policy_blocked" },
  });
}

/** A policy set requires human approval before the execution may proceed. */
export function approvalRequiredError(
  policyId: PolicyIdLike,
  ruleId: string,
  reason: string,
): PolicyViolationError {
  return new PolicyViolationError(String(policyId), `execution requires approval: ${reason}`, {
    retryable: false,
    metadata: { ruleId, reason, approvalRequired: true, [FAILURE_CLASS_KEY]: "policy_blocked" },
  });
}

/** A permission the caller does not hold was required. */
export function permissionDeniedError(permission: string, resource: string): PolicyViolationError {
  return new PolicyViolationError(
    "tool-permission",
    `missing permission ${permission} for ${resource}`,
    {
      retryable: false,
      metadata: { permission, resource, [FAILURE_CLASS_KEY]: "policy_blocked" },
    },
  );
}

/** A budget limit would be exceeded by the requested work. */
export function budgetExhaustedError(
  budgetId: BudgetId,
  dimension: string,
  requested: number,
  available: number,
): ExecutionError {
  return new ExecutionError(`budget exhausted for dimension ${dimension}`, {
    retryable: false,
    metadata: {
      budgetId,
      dimension,
      requested,
      available,
      "omnis.budget.blocked": true,
      [FAILURE_CLASS_KEY]: "budget_blocked",
    },
  });
}

/** The execution was cancelled by its owner or by a parent scope. */
export function executionCancelledError(executionId: ExecutionId, reason: string): ExecutionError {
  return new ExecutionError(`execution cancelled: ${reason}`, {
    retryable: false,
    metadata: { executionId, reason, "omnis.cancelled": true, [FAILURE_CLASS_KEY]: "cancelled" },
  });
}

/** The execution deadline elapsed before the work completed. */
export function deadlineExceededError(executionId: ExecutionId, deadlineMs: number): TimeoutError {
  return new TimeoutError(`execution deadline of ${deadlineMs}ms exceeded`, {
    retryable: false,
    metadata: { executionId, deadlineMs, [FAILURE_CLASS_KEY]: "deadline_exceeded" },
  });
}

/** A step took longer than its own timeout. */
export function stepTimeoutError(stepId: string, timeoutMs: number): TimeoutError {
  return new TimeoutError(`step ${stepId} exceeded its ${timeoutMs}ms timeout`, {
    retryable: true,
    metadata: { stepId, timeoutMs, [FAILURE_CLASS_KEY]: "deadline_exceeded" },
  });
}

/** A tool invocation failed. Retryability comes from the tool's side-effect class. */
export function toolExecutionError(
  toolId: ToolId,
  message: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): ExecutionError {
  return new ExecutionError(`tool execution failed: ${message}`, {
    cause: options.cause,
    retryable: options.retryable ?? false,
    metadata: { toolId, [FAILURE_CLASS_KEY]: "tool_failure" },
  });
}

/** An agent state transition is not legal from the current state. */
export function illegalAgentTransitionError(
  from: string,
  to: string,
  agentId: string,
): ContractError {
  return new ContractError("agent-state-machine", `illegal agent transition ${from} -> ${to}`, {
    retryable: false,
    metadata: { from, to, agentId, [FAILURE_CLASS_KEY]: "validation" },
  });
}

/** An execution state transition is not legal from the current state. */
export function illegalExecutionTransitionError(
  from: string,
  to: string,
  executionId: ExecutionId,
): ContractError {
  return new ContractError(
    "execution-state-machine",
    `illegal execution transition ${from} -> ${to}`,
    {
      retryable: false,
      metadata: { from, to, executionId, [FAILURE_CLASS_KEY]: "validation" },
    },
  );
}

/** A plan is structurally invalid: unknown dependency, cycle or too many steps. */
export function invalidPlanError(
  reason: string,
  details: Readonly<JsonObject> = {},
): ValidationError {
  assertJsonSafe(details, "invalid plan details");
  return new ValidationError(`invalid execution plan: ${reason}`, {
    retryable: false,
    issues: [{ path: "plan", code: "invalid_plan", message: reason, received: null }],
    metadata: { reason, ...details, [FAILURE_CLASS_KEY]: "validation" },
  });
}

/** A registry rejected a duplicate registration. */
export function duplicateRegistrationError(resourceType: string, key: string): ConflictError {
  return new ConflictError(
    `${resourceType}:${key}`,
    `${resourceType} "${key}" is already registered`,
    {
      retryable: false,
      metadata: { resourceType, key, [FAILURE_CLASS_KEY]: "non_retryable" },
    },
  );
}

/** An adapter or handler violated its contract, e.g. returned a non-normalized value. */
export function adapterContractError(adapter: string, reason: string): ContractError {
  return new ContractError(
    "provider-adapter",
    `provider adapter ${adapter} violated its contract: ${reason}`,
    {
      retryable: false,
      metadata: { adapter, reason, [FAILURE_CLASS_KEY]: "validation" },
    },
  );
}
