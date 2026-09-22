/**
 * What the orchestrator is asked to do, and what it reports back.
 *
 * Two shapes, both frozen and JSON-safe:
 *
 * - {@link ModelCallRequest} is what a caller supplies. It names a *model reference* — an
 *   identifier, a slug or a capability — and never a provider. Which provider serves the call is
 *   the orchestrator's decision, made from the registries, policy and health; a caller that could
 *   pin the provider would also be able to bypass the fallback that keeps a degraded provider from
 *   taking the platform down.
 * - {@link ModelCallResult} is what comes back. Success carries the normalized response; failure
 *   carries a classified {@link ExecutionFailure} and, either way, every provider attempt that was
 *   made. "Why did this cost three provider calls?" has to be answerable from the result alone.
 */

import { createExecutionId } from "@omnis/types";
import type { AgentId, CorrelationId, ExecutionId, TenantId } from "@omnis/types";
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EMPTY_USAGE,
  MAX_RETRY_ATTEMPTS,
} from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  BudgetId,
  ExecutionFailure,
  Message,
  ModelCapability,
  ModelId,
  ModelParameters,
  ModelReference,
  ModelResponse,
  ModelToolSpec,
  PolicyId,
  PolicyOutcome,
  ProviderId,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { ProviderCandidate } from "@omnis/ai-core-types";

/** How many times one provider may be tried before the orchestrator moves on. */
export const MAX_PROVIDER_ATTEMPTS = MAX_RETRY_ATTEMPTS;
/** The default of that limit. */
export const DEFAULT_MAX_PROVIDER_ATTEMPTS = 2;
/** How many candidate models (and therefore providers) may be tried in total. */
export const DEFAULT_MAX_FALLBACK_PROVIDERS = 3;
/** The per-invocation timeout when nothing else bounds it. */
export const DEFAULT_INVOCATION_TIMEOUT_MS = DEFAULT_EXECUTION_TIMEOUT_MS;
/** Fixed retry delay: no exponential backoff, because a growing delay is only safe when bounded. */
export const DEFAULT_INVOCATION_RETRY_DELAY_MS = 0;
/** The ceiling on any retry delay, however a provider asks for one. */
export const MAX_INVOCATION_RETRY_DELAY_MS = 30_000;

/** An approval, when policy requires one. */
export interface ModelCallApproval {
  readonly approved: boolean;
  readonly approver: string | null;
  readonly approvedAt: string | null;
}

/** One call to the orchestrator. */
export interface ModelCallRequest {
  /** Which model to use. Never a provider. */
  readonly model: ModelReference;
  /** The conversation. At least one message. */
  readonly messages: readonly Message[];
  /** Tools the model may call. Empty for a plain completion. */
  readonly tools?: readonly ModelToolSpec[];
  /** Sampling parameters; missing fields take the published defaults. */
  readonly parameters?: Partial<ModelParameters>;
  /** Ask for a stream. Requires the `streaming` capability. */
  readonly streaming?: boolean;
  /** Reuse an execution identity, e.g. one the kernel already opened. */
  readonly executionId?: ExecutionId | null;
  readonly correlationId?: CorrelationId | null;
  readonly tenantId?: TenantId | null;
  readonly agentId?: AgentId | null;
  /** Policy sets to evaluate, by identifier or registered name. */
  readonly policyIds?: readonly string[];
  readonly budgetId?: BudgetId | null;
  /** Approval, when a policy set requires one. */
  readonly approval?: ModelCallApproval | null;
  /** Whole-call allowance. Bounds every attempt and every fallback together. */
  readonly deadlineMs?: number | null;
  /** Per-invocation allowance. Bounded by the deadline. */
  readonly timeoutMs?: number | null;
  readonly maxAttemptsPerProvider?: number;
  readonly maxProviders?: number;
  /** Capabilities the model must have, beyond the ones the request implies. */
  readonly requiredCapabilities?: readonly ModelCapability[];
  readonly metadata?: AiCoreMetadata;
}

/** One attempt at one provider. */
export interface ProviderAttempt {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  /** 0 for the first candidate, 1 for the first fallback, and so on. */
  readonly fallbackDepth: number;
  /** 1-based attempt number within this provider. */
  readonly attempt: number;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
  readonly streamed: boolean;
  readonly usage: UsageSummary;
  readonly failure: ExecutionFailure | null;
}

/** What a call produced. */
export type ModelCallResult =
  | {
      readonly status: "succeeded";
      readonly executionId: ExecutionId;
      readonly modelId: ModelId;
      readonly providerId: ProviderId;
      readonly response: ModelResponse;
      readonly usage: UsageSummary;
      readonly latencyMs: number;
      readonly attempts: readonly ProviderAttempt[];
      /** How many times the orchestrator moved to another candidate. */
      readonly fallbacks: number;
      readonly policyOutcome: PolicyOutcome | null;
      readonly policyId: PolicyId | null;
      readonly budgetId: BudgetId | null;
      readonly budgetStatus: string | null;
      readonly startedAt: string;
      readonly completedAt: string;
    }
  | {
      readonly status: "failed";
      readonly executionId: ExecutionId;
      readonly modelId: ModelId | null;
      readonly providerId: ProviderId | null;
      readonly failure: ExecutionFailure;
      readonly usage: UsageSummary;
      readonly latencyMs: number;
      readonly attempts: readonly ProviderAttempt[];
      readonly fallbacks: number;
      readonly policyOutcome: PolicyOutcome | null;
      readonly policyId: PolicyId | null;
      readonly budgetId: BudgetId | null;
      readonly budgetStatus: string | null;
      readonly startedAt: string;
      readonly completedAt: string;
    };

/** The parameters a call runs with, defaults filled in. */
export function modelParameters(input: Partial<ModelParameters> = {}): ModelParameters {
  return Object.freeze({
    temperature: input.temperature ?? null,
    topP: input.topP ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    stop: Object.freeze([...(input.stop ?? [])]),
    seed: input.seed ?? null,
    responseFormat: input.responseFormat ?? null,
  });
}

/** One attempt row, with the facts an attempt that did not happen still needs. */
export function providerAttempt(
  input: Partial<ProviderAttempt> & { readonly providerId: ProviderId; readonly modelId: ModelId },
): ProviderAttempt {
  return Object.freeze({
    fallbackDepth: 0,
    attempt: 1,
    status: "failed",
    startedAt: "",
    finishedAt: "",
    latencyMs: 0,
    streamed: false,
    usage: EMPTY_USAGE,
    failure: null,
    ...input,
  });
}

/** A candidate the orchestrator considered, for the explainability surface. */
export interface ModelCandidate {
  readonly candidate: ProviderCandidate | null;
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  readonly slug: string;
  readonly priority: number;
}

/** The identity a call runs under: the caller's, or a fresh one. */
export function callExecutionId(request: ModelCallRequest): ExecutionId {
  return request.executionId ?? createExecutionId();
}
