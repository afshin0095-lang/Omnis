/**
 * The tool registry contract.
 *
 * Registration and execution are separate authority boundaries, and the registry is the reason.
 * It stores descriptors and handlers side by side but hands them out separately: a caller that
 * can read a descriptor — to build a model's tool list, to render the Studio's inspector — cannot
 * call the handler. Only the runtime asks for {@link ToolRegistry.handlerFor}, and it asks after
 * the gates have run.
 *
 * Collapsing the two is how an agent ends up able to run arbitrary code because it could read a
 * registry.
 */

import type {
  ToolDescriptor,
  ToolHandler,
  ToolId,
  ToolKind,
  ToolReference,
  ToolRiskLevel,
  ToolStatus,
} from "@omnis/ai-core-types";
import type { ToolDescriptorInput } from "./toolValidation.js";

/** Lifecycle transitions a registered tool may make. */
export const TOOL_STATUS_TRANSITIONS: Readonly<Record<ToolStatus, readonly ToolStatus[]>> =
  Object.freeze({
    enabled: Object.freeze(["deprecated", "disabled"] as readonly ToolStatus[]),
    // Deprecated stays invocable: tools in use by stored agents cannot be withdrawn silently, so
    // deprecation is a warning to authors rather than a switch.
    deprecated: Object.freeze(["enabled", "disabled"] as readonly ToolStatus[]),
    // Re-enabling is allowed because the handler never left the registry; disabling stops
    // invocations, it does not unregister the tool.
    disabled: Object.freeze(["enabled", "deprecated"] as readonly ToolStatus[]),
  });

/** True when a tool may move from `from` to `to`. */
export function isLegalToolStatusTransition(from: ToolStatus, to: ToolStatus): boolean {
  return from === to || (TOOL_STATUS_TRANSITIONS[from]?.includes(to) ?? false);
}

/** How a registry is configured. */
export interface ToolRegistryOptions {
  /** Source of registration timestamps, as UTC ISO 8601. Injectable for tests. */
  readonly clock?: () => string;
  /** Maximum number of registered tools. */
  readonly maxEntries?: number;
}

/** The registry's public surface. */
export interface ToolRegistry {
  /** Number of registered tools. */
  readonly size: number;

  /**
   * Registers a descriptor with the handler that implements it.
   *
   * The handler is verified at registration, not at first call: a tool that cannot be invoked
   * should fail the boot that configured it, not the request that needed it.
   */
  register(input: ToolDescriptorInput, handler: ToolHandler): ToolDescriptor;

  get(toolId: ToolId): ToolDescriptor | null;

  /** Like {@link get}, but throws when the tool is not registered. */
  require(toolId: ToolId): ToolDescriptor;

  has(toolId: ToolId): boolean;

  /** Finds a tool by the name a model is told to call. */
  getByName(name: string): ToolDescriptor | null;

  /** True when a name is taken. */
  hasName(name: string): boolean;

  idForName(name: string): ToolId | null;

  /** Resolves an id or name reference. */
  resolve(reference: ToolReference): ToolDescriptor | null;

  /**
   * Unregisters a tool, freeing its name.
   *
   * A tool identifier is never reused: an audit record quoting `tool_01H...` must keep pointing
   * at the tool that ran, even after the name is registered to a different implementation.
   */
  remove(toolId: ToolId): boolean;

  /** Every descriptor, ordered by name then identifier. */
  list(): readonly ToolDescriptor[];

  /** Descriptors invocable in a given status, in the same order. */
  findByKind(kind: ToolKind): readonly ToolDescriptor[];

  /** Descriptors at least as risky as `minimum`, in the same order. */
  findByRiskLevel(minimum: ToolRiskLevel): readonly ToolDescriptor[];

  /** Descriptors declaring a permission on a resource, in the same order. */
  findByPermissionResource(resource: string): readonly ToolDescriptor[];

  /**
   * The handler for a tool, or `null`.
   *
   * Only the runtime should call this. Everything else wants the descriptor.
   */
  handlerFor(toolId: ToolId): ToolHandler | null;

  /** Like {@link handlerFor}, but throws when the tool is not registered. */
  requireHandler(toolId: ToolId): ToolHandler;

  /** Moves a tool through its lifecycle. */
  setStatus(toolId: ToolId, status: ToolStatus): ToolDescriptor;
}
