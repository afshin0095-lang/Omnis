/**
 * `@omnis/provider-registry` — which providers exist, how healthy they are, and in what
 * order to try them.
 *
 * Public surface:
 * - {@link ProviderRegistry} and {@link InMemoryProviderRegistry}: identity, lifecycle and
 *   health.
 * - {@link ProviderHealth} reducers: pure functions over observed outcomes.
 * - {@link ProviderSelection}: pure scoring and ranking, exported so the orchestrator can
 *   explain a decision without re-implementing it.
 * - {@link assertProviderAdapter}: the registration-time verification every adapter goes
 *   through.
 * - Validation schemas and error factories.
 *
 * Not exported: the registration record shape and the deep-freeze and metadata helpers,
 * which are how the registry keeps its own invariants.
 */

export { createProviderRegistry, InMemoryProviderRegistry } from "./InMemoryProviderRegistry.js";

export {
  isLegalProviderStatusTransition,
  PROVIDER_STATUS_TRANSITIONS,
} from "./ProviderRegistry.js";
export type { ProviderRegistry, ProviderRegistryOptions } from "./ProviderRegistry.js";

export {
  adapterSupportsAll,
  assertProviderAdapter,
  describeAdapter,
  isProviderAdapter,
} from "./ProviderAdapter.js";
export type { ProviderAdapter } from "./ProviderAdapter.js";

export {
  applyHealthObservation,
  assertProviderHealthOptions,
  DEFAULT_PROVIDER_HEALTH_OPTIONS,
  describeHealth,
  isHealthBlocking,
  isSelectableHealthState,
  movingAverage,
  unknownHealth,
} from "./ProviderHealth.js";
export type { ProviderHealthOptions } from "./ProviderHealth.js";

export {
  explainExclusions,
  scoreProvider,
  selectProviders,
  SELECTION_WEIGHTS,
} from "./ProviderSelection.js";
export type {
  ProviderSelectionOutcome,
  ProviderSelectionRequest,
  SelectableProvider,
} from "./ProviderSelection.js";

export {
  adapterProviderMismatch,
  duplicateProviderId,
  duplicateProviderSlug,
  invalidProviderAdapter,
  invalidProviderRegistration,
  invalidProviderStatusTransition,
  noProviderForCapability,
  noProviderForModel,
  operationNotSupported,
  providerNotRegistered,
  providerNotSelectable,
  providerRegistryCapacityExceeded,
} from "./errors.js";

export {
  isProviderSlug,
  providerCapabilitiesSchema,
  PROVIDER_DESCRIPTOR_CONTRACT,
  providerDescriptorSchema,
  PROVIDER_REGISTRATION_CONTRACT,
  providerRateLimitSchema,
  providerReferenceSchema,
  providerRegistrationInputSchema,
  providerSlugSchema,
  providerStatusSchema,
  transportKindSchema,
} from "./providerValidation.js";
export type { ProviderRegistrationInput } from "./providerValidation.js";
export { SLUG_PATTERN } from "./slugPattern.js";
