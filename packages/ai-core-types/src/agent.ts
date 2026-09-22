/**
 * Agent contracts.
 *
 * An agent in OMNIS is an *executable unit with governance attached*, not a prompt
 * template. The descriptor below bundles the five things that decide what a run may
 * do: identity, instructions, capabilities, tools and the policy/budget/limit set that
 * bounds them. Keeping them in one immutable record is what makes "which agent did
 * this, under which rules, with which tools, against which budget" answerable from a
 * single audit row.
 *
 * State names are declared here; the transition table and its enforcement live in
 * `@omnis/agent-runtime`. A type package that also enforced transitions would need a
 * runtime, and a runtime that also declared the vocabulary would be untestable in
 * isolation.
 */

import type { AgentId, BudgetId, ExecutionId, PolicyId, ToolId } from "./identifiers.js";
import { MAX_REQUEST_TOOLS, type AiCoreMetadata } from "./constants.js";
import type { ModelReference } from "./model.js";
import type { AgentToolBinding, ToolRiskLevel } from "./tool.js";

/** The kind of control loop an agent implements. */
export const AGENT_KINDS = [
  "autonomous",
  "reactive",
  "planner",
  "worker",
  "router",
  "evaluator",
  "custom",
] as const;

/** An agent kind. */
export type AgentKind = (typeof AGENT_KINDS)[number];

/** What an agent is able to do. Distinct from model capabilities: these are runtime behaviors. */
export const AGENT_CAPABILITIES = [
  "planning",
  "tool_use",
  "multi_turn",
  "streaming",
  "memory",
  "delegation",
  "self_evaluation",
  "approval_escalation",
] as const;

/** One agent capability. */
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** True when the value names an agent capability. */
export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Agent lifecycle states.
 *
 * `waiting` and `paused` are distinct: `waiting` is the agent blocked on something it
 * asked for (a tool result, an approval), while `paused` is an operator or the runtime
 * suspending it from outside. Merging them would make "resume" ambiguous — one resumes
 * by delivering a result, the other by an explicit command.
 */
export const AGENT_STATES = [
  "created",
  "ready",
  "planning",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

/** One agent lifecycle state. */
export type AgentStateName = (typeof AGENT_STATES)[number];

/** States from which no further transition is possible. */
export const TERMINAL_AGENT_STATES: readonly AgentStateName[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
]);

/** True when the agent can no longer change state. */
export function isTerminalAgentState(state: AgentStateName): boolean {
  return (TERMINAL_AGENT_STATES as readonly string[]).includes(state);
}

/** True when the agent is doing or awaiting work, and therefore consuming budget. */
export function isActiveAgentState(state: AgentStateName): boolean {
  return state === "planning" || state === "running" || state === "waiting";
}

/** Registration status of an agent descriptor. */
export const AGENT_STATUSES = ["draft", "active", "disabled", "retired"] as const;

/** An agent descriptor's status. */
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** True when an agent in this status may be executed. */
export function isExecutableAgentStatus(status: AgentStatus): boolean {
  return status === "active";
}

/** How a caller may name an agent. */
export type AgentReference =
  | { readonly kind: "id"; readonly agentId: AgentId }
  | { readonly kind: "slug"; readonly slug: string };

/** Builds an agent reference by identifier. */
export function agentById(agentId: AgentId): AgentReference {
  return Object.freeze({ kind: "id", agentId });
}

/** Builds an agent reference by slug. */
export function agentBySlug(slug: string): AgentReference {
  return Object.freeze({ kind: "slug", slug });
}

/** A stable rendering of a reference, safe to log and to use as a map key. */
export function describeAgentReference(reference: AgentReference): string {
  return reference.kind === "id" ? `id:${reference.agentId}` : `slug:${reference.slug}`;
}

/** The instructions an agent runs with. */
export interface AgentInstructions {
  /** The agent's own operating instructions, sent as a system message. */
  readonly system: string;
  /** Operator-level instructions that outrank user input, sent as a developer message. `null` when unused. */
  readonly developer: string | null;
  /**
   * Hard prohibitions.
   *
   * Rendered into the prompt *and* checked by policy where a prohibition is
   * mechanically checkable. A prohibition that only exists in prose is a request, not
   * a control; the policy set is the control.
   */
  readonly prohibitions: readonly string[];
}

/** The memory kinds an agent may reference. Sprint 1 stores references only — the memory subsystem is a later sprint. */
export const AGENT_MEMORY_KINDS = ["short_term", "long_term", "episodic", "semantic"] as const;

/** One memory kind. */
export type AgentMemoryKind = (typeof AGENT_MEMORY_KINDS)[number];

/** A reference to a memory store. No store implementation is implied. */
export interface AgentMemoryReference {
  readonly kind: AgentMemoryKind;
  /** Identifier of the backing store, interpreted by whoever implements memory. */
  readonly storeId: string;
  /** Namespace within the store, e.g. one character or one tenant. */
  readonly scope: string | null;
  /** True when the agent may write to this store, false for read-only recall. */
  readonly writable: boolean;
}

/** Per-agent resource ceilings. All integers; `null` means "inherit the runtime default". */
export interface AgentRuntimeConstraints {
  readonly maxSteps: number | null;
  readonly maxModelCalls: number | null;
  readonly maxToolCalls: number | null;
  readonly maxDurationMs: number | null;
  /** Integer micro-USD, or `null` when the agent has no cost ceiling of its own. */
  readonly maxCostMicroUsd: number | null;
  readonly maxRetriesPerStep: number | null;
  /** Tool ids this agent may call. Empty means "any registered tool its policy allows". */
  readonly allowedTools: ToolIdList;
  readonly deniedTools: ToolIdList;
  /** Risk levels that require human approval for this agent, regardless of the tool descriptor. */
  readonly approvalRequiredAtRisk: readonly ToolRiskLevel[];
  /** Model preferences, most preferred first. */
  readonly preferredModels: readonly ModelReference[];
}

/** A list of tool identifiers. */
export type ToolIdList = readonly ToolId[];

/** Constraints that impose nothing, so a runtime default applies everywhere. */
export const UNCONSTRAINED_AGENT: AgentRuntimeConstraints = Object.freeze({
  maxSteps: null,
  maxModelCalls: null,
  maxToolCalls: null,
  maxDurationMs: null,
  maxCostMicroUsd: null,
  maxRetriesPerStep: null,
  allowedTools: Object.freeze([]),
  deniedTools: Object.freeze([]),
  approvalRequiredAtRisk: Object.freeze([]),
  preferredModels: Object.freeze([]),
});

/** An immutable, registered agent description. */
export interface AgentDescriptor {
  readonly id: AgentId;
  /** Stable slug, unique within a registry. Configs and API callers use this. */
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: AgentKind;
  readonly status: AgentStatus;
  readonly version: string;
  readonly capabilities: readonly AgentCapability[];
  readonly instructions: AgentInstructions;
  /** Model used when the agent does not choose one. `null` means the runtime default. */
  readonly defaultModel: ModelReference | null;
  readonly tools: readonly AgentToolBinding[];
  readonly memory: readonly AgentMemoryReference[];
  readonly constraints: AgentRuntimeConstraints;
  readonly policyId: PolicyId | null;
  readonly budgetId: BudgetId | null;
  readonly metadata: AiCoreMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Asserts an agent descriptor's tool bindings are within the declared limit. */
export function assertAgentDescriptorShape(descriptor: AgentDescriptor): void {
  if (descriptor.tools.length > MAX_REQUEST_TOOLS) {
    throw new RangeError(
      `agent "${descriptor.slug}" binds ${String(descriptor.tools.length)} tools, the maximum is ${MAX_REQUEST_TOOLS}`,
    );
  }
  const seen = new Set<string>();
  for (const binding of descriptor.tools) {
    if (seen.has(binding.toolId)) {
      throw new RangeError(
        `agent "${descriptor.slug}" binds tool ${binding.toolId} more than once`,
      );
    }
    seen.add(binding.toolId);
  }
}

/** The tool identifiers bound to an agent, in binding order. */
export function agentToolIds(descriptor: AgentDescriptor): ToolIdList {
  return Object.freeze(descriptor.tools.map((binding) => binding.toolId));
}

/** The binding for one tool, or `null` when the agent does not bind it. */
export function agentToolBinding(
  descriptor: AgentDescriptor,
  toolId: ToolId,
): AgentToolBinding | null {
  return descriptor.tools.find((binding) => binding.toolId === toolId) ?? null;
}

/** One running agent: a descriptor plus the mutable-progress facts of a single run. */
export interface AgentInstance {
  readonly agentId: AgentId;
  readonly executionId: ExecutionId | null;
  readonly state: AgentStateName;
  /** Descriptor version the instance was created from; recorded for reproducibility. */
  readonly descriptorVersion: string;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** State the agent is waiting on, when `state` is `waiting`. */
  readonly waitingOn: "tool_result" | "approval" | "model_response" | null;
  readonly metadata: AiCoreMetadata;
}
