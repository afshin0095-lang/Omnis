/**
 * The in-memory Provider Registry.
 *
 * Descriptors and adapters are stored side by side but never merged: the descriptor is
 * data that can be serialized into an event, the adapter is a live object holding whatever
 * the vendor integration needs. Keeping them apart is what allows a descriptor to be
 * published while the adapter stays private.
 *
 * Every method is synchronous. That is a deliberate property, not an accident: with
 * single-threaded execution between awaits, "check for a duplicate, then insert" cannot
 * interleave with another registration, so the registry needs no locking to be correct.
 */

import { redactAttributes } from "@omnis/errors";
import { nowIso } from "@omnis/types";
import { validate } from "@omnis/validation";
import { assertJsonSafe, compareProviderDescriptors } from "@omnis/ai-core-types";
import type {
  AiCoreMetadata,
  ModelCapability,
  ProviderCandidate,
  ProviderDescriptor,
  ProviderHealth,
  ProviderHealthObservation,
  ProviderId,
  ProviderOperation,
  ProviderReference,
  ProviderStatus,
} from "@omnis/ai-core-types";
import { assertProviderAdapter, type ProviderAdapter } from "./ProviderAdapter.js";
import {
  applyHealthObservation,
  assertProviderHealthOptions,
  DEFAULT_PROVIDER_HEALTH_OPTIONS,
  unknownHealth,
  type ProviderHealthOptions,
} from "./ProviderHealth.js";
import type { ProviderSelectionRequest, SelectableProvider } from "./ProviderSelection.js";
import { scoreProvider, selectProviders } from "./ProviderSelection.js";
import {
  duplicateProviderId,
  duplicateProviderSlug,
  invalidProviderStatusTransition,
  providerNotRegistered,
  providerRegistryCapacityExceeded,
} from "./errors.js";
import {
  isLegalProviderStatusTransition,
  type ProviderRegistry,
  type ProviderRegistryOptions,
} from "./ProviderRegistry.js";
import { providerRegistrationInputSchema } from "./providerValidation.js";
import type { ProviderRegistrationInput } from "./providerValidation.js";

/** Default priority: middling, so an explicit choice always outranks an unspecified one. */
const DEFAULT_PRIORITY = 100;

/** Default capacity. */
const DEFAULT_MAX_ENTRIES = 64;

/** A registration: descriptor plus the adapter that serves it. */
interface Registration {
  readonly descriptor: ProviderDescriptor;
  readonly adapter: ProviderAdapter;
  readonly health: ProviderHealth;
}

/** Redacts and JSON-checks caller metadata before it becomes a durable record. */
function sanitizeDescriptorMetadata(metadata: Readonly<Record<string, unknown>>): AiCoreMetadata {
  const redacted = redactAttributes(metadata);
  assertJsonSafe(redacted, "provider descriptor metadata");
  return redacted;
}

/** Deep-freezes a descriptor and everything reachable from it. */
function deepFreezeDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  Object.freeze(descriptor.capabilities);
  Object.freeze(descriptor.capabilities.operations);
  Object.freeze(descriptor.capabilities.inputModalities);
  Object.freeze(descriptor.capabilities.outputModalities);
  Object.freeze(descriptor.capabilities.modelCapabilities);
  Object.freeze(descriptor.rateLimit);
  Object.freeze(descriptor.metadata);
  return Object.freeze(descriptor);
}

/** The in-memory implementation of {@link ProviderRegistry}. */
export class InMemoryProviderRegistry implements ProviderRegistry {
  private readonly registrations = new Map<ProviderId, Registration>();
  private readonly slugIndex = new Map<string, ProviderId>();
  private readonly clock: () => string;
  private readonly maxEntries: number;
  readonly healthOptions: ProviderHealthOptions;

  constructor(options: ProviderRegistryOptions = {}) {
    this.clock = options.clock ?? nowIso;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.healthOptions = Object.freeze({ ...DEFAULT_PROVIDER_HEALTH_OPTIONS, ...options.health });
    assertProviderHealthOptions(this.healthOptions);
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError(
        `provider registry capacity must be a positive integer, received ${String(this.maxEntries)}`,
      );
    }
  }

  get size(): number {
    return this.registrations.size;
  }

  register(input: ProviderRegistrationInput, adapter: ProviderAdapter): ProviderDescriptor {
    const parsed = validate(providerRegistrationInputSchema, input, "ProviderRegistration");

    // The adapter is authoritative for identity: it is the object that will actually be
    // called, so a descriptor claiming a different provider is a registration bug.
    const providerId = parsed.id ?? adapter.providerId;
    assertProviderAdapter(adapter, providerId);

    if (this.registrations.size >= this.maxEntries) {
      throw providerRegistryCapacityExceeded(this.maxEntries);
    }
    const existingSlug = this.slugIndex.get(parsed.slug);
    if (existingSlug !== undefined) {
      throw duplicateProviderSlug(parsed.slug, existingSlug);
    }
    if (this.registrations.has(providerId)) {
      throw duplicateProviderId(providerId);
    }

    const registeredAt = parsed.registeredAt ?? this.clock();
    const descriptor = deepFreezeDescriptor({
      id: providerId,
      slug: parsed.slug,
      displayName: parsed.displayName,
      transport: parsed.transport ?? "http",
      // A provider starts unproven. Moving to `ready` is an explicit lifecycle step, so
      // registering a provider cannot silently put an unverified adapter into rotation.
      status: "registered",
      capabilities: {
        operations: [...parsed.capabilities.operations],
        inputModalities: [...parsed.capabilities.inputModalities],
        outputModalities: [...parsed.capabilities.outputModalities],
        modelCapabilities: [...parsed.capabilities.modelCapabilities],
      },
      rateLimit: {
        requestsPerMinute: parsed.rateLimit?.requestsPerMinute ?? null,
        tokensPerMinute: parsed.rateLimit?.tokensPerMinute ?? null,
        maxConcurrentRequests: parsed.rateLimit?.maxConcurrentRequests ?? null,
      },
      priority: parsed.priority ?? DEFAULT_PRIORITY,
      latencyClass: parsed.latencyClass ?? "unknown",
      region: parsed.region ?? null,
      policyId: parsed.policyId ?? null,
      budgetId: parsed.budgetId ?? null,
      credentialsConfigured: parsed.credentialsConfigured ?? false,
      metadata: sanitizeDescriptorMetadata(parsed.metadata ?? {}),
      registeredAt,
    });

    this.registrations.set(providerId, {
      descriptor,
      adapter,
      health: unknownHealth(providerId, registeredAt),
    });
    this.slugIndex.set(descriptor.slug, providerId);
    return descriptor;
  }

  get(providerId: ProviderId): ProviderDescriptor | null {
    return this.registrations.get(providerId)?.descriptor ?? null;
  }

  require(providerId: ProviderId): ProviderDescriptor {
    const registration = this.registrations.get(providerId);
    if (registration === undefined) {
      throw providerNotRegistered(providerId);
    }
    return registration.descriptor;
  }

  has(providerId: ProviderId): boolean {
    return this.registrations.has(providerId);
  }

  hasSlug(slug: string): boolean {
    return this.slugIndex.has(slug);
  }

  getBySlug(slug: string): ProviderDescriptor | null {
    const providerId = this.slugIndex.get(slug);
    return providerId === undefined
      ? null
      : (this.registrations.get(providerId)?.descriptor ?? null);
  }

  idForSlug(slug: string): ProviderId | null {
    return this.slugIndex.get(slug) ?? null;
  }

  remove(providerId: ProviderId): boolean {
    const registration = this.registrations.get(providerId);
    if (registration === undefined) {
      return false;
    }
    this.registrations.delete(providerId);
    if (this.slugIndex.get(registration.descriptor.slug) === providerId) {
      this.slugIndex.delete(registration.descriptor.slug);
    }
    // Disposing releases whatever the adapter holds — sockets, queues, refresh timers.
    // A removed provider that keeps a connection pool open is a leak that outlives it.
    void registration.adapter.dispose?.();
    return true;
  }

  list(): readonly ProviderDescriptor[] {
    return this.sorted(
      [...this.registrations.values()].map((registration) => registration.descriptor),
    );
  }

  findByOperation(operation: ProviderOperation): readonly ProviderDescriptor[] {
    return this.sorted(
      [...this.registrations.values()]
        .filter((registration) =>
          registration.descriptor.capabilities.operations.includes(operation),
        )
        .map((registration) => registration.descriptor),
    );
  }

  findByCapability(capability: ModelCapability): readonly ProviderDescriptor[] {
    return this.sorted(
      [...this.registrations.values()]
        .filter((registration) =>
          registration.descriptor.capabilities.modelCapabilities.includes(capability),
        )
        .map((registration) => registration.descriptor),
    );
  }

  adapterFor(providerId: ProviderId): ProviderAdapter | null {
    return this.registrations.get(providerId)?.adapter ?? null;
  }

  requireAdapter(providerId: ProviderId): ProviderAdapter {
    const registration = this.registrations.get(providerId);
    if (registration === undefined) {
      throw providerNotRegistered(providerId);
    }
    return registration.adapter;
  }

  health(providerId: ProviderId): ProviderHealth {
    const registration = this.registrations.get(providerId);
    return registration?.health ?? unknownHealth(providerId, this.clock());
  }

  recordObservation(
    providerId: ProviderId,
    observation: ProviderHealthObservation,
  ): ProviderHealth {
    const registration = this.registrations.get(providerId);
    if (registration === undefined) {
      throw providerNotRegistered(providerId);
    }
    const next = applyHealthObservation(registration.health, observation, this.healthOptions);
    // Replacing the registration object rather than assigning a field keeps the stored
    // value immutable, so a snapshot handed to a caller cannot change underneath them.
    this.registrations.set(providerId, { ...registration, health: next });
    return next;
  }

  recordSuccess(
    providerId: ProviderId,
    latencyMs: number,
    observedAt: string = this.clock(),
  ): ProviderHealth {
    return this.recordObservation(providerId, { kind: "success", latencyMs, observedAt });
  }

  recordFailure(
    providerId: ProviderId,
    failureClass: string,
    observedAt: string = this.clock(),
  ): ProviderHealth {
    return this.recordObservation(providerId, { kind: "failure", failureClass, observedAt });
  }

  setStatus(providerId: ProviderId, status: ProviderStatus): ProviderDescriptor {
    const registration = this.registrations.get(providerId);
    if (registration === undefined) {
      throw providerNotRegistered(providerId);
    }
    const current = registration.descriptor;
    if (!isLegalProviderStatusTransition(current.status, status)) {
      throw invalidProviderStatusTransition(current.slug, current.status, status);
    }
    if (current.status === status) {
      return current;
    }
    const descriptor = deepFreezeDescriptor({ ...current, status });
    this.registrations.set(providerId, { ...registration, descriptor });
    return descriptor;
  }

  resolve(reference: ProviderReference): ProviderDescriptor | null {
    if (reference.kind === "id") {
      return this.get(reference.providerId);
    }
    return this.getBySlug(reference.slug);
  }

  selectable(request: ProviderSelectionRequest = {}): readonly SelectableProvider[] {
    const providers = this.asSelectable();
    // Ordered the same way `list` is, so "selectable" is itself deterministic.
    providers.sort((left, right) => compareProviderDescriptors(left.descriptor, right.descriptor));
    return Object.freeze(providers.filter((provider) => scoreProvider(provider, request).selected));
  }

  select(request: ProviderSelectionRequest = {}): readonly ProviderCandidate[] {
    return selectProviders(this.asSelectable(), request);
  }

  /** Every registration as a selection input. */
  private asSelectable(): SelectableProvider[] {
    return [...this.registrations.values()].map((registration) => ({
      descriptor: registration.descriptor,
      health: registration.health,
      adapter: registration.adapter,
    }));
  }

  /** Canonical registry order, shared by every list-like read. */
  private sorted(descriptors: readonly ProviderDescriptor[]): readonly ProviderDescriptor[] {
    return Object.freeze([...descriptors].sort(compareProviderDescriptors));
  }
}

/** Creates an in-memory provider registry. */
export function createProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  return new InMemoryProviderRegistry(options);
}
