/**
 * `@omnis/model-registry` — the authority on which models exist.
 *
 * Public surface:
 * - {@link ModelRegistry}: the contract every implementation satisfies.
 * - {@link InMemoryModelRegistry} / {@link createModelRegistry}: the Sprint 1
 *   implementation.
 * - The validation schemas, because a caller assembling descriptors from configuration
 *   needs to validate them before handing them over.
 * - The error factories, so a caller can catch and classify a registry failure without
 *   depending on this package's internals.
 *
 * Not exported: the deep-freeze and metadata-sanitizing helpers, which are how the
 * registry keeps its own invariants and would be a way to bypass them if public.
 */

export { InMemoryModelRegistry, createModelRegistry } from "./InMemoryModelRegistry.js";

export { isLegalModelStatusTransition, MODEL_STATUS_TRANSITIONS } from "./ModelRegistry.js";
export type {
  ModelQuery,
  ModelRegistry,
  ModelRegistryOptions,
  ModelResolution,
} from "./ModelRegistry.js";

export {
  duplicateModelId,
  duplicateModelSlug,
  invalidModelRegistration,
  invalidModelStatusTransition,
  modelNotRegistered,
  modelNotResolvable,
  modelNotSelectable,
  providerHasNoModels,
  registryCapacityExceeded,
} from "./errors.js";

export {
  isModelSlug,
  latencyClassSchema,
  modalitySchema,
  modelCapabilitySchema,
  MODEL_DESCRIPTOR_CONTRACT,
  modelDescriptorSchema,
  modelKindSchema,
  MODEL_REGISTRATION_CONTRACT,
  modelQuerySchema,
  modelReferenceSchema,
  modelRegistrationInputSchema,
  MODEL_SLUG_PATTERN,
  modelSlugSchema,
  modelStatusSchema,
} from "./modelValidation.js";
export type { ModelQueryInput, ModelRegistrationInput } from "./modelValidation.js";
