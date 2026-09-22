/**
 * The Provider Registry contract.
 *
 * The registry owns three things and nothing else:
 * 1. **Identity** — which providers exist, under which identifier and slug.
 * 2. **Lifecycle** — the state each provider is in, and which transitions are legal.
 * 3. **Health** — the snapshot inferred from observed outcomes, and the selection order
 *    that follows from identity, lifecycle and health together.
 *
 * It does *not* invoke providers, decide policy, spend budget or normalize responses.
 * Those belong to the orchestrator, the policy engine and the budget engine; a registry
 * that also routed traffic would be impossible to test and impossible to replace.
 */

import type {
  ModelCapability,
  ProviderDescriptor,
  ProviderHealth,
  ProviderHealthObservation,
  ProviderId,
  ProviderOperation,
  ProviderReference,
  ProviderStatus,
} from "@omnis/ai-core-types";
import type { ProviderAdapter } from "./ProviderAdapter.js";
import type { ProviderHealthOptions } from "./ProviderHealth.js";
import type { ProviderSelectionRequest, SelectableProvider } from "./ProviderSelection.js";
import type { ProviderRegistrationInput } from "./providerValidation.js";
import type { ProviderCandidate } from "@omnis/ai-core-types";

/** Lifecycle transitions the registry allows. */
export const PROVIDER_STATUS_TRANSITIONS: Readonly<
  Record<ProviderStatus, readonly ProviderStatus[]>
> = Object.freeze({
  registered: Object.freeze(["initializing", "ready", "disabled"] as readonly ProviderStatus[]),
  initializing: Object.freeze([
    "ready",
    "degraded",
    "unavailable",
    "disabled",
  ] as readonly ProviderStatus[]),
  ready: Object.freeze(["degraded", "unavailable", "disabled"] as readonly ProviderStatus[]),
  degraded: Object.freeze(["ready", "unavailable", "disabled"] as readonly ProviderStatus[]),
  // An unavailable provider keeps its descriptor and health history, and may be brought
  // back through initialization rather than re-registration.
  unavailable: Object.freeze([
    "initializing",
    "degraded",
    "ready",
    "disabled",
  ] as readonly ProviderStatus[]),
  // Disabled is reversible only by going back through initialization, so re-enabling a
  // provider always re-verifies its adapter rather than trusting the old state.
  disabled: Object.freeze(["initializing"] as readonly ProviderStatus[]),
});

/** True when a provider may move from `from` to `to`. */
export function isLegalProviderStatusTransition(from: ProviderStatus, to: ProviderStatus): boolean {
  return from === to || PROVIDER_STATUS_TRANSITIONS[from].includes(to);
}

/** How a registry is configured. */
export interface ProviderRegistryOptions {
  /** Source of registration and observation timestamps, as UTC ISO 8601. Injectable for tests. */
  readonly clock?: () => string;
  /** Health reducer tuning. Merged over {@link DEFAULT_PROVIDER_HEALTH_OPTIONS}. */
  readonly health?: Partial<ProviderHealthOptions>;
  /** Maximum number of registered providers. */
  readonly maxEntries?: number;
}

/** The registry's public surface. */
export interface ProviderRegistry {
  /** Number of registered providers. */
  readonly size: number;

  /** The health tuning this registry reduces observations with. */
  readonly healthOptions: ProviderHealthOptions;

  /**
   * Registers a provider together with the adapter that serves it.
   *
   * The adapter is verified at registration (see {@link assertProviderAdapter}), the
   * descriptor is validated, deep-frozen and indexed, and the provider starts in the
   * `registered` state with unknown health.
   */
  register(input: ProviderRegistrationInput, adapter: ProviderAdapter): ProviderDescriptor;

  get(providerId: ProviderId): ProviderDescriptor | null;
  require(providerId: ProviderId): ProviderDescriptor;
  has(providerId: ProviderId): boolean;
  hasSlug(slug: string): boolean;
  getBySlug(slug: string): ProviderDescriptor | null;
  idForSlug(slug: string): ProviderId | null;

  /** Removes a provider and disposes its adapter. Returns false when it was not registered. */
  remove(providerId: ProviderId): boolean;

  /** Every registered provider, in deterministic order. */
  list(): readonly ProviderDescriptor[];

  /** Providers offering one operation, in deterministic order. */
  findByOperation(operation: ProviderOperation): readonly ProviderDescriptor[];

  /** Providers declaring one model capability, in deterministic order. */
  findByCapability(capability: ModelCapability): readonly ProviderDescriptor[];

  /** The adapter registered for a provider, or `null`. */
  adapterFor(providerId: ProviderId): ProviderAdapter | null;

  /** The adapter for a provider, throwing when the provider is not registered. */
  requireAdapter(providerId: ProviderId): ProviderAdapter;

  /** The current health snapshot for a provider, or an unknown snapshot when unregistered. */
  health(providerId: ProviderId): ProviderHealth;

  /** Applies one health observation and returns the new snapshot. */
  recordObservation(providerId: ProviderId, observation: ProviderHealthObservation): ProviderHealth;

  /** Records a successful invocation. */
  recordSuccess(providerId: ProviderId, latencyMs: number, observedAt?: string): ProviderHealth;

  /** Records a failed invocation. */
  recordFailure(providerId: ProviderId, failureClass: string, observedAt?: string): ProviderHealth;

  /** Moves a provider to a new lifecycle state, returning the replacement descriptor. */
  setStatus(providerId: ProviderId, status: ProviderStatus): ProviderDescriptor;

  /** Resolves a reference, or `null` when nothing matches. */
  resolve(reference: ProviderReference): ProviderDescriptor | null;

  /** The providers eligible for a request, with their health and adapter, in registry order. */
  selectable(request?: ProviderSelectionRequest): readonly SelectableProvider[];

  /**
   * The fallback order for a request.
   *
   * Deterministic: the same registry state and the same request always produce the same
   * order, which is what makes an incident reconstructible and a fallback test meaningful.
   */
  select(request?: ProviderSelectionRequest): readonly ProviderCandidate[];
}
