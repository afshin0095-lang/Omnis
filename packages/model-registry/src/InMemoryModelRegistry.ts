/**
 * The in-memory Model Registry.
 *
 * Two indexes — by identifier and by slug — over deep-frozen descriptors, with every
 * public read returning a fresh frozen array in a deterministic order.
 *
 * WHY IN-MEMORY IS THE RIGHT FIRST IMPLEMENTATION
 * -----------------------------------------------
 * A model registry is small (tens to low hundreds of entries), read constantly and
 * written rarely. Putting it in a database on day one would add a network hop to every
 * routing decision and a consistency question the domain does not have. The interface is
 * what will outlive this file: a distributed registry is a second implementation of
 * {@link ModelRegistry}, not a change to its callers.
 *
 * CONCURRENCY
 * -----------
 * JavaScript gives this class single-threaded execution between awaits, and every method
 * here is synchronous, so a registration cannot interleave with another one. That is a
 * property worth stating rather than assuming: the moment a registry implementation
 * becomes asynchronous, "check for duplicate then insert" needs an explicit guard.
 */

import { redactAttributes } from "@omnis/errors";
import { nowIso } from "@omnis/types";
import { validate } from "@omnis/validation";
import {
  assertJsonSafe,
  compareModelDescriptors,
  createModelId,
  modelMatchesReference,
  modelSatisfiesCapabilities,
  modelSatisfiesModalities,
} from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  ModelCapability,
  ModelDescriptor,
  ModelId,
  ModelReference,
  ModelStatus,
  ProviderId,
} from "@omnis/ai-core-types";
import {
  duplicateModelId,
  duplicateModelSlug,
  invalidModelStatusTransition,
  modelNotRegistered,
  modelNotResolvable,
  registryCapacityExceeded,
} from "./errors.js";
import {
  isLegalModelStatusTransition,
  type ModelQuery,
  type ModelRegistry,
  type ModelResolution,
} from "./ModelRegistry.js";
import type { ModelRegistryOptions } from "./ModelRegistry.js";
import { modelRegistrationInputSchema } from "./modelValidation.js";
import type { ModelRegistrationInput } from "./modelValidation.js";

/** Default priority for a model registered without one: middling, so an explicit choice always wins. */
const DEFAULT_PRIORITY = 100;

/** Default capacity. Generous for hand-written configuration, small enough to catch a discovery loop. */
const DEFAULT_MAX_ENTRIES = 512;

/** Deep-freezes a descriptor and everything reachable from it. */
function deepFreezeDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  Object.freeze(descriptor.capabilities);
  Object.freeze(descriptor.modalities);
  Object.freeze(descriptor.modalities.input);
  Object.freeze(descriptor.modalities.output);
  if (descriptor.pricing !== null) {
    Object.freeze(descriptor.pricing);
  }
  Object.freeze(descriptor.metadata);
  return Object.freeze(descriptor);
}

/** Redacts and JSON-checks caller metadata before it becomes part of a durable record. */
function sanitizeDescriptorMetadata(metadata: Readonly<Record<string, unknown>>): AiCoreMetadata {
  const redacted = redactAttributes(metadata);
  assertJsonSafe(redacted, "model descriptor metadata");
  return redacted;
}

/** The in-memory implementation of {@link ModelRegistry}. */
export class InMemoryModelRegistry implements ModelRegistry {
  private readonly models = new Map<ModelId, ModelDescriptor>();
  private readonly slugIndex = new Map<string, ModelId>();
  private readonly clock: () => string;
  private readonly maxEntries: number;

  constructor(options: ModelRegistryOptions = {}) {
    this.clock = options.clock ?? nowIso;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError(
        `model registry capacity must be a positive integer, received ${String(this.maxEntries)}`,
      );
    }
  }

  get size(): number {
    return this.models.size;
  }

  register(input: ModelRegistrationInput): ModelDescriptor {
    // Validated even when the caller is TypeScript-typed: the values come from
    // configuration and from an admin API, and a typed caller can still hold a
    // descriptor built from an unvalidated parse.
    const parsed = validate(modelRegistrationInputSchema, input, "ModelRegistration");

    if (this.models.size >= this.maxEntries) {
      throw registryCapacityExceeded(this.maxEntries);
    }

    const existingSlug = this.slugIndex.get(parsed.slug);
    if (existingSlug !== undefined) {
      throw duplicateModelSlug(parsed.slug, existingSlug);
    }
    const modelId = parsed.id ?? createModelId();
    if (this.models.has(modelId)) {
      throw duplicateModelId(modelId);
    }

    const descriptor = deepFreezeDescriptor({
      id: modelId,
      slug: parsed.slug,
      displayName: parsed.displayName,
      providerId: parsed.providerId,
      kind: parsed.kind,
      status: parsed.status ?? "available",
      capabilities: [...parsed.capabilities],
      modalities: { input: [...parsed.modalities.input], output: [...parsed.modalities.output] },
      contextWindowTokens: parsed.contextWindowTokens ?? 0,
      maxOutputTokens: parsed.maxOutputTokens ?? 0,
      pricing: parsed.pricing ?? null,
      priority: parsed.priority ?? DEFAULT_PRIORITY,
      latencyClass: parsed.latencyClass ?? "unknown",
      providerModelName: parsed.providerModelName,
      version: 1,
      metadata: sanitizeDescriptorMetadata(parsed.metadata ?? {}),
      registeredAt: parsed.registeredAt ?? this.clock(),
    });

    this.models.set(modelId, descriptor);
    this.slugIndex.set(descriptor.slug, modelId);
    return descriptor;
  }

  get(modelId: ModelId): ModelDescriptor | null {
    return this.models.get(modelId) ?? null;
  }

  require(modelId: ModelId): ModelDescriptor {
    const descriptor = this.models.get(modelId);
    if (descriptor === undefined) {
      throw modelNotRegistered(modelId);
    }
    return descriptor;
  }

  has(modelId: ModelId): boolean {
    return this.models.has(modelId);
  }

  hasSlug(slug: string): boolean {
    return this.slugIndex.has(slug);
  }

  getBySlug(slug: string): ModelDescriptor | null {
    const modelId = this.slugIndex.get(slug);
    return modelId === undefined ? null : (this.models.get(modelId) ?? null);
  }

  idForSlug(slug: string): ModelId | null {
    return this.slugIndex.get(slug) ?? null;
  }

  remove(modelId: ModelId): boolean {
    const descriptor = this.models.get(modelId);
    if (descriptor === undefined) {
      return false;
    }
    this.models.delete(modelId);
    // The slug index is removed with the model, so the slug becomes registerable again.
    // A retired *identity* is never reused, but a removed registration is not a retirement.
    if (this.slugIndex.get(descriptor.slug) === modelId) {
      this.slugIndex.delete(descriptor.slug);
    }
    return true;
  }

  list(): readonly ModelDescriptor[] {
    return this.sorted(this.models.values());
  }

  findByCapability(capability: ModelCapability): readonly ModelDescriptor[] {
    return this.sorted(
      [...this.models.values()].filter((descriptor) =>
        descriptor.capabilities.includes(capability),
      ),
    );
  }

  findByProvider(providerId: ProviderId): readonly ModelDescriptor[] {
    return this.sorted(
      [...this.models.values()].filter((descriptor) => descriptor.providerId === providerId),
    );
  }

  find(query: ModelQuery): readonly ModelDescriptor[] {
    const statuses = query.statuses ?? null;
    const matches = [...this.models.values()].filter((descriptor) => {
      if (
        query.providerId !== undefined &&
        query.providerId !== null &&
        descriptor.providerId !== query.providerId
      ) {
        return false;
      }
      if (query.kind !== undefined && query.kind !== null && descriptor.kind !== query.kind) {
        return false;
      }
      if (statuses !== null && !statuses.includes(descriptor.status)) {
        return false;
      }
      if (
        query.capabilities !== undefined &&
        !modelSatisfiesCapabilities(descriptor, query.capabilities)
      ) {
        return false;
      }
      if (
        query.inputModalities !== undefined &&
        !modelSatisfiesModalities(descriptor, query.inputModalities, [])
      ) {
        return false;
      }
      if (
        query.outputModalities !== undefined &&
        !modelSatisfiesModalities(descriptor, [], query.outputModalities)
      ) {
        return false;
      }
      if (
        query.minContextWindowTokens !== undefined &&
        descriptor.contextWindowTokens < query.minContextWindowTokens
      ) {
        return false;
      }
      if (
        query.minMaxOutputTokens !== undefined &&
        descriptor.maxOutputTokens < query.minMaxOutputTokens
      ) {
        return false;
      }
      return true;
    });

    const ordered = this.sorted(matches);
    return query.limit === undefined ? ordered : Object.freeze(ordered.slice(0, query.limit));
  }

  /**
   * Resolves a reference to the model that should serve it.
   *
   * Resolution applies *selectability*: a retired model does not resolve, even by
   * identifier, because resolution is what routing uses. {@link get} and {@link require}
   * still return a retired descriptor, so an admin surface can inspect and audit it.
   */
  resolve(reference: ModelReference): ModelResolution | null {
    const candidates = this.candidatesFor(reference);
    const chosen = candidates[0];
    if (chosen === undefined) {
      return null;
    }
    return Object.freeze({
      descriptor: chosen,
      reference,
      matchedBy: reference.kind,
      candidates,
    });
  }

  requireReference(reference: ModelReference): ModelResolution {
    const resolution = this.resolve(reference);
    if (resolution === null) {
      throw modelNotResolvable(reference, "no selectable model matched the reference");
    }
    return resolution;
  }

  setStatus(modelId: ModelId, status: ModelStatus): ModelDescriptor {
    const current = this.models.get(modelId);
    if (current === undefined) {
      throw modelNotRegistered(modelId);
    }
    if (!isLegalModelStatusTransition(current.status, status)) {
      throw invalidModelStatusTransition(current.slug, current.status, status);
    }
    if (current.status === status) {
      return current;
    }
    // Replacement, not mutation: the descriptor an execution already recorded must keep
    // describing what was true when it ran.
    const replacement = deepFreezeDescriptor({ ...current, status, version: current.version + 1 });
    this.models.set(modelId, replacement);
    return replacement;
  }

  /** Every selectable descriptor matching a reference, in deterministic order. */
  private candidatesFor(reference: ModelReference): readonly ModelDescriptor[] {
    if (reference.kind === "id") {
      const descriptor = this.models.get(reference.modelId);
      // An exact identifier that is retired resolves to nothing: routing must not send
      // work to a model that has been taken out of service.
      return descriptor === undefined || !modelMatchesReference(descriptor, reference)
        ? Object.freeze([])
        : Object.freeze([descriptor]);
    }
    return this.sorted(
      [...this.models.values()].filter((descriptor) =>
        modelMatchesReference(descriptor, reference),
      ),
    );
  }

  /** Sorts descriptors into the registry's canonical order and freezes the result. */
  private sorted(descriptors: Iterable<ModelDescriptor>): readonly ModelDescriptor[] {
    return Object.freeze([...descriptors].sort(compareModelDescriptors));
  }
}

/** Creates an in-memory model registry. */
export function createModelRegistry(options: ModelRegistryOptions = {}): ModelRegistry {
  return new InMemoryModelRegistry(options);
}
