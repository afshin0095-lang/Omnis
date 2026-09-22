/**
 * Provider contracts — the vendor boundary.
 *
 * This module is the *only* place in OMNIS where "a provider" is a concept, and the
 * {@link ProviderAdapter} interface below is the only thing a vendor integration may
 * implement. Two consequences are deliberate:
 *
 * 1. Nothing above this line can name a vendor. There is no `OpenAIRequest` here, no
 *    SDK type, no vendor error class. An adapter maps its vendor's request, response
 *    and failures into these shapes, and everything upstream — orchestration, policy,
 *    budget, evaluation, events, telemetry — is written once against them.
 * 2. Nothing below this line can reach into OMNIS state. An adapter receives a
 *    resolved {@link ModelRequest} and an invocation context; it cannot consult the
 *    model registry, override a policy decision or spend a budget it was not given.
 *
 * A provider adapter is *untrusted* by construction: its results are normalized, its
 * failures are classified, and its health is inferred from observed outcomes rather
 * than believed from a self-report.
 */

import type { AiCoreMetadata } from "./constants.js";
import type { BudgetId, ModelId, PolicyId, ProviderId } from "./identifiers.js";
import type { ExecutionFailure } from "./failures.js";
import type { LatencyClass, Modality, ModelCapability } from "./model.js";
import type { ModelRequest, ModelResponse, ModelStreamEvent, UsageSummary } from "./messages.js";

/** How an adapter reaches its provider. Recorded for observability, never branched on. */
export const TRANSPORT_KINDS = [
  "http",
  "grpc",
  "websocket",
  "local",
  "in_memory",
  "custom",
] as const;

/** A provider transport. */
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/**
 * Provider lifecycle state.
 *
 * Six states rather than a boolean, because the interesting cases are the middle
 * ones: `initializing` (registered, credentials not yet verified — must not be
 * selected), `degraded` (working, but ranked below healthy providers) and
 * `unavailable` (failing, but recoverable without re-registration, so it keeps its
 * descriptor and health history).
 */
export const PROVIDER_STATUSES = [
  "registered",
  "initializing",
  "ready",
  "degraded",
  "unavailable",
  "disabled",
] as const;

/** A provider's lifecycle state. */
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/** True when a provider in this state may be selected for new work. */
export function isSelectableProviderStatus(status: ProviderStatus): boolean {
  return status === "ready" || status === "degraded";
}

/** True when a provider in this state may still be registered and inspected. */
export function isLiveProviderStatus(status: ProviderStatus): boolean {
  return status !== "disabled";
}

/** Operations a provider can perform. A superset of model capabilities at the endpoint level. */
export const PROVIDER_OPERATIONS = [
  "chat",
  "streaming",
  "embeddings",
  "image",
  "speech",
  "transcription",
  "video",
  "batch",
  "tool_calling",
  "structured_output",
] as const;

/** One provider operation. */
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

/** Declared endpoint capabilities. */
export interface ProviderCapabilities {
  readonly operations: readonly ProviderOperation[];
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  /** Model capabilities the endpoint can honor for *some* model. Per-model truth lives on the descriptor. */
  readonly modelCapabilities: readonly ModelCapability[];
}

/** Declared throughput limits, or `null` where the provider publishes none. */
export interface ProviderRateLimit {
  readonly requestsPerMinute: number | null;
  readonly tokensPerMinute: number | null;
  readonly maxConcurrentRequests: number | null;
}

/** How a caller may name a provider. */
export type ProviderReference =
  | { readonly kind: "id"; readonly providerId: ProviderId }
  | { readonly kind: "slug"; readonly slug: string };

/** Builds a provider reference by identifier. */
export function providerById(providerId: ProviderId): ProviderReference {
  return Object.freeze({ kind: "id", providerId });
}

/** Builds a provider reference by slug. */
export function providerBySlug(slug: string): ProviderReference {
  return Object.freeze({ kind: "slug", slug });
}

/** An immutable registered provider description. */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  /** Stable slug, unique within a registry, e.g. the integration key configs use. */
  readonly slug: string;
  readonly displayName: string;
  readonly transport: TransportKind;
  readonly status: ProviderStatus;
  readonly capabilities: ProviderCapabilities;
  readonly rateLimit: ProviderRateLimit;
  /** Selection preference: lower is preferred. */
  readonly priority: number;
  readonly latencyClass: LatencyClass;
  /** Region or deployment label, used by policy conditions. `null` when irrelevant. */
  readonly region: string | null;
  /** Policy set applied to work routed through this provider, or `null` for the caller's policy. */
  readonly policyId: PolicyId | null;
  /** Budget charged for this provider's work, or `null` when the execution's budget covers it. */
  readonly budgetId: BudgetId | null;
  /**
   * Whether credentials for this provider are configured.
   *
   * A boolean, never the credential: the descriptor is serialized into events,
   * audit rows and API responses, and must be safe to print in all three.
   */
  readonly credentialsConfigured: boolean;
  readonly metadata: AiCoreMetadata;
  readonly registeredAt: string;
}

/** Observed health state, inferred from outcomes. */
export const PROVIDER_HEALTH_STATES = ["healthy", "degraded", "unavailable", "unknown"] as const;

/** An observed health state. */
export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

/** An immutable health snapshot for one provider. */
export interface ProviderHealth {
  readonly providerId: ProviderId;
  readonly state: ProviderHealthState;
  /** Consecutive failures; reset to zero by any success. */
  readonly consecutiveFailures: number;
  /** Consecutive successes; reset to zero by any failure. */
  readonly consecutiveSuccesses: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  /** Failure class of the most recent failure, or `null`. */
  readonly lastFailureClass: string | null;
  /** Exponentially-weighted mean latency in milliseconds, or `null` before the first success. */
  readonly averageLatencyMs: number | null;
  readonly observedAt: string;
}

/** A health observation produced by the registry after an invocation. */
export type ProviderHealthObservation =
  | { readonly kind: "success"; readonly latencyMs: number; readonly observedAt: string }
  | { readonly kind: "failure"; readonly failureClass: string; readonly observedAt: string }
  | { readonly kind: "probe"; readonly state: ProviderHealthState; readonly observedAt: string };

/** A provider's health as never observed. */
export function initialProviderHealth(providerId: ProviderId, observedAt: string): ProviderHealth {
  return Object.freeze({
    providerId,
    state: "unknown",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureClass: null,
    averageLatencyMs: null,
    observedAt,
  });
}

/** What an adapter is told about the invocation it is being asked to perform. */
export interface ProviderInvocationContext {
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  /** 1-based attempt number across retries and fallbacks. */
  readonly attempt: number;
  /** Wall-clock allowance for this invocation in milliseconds. Always finite. */
  readonly timeoutMs: number;
  readonly streaming: boolean;
  /** True once cancellation has been requested; adapters must poll and stop. */
  isCancelled(): boolean;
  /** Milliseconds left on the execution deadline, or `null` when there is none. */
  remainingMs(): number | null;
  readonly metadata: AiCoreMetadata;
}

/** The normalized outcome an adapter must return. */
export type ProviderInvocationResult =
  | {
      readonly status: "completed";
      readonly response: ModelResponse;
      readonly usage: UsageSummary;
      readonly latencyMs: number;
    }
  | {
      readonly status: "failed";
      readonly failure: ExecutionFailure;
      readonly usage: UsageSummary;
      readonly latencyMs: number;
    };

/**
 * The vendor boundary.
 *
 * Implementations live *outside* the AI Core (a future `packages/provider-openai`,
 * `packages/provider-anthropic`, `packages/provider-local`). The AI Core depends on
 * this interface; the adapter depends on the AI Core. Never the reverse, and never
 * both directions at once — that inversion is the whole reason a provider can be
 * added, replaced or removed without touching orchestration.
 */
export interface ProviderAdapter {
  /** The provider this adapter serves. One adapter per registered provider. */
  readonly providerId: ProviderId;
  readonly slug: string;
  /** Invokes the provider once and normalizes the outcome. Must not throw for expected failures. */
  invoke(
    request: ModelRequest,
    context: ProviderInvocationContext,
  ): Promise<ProviderInvocationResult>;
  /**
   * Streams a response, when the provider and model support it.
   *
   * Optional on purpose: `supports("streaming")` is the contract, and the
   * orchestrator falls back to {@link invoke} when a method is absent rather than
   * failing the execution.
   */
  stream?(
    request: ModelRequest,
    context: ProviderInvocationContext,
  ): AsyncIterable<ModelStreamEvent>;
  /** True when this adapter can serve the capability for the given model. */
  supports(capability: ModelCapability, modelId: ModelId): boolean;
  /** Releases adapter-held resources. Called on unregister; must be idempotent. */
  dispose?(): Promise<void> | void;
}

/** A scored provider candidate produced by selection. */
export interface ProviderCandidate {
  readonly descriptor: ProviderDescriptor;
  readonly health: ProviderHealth;
  /** Total selection score. Higher is better. */
  readonly score: number;
  /** Ordered contributions to the score, kept for explainability. */
  readonly reasons: readonly string[];
}

/**
 * Deterministic ordering of provider candidates.
 *
 * Score descending, then `degraded` after `healthy`, then declared priority, then
 * slug as the final total-order tie-break. The last two exist so that two runs over
 * an identical registry produce an identical fallback order — a selection that
 * depends on Map iteration order is a heisenbug that only reproduces in production.
 */
export function compareProviderDescriptors(
  left: ProviderDescriptor,
  right: ProviderDescriptor,
): number {
  const leftDegraded = left.status === "degraded" ? 1 : 0;
  const rightDegraded = right.status === "degraded" ? 1 : 0;
  if (leftDegraded !== rightDegraded) {
    return leftDegraded - rightDegraded;
  }
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  if (left.slug !== right.slug) {
    return left.slug < right.slug ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function compareProviderCandidates(
  left: ProviderCandidate,
  right: ProviderCandidate,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const leftUnwell = left.health.state === "degraded" ? 1 : 0;
  const rightUnwell = right.health.state === "degraded" ? 1 : 0;
  if (leftUnwell !== rightUnwell) {
    return leftUnwell - rightUnwell;
  }
  return compareProviderDescriptors(left.descriptor, right.descriptor);
}
