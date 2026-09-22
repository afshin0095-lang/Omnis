/**
 * The in-memory tool registry.
 *
 * Descriptors and handlers are stored side by side and never merged: the descriptor is data that
 * can be serialized into an audit row or a model's tool list, the handler is a live closure that
 * must never leak into either. Both are looked up by the same identifier, and the name index
 * exists because models call tools by name.
 *
 * Every method is synchronous, so "check for a duplicate, then insert" cannot interleave with
 * another registration.
 */

import { nowIso } from "@omnis/types";
import { validate } from "@omnis/validation";
import { sanitizeMetadata } from "@omnis/execution-context";
import {
  formatPermission,
  isAtLeastRisk,
  isInvocableToolStatus,
  parsePermission,
  toolParameterSchema,
} from "@omnis/ai-core-types";
import type {
  ToolDescriptor,
  ToolHandler,
  ToolId,
  ToolKind,
  ToolParameterSchema,
  ToolReference,
  ToolRiskLevel,
  ToolStatus,
} from "@omnis/ai-core-types";
import { createToolId } from "@omnis/types";
import {
  isLegalToolStatusTransition,
  type ToolRegistry,
  type ToolRegistryOptions,
} from "./ToolRegistry.js";
import type { ToolDescriptorInput } from "./toolValidation.js";
import { toolDescriptorInputSchema } from "./toolValidation.js";
import {
  duplicateTool,
  invalidToolDescriptor,
  invalidToolHandler,
  invalidToolStatusTransition,
  toolNotRegistered,
  toolRegistryCapacityExceeded,
} from "./errors.js";

/** Default capacity. */
const DEFAULT_MAX_ENTRIES = 256;

/** A registration: descriptor plus the handler that implements it. */
interface Registration {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
}

/**
 * Verifies a handler before it is stored.
 *
 * Arity is checked because a handler declared with two parameters would be called with one and
 * silently receive `undefined` for the second — a bug that shows up as a tool that works in unit
 * tests and misbehaves in production.
 */
function assertHandler(name: string, handler: ToolHandler): void {
  if (typeof handler !== "function") {
    throw invalidToolHandler(name, "handler must be a function");
  }
  if (handler.length > 1) {
    throw invalidToolHandler(
      name,
      `handler declares ${String(handler.length)} parameters; a tool handler receives one invocation`,
    );
  }
}

/** Rebuilds a parameter schema so the stored one is closed, frozen and self-consistent. */
function normalizeParameterSchema(schema: ToolParameterSchema): ToolParameterSchema {
  if (schema.kind !== "object") {
    throw invalidToolDescriptor("parameter schema must be a closed object schema");
  }
  return toolParameterSchema(schema.properties, schema.required);
}

/** Validates declared permissions, because an unparseable permission is an unenforceable one. */
function normalizePermissions(
  permissions: readonly ToolDescriptor["permissions"][number][],
): readonly ToolDescriptor["permissions"][number][] {
  const normalized = permissions.map((permission) =>
    Object.freeze({ resource: permission.resource, action: permission.action }),
  );
  for (const permission of normalized) {
    if (parsePermission(formatPermission(permission)) === null) {
      throw invalidToolDescriptor(
        `permission "${formatPermission(permission)}" is not a well-formed resource:action pair`,
      );
    }
  }
  return Object.freeze(normalized);
}

/** Deep-freezes a descriptor and everything reachable from it. */
function deepFreezeDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  Object.freeze(descriptor.permissions);
  for (const permission of descriptor.permissions) {
    Object.freeze(permission);
  }
  Object.freeze(descriptor.parameters);
  Object.freeze(descriptor.parameters.properties);
  for (const spec of Object.values(descriptor.parameters.properties)) {
    Object.freeze(spec);
    Object.freeze(spec.enumValues);
    if (spec.items !== null) {
      Object.freeze(spec.items);
      Object.freeze(spec.items.enumValues);
    }
  }
  Object.freeze(descriptor.parameters.required);
  Object.freeze(descriptor.metadata);
  return Object.freeze(descriptor);
}

/** The in-memory implementation of {@link ToolRegistry}. */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly registrations = new Map<ToolId, Registration>();
  private readonly nameIndex = new Map<string, ToolId>();
  private readonly clock: () => string;
  private readonly maxEntries: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.clock = options.clock ?? nowIso;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError(
        `tool registry capacity must be a positive integer, received ${String(this.maxEntries)}`,
      );
    }
  }

  get size(): number {
    return this.registrations.size;
  }

  register(input: ToolDescriptorInput, handler: ToolHandler): ToolDescriptor {
    const parsed = validate(toolDescriptorInputSchema, input, "ToolDescriptor");
    const name = parsed.name;
    assertHandler(name, handler);

    const toolId = parsed.id ?? createToolId();
    if (this.registrations.size >= this.maxEntries) {
      throw toolRegistryCapacityExceeded(this.maxEntries);
    }
    const existingName = this.nameIndex.get(name);
    if (existingName !== undefined) {
      throw duplicateTool(name, existingName);
    }
    if (this.registrations.has(toolId)) {
      throw duplicateTool(toolId, toolId);
    }

    if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
      // The schema already rejects this; the check stays because a descriptor can also arrive
      // through a caller that built the object by hand rather than through the schema.
      throw invalidToolDescriptor("timeoutMs must be a positive integer", name);
    }

    const descriptor = deepFreezeDescriptor({
      id: toolId,
      name,
      displayName: parsed.displayName,
      description: parsed.description,
      version: parsed.version,
      kind: parsed.kind,
      riskLevel: parsed.riskLevel,
      sideEffect: parsed.sideEffect,
      permissions: normalizePermissions(parsed.permissions),
      parameters: normalizeParameterSchema(parsed.parameters),
      resultDescription: parsed.resultDescription,
      timeoutMs: parsed.timeoutMs,
      supportsCancellation: parsed.supportsCancellation,
      maxConcurrency: parsed.maxConcurrency,
      requiresApproval: parsed.requiresApproval,
      policyId: parsed.policyId ?? null,
      budgetId: parsed.budgetId ?? null,
      // A tool starts enabled: unlike a provider, nothing about it has to be verified against a
      // live endpoint, and a tool that must be held back is registered disabled on purpose.
      status: parsed.status ?? "enabled",
      metadata: sanitizeMetadata(parsed.metadata ?? {}),
      registeredAt: parsed.registeredAt ?? this.clock(),
    });

    this.registrations.set(toolId, { descriptor, handler });
    this.nameIndex.set(name, toolId);
    return descriptor;
  }

  get(toolId: ToolId): ToolDescriptor | null {
    return this.registrations.get(toolId)?.descriptor ?? null;
  }

  require(toolId: ToolId): ToolDescriptor {
    return this.registrationFor(toolId).descriptor;
  }

  has(toolId: ToolId): boolean {
    return this.registrations.has(toolId);
  }

  getByName(name: string): ToolDescriptor | null {
    const toolId = this.nameIndex.get(name);
    return toolId === undefined ? null : (this.registrations.get(toolId)?.descriptor ?? null);
  }

  hasName(name: string): boolean {
    return this.nameIndex.has(name);
  }

  idForName(name: string): ToolId | null {
    return this.nameIndex.get(name) ?? null;
  }

  resolve(reference: ToolReference): ToolDescriptor | null {
    return reference.kind === "id" ? this.get(reference.toolId) : this.getByName(reference.name);
  }

  remove(toolId: ToolId): boolean {
    const registration = this.registrations.get(toolId);
    if (registration === undefined) {
      return false;
    }
    this.registrations.delete(toolId);
    if (this.nameIndex.get(registration.descriptor.name) === toolId) {
      this.nameIndex.delete(registration.descriptor.name);
    }
    return true;
  }

  list(): readonly ToolDescriptor[] {
    return this.sorted(
      [...this.registrations.values()].map((registration) => registration.descriptor),
    );
  }

  findByKind(kind: ToolKind): readonly ToolDescriptor[] {
    return this.sorted(
      [...this.registrations.values()]
        .filter((registration) => registration.descriptor.kind === kind)
        .map((registration) => registration.descriptor),
    );
  }

  findByRiskLevel(minimum: ToolRiskLevel): readonly ToolDescriptor[] {
    return this.sorted(
      [...this.registrations.values()]
        .filter((registration) => isAtLeastRisk(registration.descriptor.riskLevel, minimum))
        .map((registration) => registration.descriptor),
    );
  }

  findByPermissionResource(resource: string): readonly ToolDescriptor[] {
    return this.sorted(
      [...this.registrations.values()]
        .filter((registration) =>
          registration.descriptor.permissions.some(
            (permission) => permission.resource === resource,
          ),
        )
        .map((registration) => registration.descriptor),
    );
  }

  handlerFor(toolId: ToolId): ToolHandler | null {
    return this.registrations.get(toolId)?.handler ?? null;
  }

  requireHandler(toolId: ToolId): ToolHandler {
    return this.registrationFor(toolId).handler;
  }

  setStatus(toolId: ToolId, status: ToolStatus): ToolDescriptor {
    const registration = this.registrationFor(toolId);
    const current = registration.descriptor;
    if (!isLegalToolStatusTransition(current.status, status)) {
      throw invalidToolStatusTransition(current.name, current.status, status);
    }
    if (current.status === status) {
      return current;
    }
    const descriptor = deepFreezeDescriptor({ ...current, status });
    this.registrations.set(toolId, { descriptor, handler: registration.handler });
    return descriptor;
  }

  /** The descriptors a caller may present to a model: everything invocable, by name. */
  invocable(): readonly ToolDescriptor[] {
    return this.sorted(
      [...this.registrations.values()]
        .filter((registration) => isInvocableToolStatus(registration.descriptor.status))
        .map((registration) => registration.descriptor),
    );
  }

  private registrationFor(toolId: ToolId): Registration {
    const registration = this.registrations.get(toolId);
    if (registration === undefined) {
      throw toolNotRegistered({ kind: "id", toolId });
    }
    return registration;
  }

  /** Canonical registry order: name, then identifier. */
  private sorted(descriptors: readonly ToolDescriptor[]): readonly ToolDescriptor[] {
    return Object.freeze(
      [...descriptors].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    );
  }
}

/** Creates an in-memory tool registry. */
export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  return new InMemoryToolRegistry(options);
}
