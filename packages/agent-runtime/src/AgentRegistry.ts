/**
 * The agent registry: what an agent *is*, as an immutable record.
 *
 * A registry holds descriptors, not instances. The descriptor is the governance
 * record — instructions, capabilities, tool bindings, ceilings, policy and budget
 * — and it is deep-frozen on the way in, because a descriptor that a caller can
 * mutate after registration is a ceiling that can be raised by whoever holds the
 * reference. Instances (a descriptor plus the progress of one run) live in the
 * runtime.
 *
 * Registration defaults `status` to `draft`. That is fail-closed on purpose: an
 * agent assembled from configuration that never said whether it may run is not an
 * agent somebody decided to run, and only an `active` agent executes.
 */

import { createAgentId } from "@omnis/types";
import {
  assertAgentDescriptorShape,
  describeAgentReference,
  isExecutableAgentStatus,
  UNCONSTRAINED_AGENT,
} from "@omnis/ai-core-types";
import type {
  AgentCapability,
  AgentDescriptor,
  AgentId,
  AgentKind,
  AgentReference,
  AgentRuntimeConstraints,
  AgentStatus,
  AiCoreMetadata,
  BudgetId,
  ModelReference,
  PolicyId,
} from "@omnis/ai-core-types";
import { assertJsonSafe } from "@omnis/ai-core-types";
import { redactAttributes } from "@omnis/errors";
import { toIso, systemClock } from "@omnis/execution-context";
import type { Clock } from "@omnis/execution-context";
import { validate } from "@omnis/validation";
import { agentRegistrationInputSchema } from "./agentValidation.js";
import type { AgentRegistrationInput } from "./agentValidation.js";
import { assertAgentStatusTransition } from "./AgentStateMachine.js";
import { agentNotFound, duplicateAgent } from "./errors.js";

/** How a reference was resolved, which is what makes a resolution explainable. */
export type AgentMatchedBy = "id" | "slug";

/** The outcome of resolving an {@link AgentReference}. */
export interface AgentResolution {
  readonly descriptor: AgentDescriptor;
  readonly reference: AgentReference;
  readonly matchedBy: AgentMatchedBy;
  /**
   * Every descriptor the reference could have meant.
   *
   * For an identifier this is the one match; for a slug it is every agent
   * registered under that slug, which is one unless a caller removed and
   * re-registered. A resolution that cannot show its candidates cannot be
   * debugged when it picks one nobody expected.
   */
  readonly candidates: readonly AgentDescriptor[];
}

/** The registry's public surface. */
export interface AgentRegistry {
  /** Number of registered agents. */
  readonly size: number;

  register(input: AgentRegistrationInput): AgentDescriptor;
  get(agentId: AgentId): AgentDescriptor | null;
  require(agentId: AgentId): AgentDescriptor;
  has(agentId: AgentId): boolean;
  hasSlug(slug: string): boolean;
  getBySlug(slug: string): AgentDescriptor | null;
  idForSlug(slug: string): AgentId | null;
  remove(agentId: AgentId): boolean;
  /** Every descriptor, ordered by slug then identifier. */
  list(): readonly AgentDescriptor[];
  findByKind(kind: AgentKind): readonly AgentDescriptor[];
  findByCapability(capability: AgentCapability): readonly AgentDescriptor[];
  findByStatus(status: AgentStatus): readonly AgentDescriptor[];
  /** Only the agents that may run. */
  executable(): readonly AgentDescriptor[];
  setStatus(agentId: AgentId, status: AgentStatus): AgentDescriptor;
  resolve(reference: AgentReference): AgentResolution | null;
  requireResolution(reference: AgentReference): AgentResolution;
}

/** Freezes a descriptor and everything inside it, field by field. */
function deepFreezeDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  Object.freeze(descriptor.capabilities);
  Object.freeze(descriptor.instructions);
  Object.freeze(descriptor.instructions.prohibitions);
  Object.freeze(descriptor.tools);
  for (const binding of descriptor.tools) {
    Object.freeze(binding);
  }
  Object.freeze(descriptor.memory);
  for (const reference of descriptor.memory) {
    Object.freeze(reference);
  }
  Object.freeze(descriptor.constraints);
  Object.freeze(descriptor.constraints.allowedTools);
  Object.freeze(descriptor.constraints.deniedTools);
  Object.freeze(descriptor.constraints.approvalRequiredAtRisk);
  Object.freeze(descriptor.constraints.preferredModels);
  for (const model of descriptor.constraints.preferredModels) {
    Object.freeze(model);
  }
  Object.freeze(descriptor.metadata);
  return Object.freeze(descriptor);
}

/** Redacts and JSON-checks caller metadata before it becomes part of a durable record. */
function sanitizeDescriptorMetadata(metadata: Readonly<Record<string, unknown>>): AiCoreMetadata {
  const redacted = redactAttributes(metadata);
  assertJsonSafe(redacted, "agent descriptor metadata");
  return redacted;
}

/** The ceilings a registration implies, filling in "inherit the runtime default". */
function constraintsFrom(input: AgentRegistrationInput["constraints"]): AgentRuntimeConstraints {
  if (input === undefined) {
    return UNCONSTRAINED_AGENT;
  }
  return Object.freeze({
    maxSteps: input.maxSteps ?? null,
    maxModelCalls: input.maxModelCalls ?? null,
    maxToolCalls: input.maxToolCalls ?? null,
    maxDurationMs: input.maxDurationMs ?? null,
    maxCostMicroUsd: input.maxCostMicroUsd ?? null,
    maxRetriesPerStep: input.maxRetriesPerStep ?? null,
    allowedTools: Object.freeze([...(input.allowedTools ?? [])]),
    deniedTools: Object.freeze([...(input.deniedTools ?? [])]),
    approvalRequiredAtRisk: Object.freeze([...(input.approvalRequiredAtRisk ?? [])]),
    // Copied, not re-spread: spreading a discriminated union widens `kind` and the
    // result is no longer a `ModelReference`.
    preferredModels: Object.freeze([...(input.preferredModels ?? [])]),
  });
}

/** The in-memory registry. */
export class InMemoryAgentRegistry implements AgentRegistry {
  readonly #byId = new Map<AgentId, AgentDescriptor>();
  readonly #idBySlug = new Map<string, AgentId>();
  readonly #clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  get size(): number {
    return this.#byId.size;
  }

  register(input: AgentRegistrationInput): AgentDescriptor {
    const parsed = validate(agentRegistrationInputSchema, input, "AgentRegistrationInput");
    const id = parsed.id ?? createAgentId();
    if (this.#byId.has(id)) {
      throw duplicateAgent(
        String(id),
        `an agent with identifier ${String(id)} is already registered`,
      );
    }
    if (this.#idBySlug.has(parsed.slug)) {
      throw duplicateAgent(
        parsed.slug,
        `an agent with slug "${parsed.slug}" is already registered`,
      );
    }

    const now = toIso(this.#clock());
    const descriptor = deepFreezeDescriptor({
      id,
      slug: parsed.slug,
      displayName: parsed.displayName ?? parsed.slug,
      description: parsed.description ?? "",
      kind: parsed.kind,
      // Fail closed: a registration that did not say may not run.
      status: parsed.status ?? "draft",
      version: parsed.version ?? "1.0.0",
      capabilities: Object.freeze([...(parsed.capabilities ?? [])]),
      instructions: Object.freeze({
        system: parsed.instructions?.system ?? "",
        developer: parsed.instructions?.developer ?? null,
        prohibitions: Object.freeze([...(parsed.instructions?.prohibitions ?? [])]),
      }),
      defaultModel:
        parsed.defaultModel === undefined
          ? null
          : parsed.defaultModel === null
            ? null
            : Object.freeze({ ...parsed.defaultModel }),
      tools: Object.freeze(
        (parsed.tools ?? []).map((binding) =>
          Object.freeze({
            toolId: binding.toolId,
            timeoutMsOverride: binding.timeoutMsOverride ?? null,
            maxCallsPerExecution: binding.maxCallsPerExecution ?? 0,
            required: binding.required ?? false,
          }),
        ),
      ),
      memory: Object.freeze(
        (parsed.memory ?? []).map((reference) =>
          Object.freeze({
            kind: reference.kind,
            storeId: reference.storeId,
            scope: reference.scope ?? null,
            writable: reference.writable ?? false,
          }),
        ),
      ),
      constraints: constraintsFrom(parsed.constraints),
      policyId: parsed.policyId ?? null,
      budgetId: parsed.budgetId ?? null,
      metadata: sanitizeDescriptorMetadata(parsed.metadata ?? {}),
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? now,
    });

    // A descriptor that binds the same tool twice, or more tools than a request may
    // carry, would make every downstream ceiling ambiguous. Refuse it at the door.
    assertAgentDescriptorShape(descriptor);

    this.#byId.set(id, descriptor);
    this.#idBySlug.set(descriptor.slug, id);
    return descriptor;
  }

  get(agentId: AgentId): AgentDescriptor | null {
    return this.#byId.get(agentId) ?? null;
  }

  require(agentId: AgentId): AgentDescriptor {
    const descriptor = this.#byId.get(agentId);
    if (descriptor === undefined) {
      throw agentNotFound({ kind: "id", agentId });
    }
    return descriptor;
  }

  has(agentId: AgentId): boolean {
    return this.#byId.has(agentId);
  }

  hasSlug(slug: string): boolean {
    return this.#idBySlug.has(slug);
  }

  getBySlug(slug: string): AgentDescriptor | null {
    const id = this.#idBySlug.get(slug);
    return id === undefined ? null : (this.#byId.get(id) ?? null);
  }

  idForSlug(slug: string): AgentId | null {
    return this.#idBySlug.get(slug) ?? null;
  }

  remove(agentId: AgentId): boolean {
    const descriptor = this.#byId.get(agentId);
    if (descriptor === undefined) {
      return false;
    }
    this.#byId.delete(agentId);
    // Only drop the slug index when it still points at this agent: a re-registration
    // under the same slug must not be un-indexed by a late removal of the old one.
    if (this.#idBySlug.get(descriptor.slug) === agentId) {
      this.#idBySlug.delete(descriptor.slug);
    }
    return true;
  }

  list(): readonly AgentDescriptor[] {
    return Object.freeze(
      [...this.#byId.values()].sort((left, right) =>
        left.slug === right.slug
          ? String(left.id).localeCompare(String(right.id))
          : left.slug.localeCompare(right.slug),
      ),
    );
  }

  findByKind(kind: AgentKind): readonly AgentDescriptor[] {
    return Object.freeze(this.list().filter((descriptor) => descriptor.kind === kind));
  }

  findByCapability(capability: AgentCapability): readonly AgentDescriptor[] {
    return Object.freeze(
      this.list().filter((descriptor) => descriptor.capabilities.includes(capability)),
    );
  }

  findByStatus(status: AgentStatus): readonly AgentDescriptor[] {
    return Object.freeze(this.list().filter((descriptor) => descriptor.status === status));
  }

  executable(): readonly AgentDescriptor[] {
    return Object.freeze(
      this.list().filter((descriptor) => isExecutableAgentStatus(descriptor.status)),
    );
  }

  setStatus(agentId: AgentId, status: AgentStatus): AgentDescriptor {
    const current = this.require(agentId);
    // A status move is governed by the same table as a state move: `retired` stays
    // retired, so a configuration naming a withdrawn agent fails loudly.
    assertAgentStatusTransition(agentId, current.status, status);
    const replacement = deepFreezeDescriptor({
      ...current,
      status,
      updatedAt: toIso(this.#clock()),
    });
    this.#byId.set(agentId, replacement);
    return replacement;
  }

  resolve(reference: AgentReference): AgentResolution | null {
    if (reference.kind === "id") {
      const descriptor = this.#byId.get(reference.agentId);
      return descriptor === undefined
        ? null
        : Object.freeze({
            descriptor,
            reference,
            matchedBy: "id",
            candidates: Object.freeze([descriptor]),
          });
    }
    const id = this.#idBySlug.get(reference.slug);
    const descriptor = id === undefined ? undefined : this.#byId.get(id);
    return descriptor === undefined
      ? null
      : Object.freeze({
          descriptor,
          reference,
          matchedBy: "slug",
          candidates: Object.freeze([descriptor]),
        });
  }

  requireResolution(reference: AgentReference): AgentResolution {
    const resolution = this.resolve(reference);
    if (resolution === null) {
      throw agentNotFound(reference);
    }
    return resolution;
  }
}

/** Creates an empty registry. */
export function createAgentRegistry(options: { readonly clock?: Clock } = {}): AgentRegistry {
  return new InMemoryAgentRegistry(options);
}

/** A stable rendering of a resolution, safe to log and to use as a cache key. */
export function describeAgentResolution(resolution: AgentResolution): string {
  return `${describeAgentReference(resolution.reference)} -> ${resolution.descriptor.slug}@${resolution.descriptor.version}`;
}

/** The model an agent should be asked to use first, or `null` when it declares none. */
export function preferredModelOf(descriptor: AgentDescriptor): ModelReference | null {
  const [first] = descriptor.constraints.preferredModels;
  return first ?? descriptor.defaultModel;
}

/** The policy an agent carries, or `null` when the runtime default applies. */
export function agentPolicyId(descriptor: AgentDescriptor): PolicyId | null {
  return descriptor.policyId;
}

/** The budget an agent carries, or `null` when the runtime default applies. */
export function agentBudgetId(descriptor: AgentDescriptor): BudgetId | null {
  return descriptor.budgetId;
}
