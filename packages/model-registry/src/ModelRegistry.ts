/**
 * The Model Registry contract.
 *
 * A registry, in OMNIS, is not a cache and not a map with extra steps. It is the
 * authority on *what models exist* and the only thing that can mint or retire a model
 * identity. Three properties follow from that and are part of this interface's contract:
 *
 * 1. **Determinism.** `list`, `find` and `resolve` return the same order for the same
 *    registry contents, always. Selection downstream picks the first candidate, so an
 *    order that depended on insertion or hash iteration would make model routing
 *    unreproducible — the worst kind of bug, because it disappears when you look at it.
 * 2. **Immutability.** A registered descriptor is deep-frozen. `setStatus` does not
 *    mutate; it replaces the record and bumps its version, so an audit row that
 *    referenced the old descriptor still describes what was true then.
 * 3. **No mutable internals escape.** Every returned array is a fresh frozen copy. A
 *    caller that could hold the registry's own array could reorder routing for everyone.
 */

import type {
  ModelCapability,
  ModelDescriptor,
  ModelId,
  ModelReference,
  ModelStatus,
  ProviderId,
} from "@omnis/ai-core-types";
import type { ModelQueryInput, ModelRegistrationInput } from "./modelValidation.js";

/** A query over the registry. Every field narrows; omitted fields do not filter. */
export type ModelQuery = ModelQueryInput;

/** How a reference resolved, and what else matched. */
export interface ModelResolution {
  /** The chosen descriptor: the first candidate in deterministic order. */
  readonly descriptor: ModelDescriptor;
  /** The reference that was resolved, echoed for audit records. */
  readonly reference: ModelReference;
  /** Which of the three reference kinds produced the match. */
  readonly matchedBy: ModelReference["kind"];
  /**
   * Every descriptor that matched, in deterministic order.
   *
   * Kept because "why did it pick this model?" must be answerable after the fact, and
   * because the orchestrator's fallback needs the runners-up without re-resolving.
   */
  readonly candidates: readonly ModelDescriptor[];
}

/** No status may follow `retired`. */
const NO_FURTHER_STATUSES: readonly ModelStatus[] = Object.freeze([]);

/** Status transitions the registry allows. `retired` is terminal. */
export const MODEL_STATUS_TRANSITIONS: Readonly<Record<ModelStatus, readonly ModelStatus[]>> =
  Object.freeze({
    available: Object.freeze(["preview", "degraded", "retired"] as readonly ModelStatus[]),
    preview: Object.freeze(["available", "degraded", "retired"] as readonly ModelStatus[]),
    degraded: Object.freeze(["available", "preview", "retired"] as readonly ModelStatus[]),
    // A retired model identity is never reused: an audit row saying "model X served this
    // execution" must keep meaning the same thing forever.
    retired: NO_FURTHER_STATUSES,
  });

/** True when a descriptor may move from `from` to `to`. */
export function isLegalModelStatusTransition(from: ModelStatus, to: ModelStatus): boolean {
  return from === to || MODEL_STATUS_TRANSITIONS[from].includes(to);
}

/** How a registry is configured. */
export interface ModelRegistryOptions {
  /**
   * Source of registration timestamps, as a UTC ISO 8601 string.
   *
   * Injectable so a test can register three models and assert their ordering without
   * racing the wall clock. Defaults to the platform's `nowIso`.
   */
  readonly clock?: () => string;
  /**
   * Maximum number of registered models.
   *
   * A registry that grows without bound is a memory leak with a UI. Discovery-driven
   * registration (a future provider listing every model it serves) makes this a real
   * risk rather than a theoretical one.
   */
  readonly maxEntries?: number;
}

/** The registry's public surface. */
export interface ModelRegistry {
  /** Number of registered models. */
  readonly size: number;

  /**
   * Registers a model.
   *
   * Validates the input, assigns the identifier and version, sanitizes metadata,
   * deep-freezes the result and indexes it by identifier and slug. Rejects a duplicate
   * identifier or slug rather than overwriting: silently replacing a model would change
   * the meaning of every agent configuration that referenced it.
   */
  register(input: ModelRegistrationInput): ModelDescriptor;

  /** The descriptor for an identifier, or `null` when it is not registered. */
  get(modelId: ModelId): ModelDescriptor | null;

  /**
   * The descriptor for an identifier, throwing when it is not registered.
   *
   * For call sites where a missing model is a programming error rather than a
   * recoverable condition — an agent whose configured model has been removed.
   */
  require(modelId: ModelId): ModelDescriptor;

  /** True when the identifier is registered. */
  has(modelId: ModelId): boolean;

  /** True when the slug is registered. */
  hasSlug(slug: string): boolean;

  /** The descriptor registered under a slug, or `null`. */
  getBySlug(slug: string): ModelDescriptor | null;

  /**
   * Removes a model.
   *
   * Returns false when it was not registered. Removing a model does not retroactively
   * invalidate executions that used it; their records keep the descriptor they ran with.
   */
  remove(modelId: ModelId): boolean;

  /** Every registered model, in deterministic order. */
  list(): readonly ModelDescriptor[];

  /** Models advertising a capability, in deterministic order. */
  findByCapability(capability: ModelCapability): readonly ModelDescriptor[];

  /** Models served by one provider, in deterministic order. */
  findByProvider(providerId: ProviderId): readonly ModelDescriptor[];

  /** Models matching every criterion of a query, in deterministic order. */
  find(query: ModelQuery): readonly ModelDescriptor[];

  /** Resolves a reference, or `null` when nothing matches. */
  resolve(reference: ModelReference): ModelResolution | null;

  /** Resolves a reference, throwing when nothing matches. */
  requireReference(reference: ModelReference): ModelResolution;

  /**
   * Moves a model to a new lifecycle status, returning the replacement descriptor.
   *
   * The previous descriptor is left untouched and its version stays meaningful; the
   * returned one carries `version + 1`.
   */
  setStatus(modelId: ModelId, status: ModelStatus): ModelDescriptor;

  /** The identifier registered under a slug, or `null`. */
  idForSlug(slug: string): ModelId | null;
}
