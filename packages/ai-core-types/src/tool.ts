/**
 * Tool contracts.
 *
 * A tool is the only way an OMNIS agent touches the outside world, which makes the
 * tool descriptor a *security document*: what it does, what it is allowed to touch,
 * how dangerous it is, whether it can be undone, whether it needs a human, and how
 * long it may run. Every one of those fields is consumed by a gate — the Policy
 * Engine reads permissions and risk, the Budget Engine reads execution counts, the
 * Tool Runtime reads timeout and cancellation support.
 *
 * The handler type is declared here but *invoked* only by the Tool Runtime. Nothing
 * that holds a descriptor can call it: registration and execution are separate
 * authority boundaries, and collapsing them is how an agent ends up able to run
 * arbitrary code because it could read a registry.
 */

import type { JsonValue } from "@omnis/types";
import type { AiCoreMetadata } from "./constants.js";
import type { BudgetId, ExecutionId, CorrelationId, PolicyId, ToolId } from "./identifiers.js";

/** JSON-Schema subset accepted for tool parameters. */
export const TOOL_PARAMETER_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
] as const;

/** One parameter type. */
export type ToolParameterType = (typeof TOOL_PARAMETER_TYPES)[number];

/** One parameter's declaration. */
export interface ToolParameterSpec {
  readonly type: ToolParameterType;
  readonly description: string;
  /** Allowed values for `string` parameters; empty means unconstrained. */
  readonly enumValues: readonly string[];
  /** Element declaration for `array` parameters, or `null`. */
  readonly items: ToolParameterSpec | null;
  readonly nullable: boolean;
}

/**
 * A closed object schema for tool arguments.
 *
 * `additionalProperties` is not a flag here: schemas are always closed. A tool that
 * accepts unknown keys cannot be permission-checked, because the permission model
 * reasons about declared fields.
 */
export interface ToolParameterSchema {
  readonly kind: "object";
  readonly properties: Readonly<Record<string, ToolParameterSpec>>;
  readonly required: readonly string[];
}

/** Builds a closed parameter schema, validating that every required key is declared. */
export function toolParameterSchema(
  properties: Readonly<Record<string, ToolParameterSpec>>,
  required: readonly string[] = [],
): ToolParameterSchema {
  for (const key of required) {
    if (!(key in properties)) {
      throw new RangeError(`required tool parameter "${key}" is not declared`);
    }
  }
  return Object.freeze({
    kind: "object",
    properties: Object.freeze({ ...properties }),
    required: Object.freeze([...required]),
  });
}

/** A parameterless schema, for tools that take no arguments. */
export const EMPTY_TOOL_PARAMETER_SCHEMA: ToolParameterSchema = toolParameterSchema({});

/** What kind of work a tool performs. */
export const TOOL_KINDS = ["read", "write", "compute", "external"] as const;

/** A tool's kind. */
export type ToolKind = (typeof TOOL_KINDS)[number];

/** How much damage a misuse of the tool can do. Drives approval and policy defaults. */
export const TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/** A tool's risk level. */
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

/** Numeric rank of a risk level, for comparisons. Lower is safer. */
export const TOOL_RISK_RANK: Readonly<Record<ToolRiskLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

/** True when `level` is at least as risky as `minimum`. */
export function isAtLeastRisk(level: ToolRiskLevel, minimum: ToolRiskLevel): boolean {
  return TOOL_RISK_RANK[level] >= TOOL_RISK_RANK[minimum];
}

/** What a tool changes, and whether repeating the call is safe. */
export const TOOL_SIDE_EFFECTS = [
  "none",
  "idempotent_write",
  "non_idempotent_write",
  "external_side_effect",
] as const;

/** A tool's side-effect classification. */
export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[number];

/** True when a tool with this side effect may be retried after an uncertain failure. */
export function isRetryableSideEffect(sideEffect: ToolSideEffect): boolean {
  // A non-idempotent write or an external side effect may already have happened when
  // the call failed; retrying would duplicate it. Uncertainty resolves to "no retry".
  return sideEffect === "none" || sideEffect === "idempotent_write";
}

/** The action half of a permission. */
export const TOOL_PERMISSION_ACTIONS = ["read", "write", "execute", "admin"] as const;

/** A permission action. */
export type ToolPermissionAction = (typeof TOOL_PERMISSION_ACTIONS)[number];

/** A single permission claim: an action on a named resource. */
export interface ToolPermission {
  readonly resource: string;
  readonly action: ToolPermissionAction;
}

/** Renders a permission as `resource:action`, the form used in policies and audit rows. */
export function formatPermission(permission: ToolPermission): string {
  return `${permission.resource}:${permission.action}`;
}

/** Parses `resource:action`, or `null` when the string is not a well-formed permission. */
export function parsePermission(value: string): ToolPermission | null {
  const index = value.lastIndexOf(":");
  if (index <= 0 || index === value.length - 1) {
    return null;
  }
  const action = value.slice(index + 1);
  if (!(TOOL_PERMISSION_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  return Object.freeze({ resource: value.slice(0, index), action: action as ToolPermissionAction });
}

/** Lifecycle status of a registered tool. */
export const TOOL_STATUSES = ["enabled", "disabled", "deprecated"] as const;

/** A tool's registration status. */
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** True when a tool in this status may be invoked. */
export function isInvocableToolStatus(status: ToolStatus): boolean {
  return status === "enabled" || status === "deprecated";
}

/** How a caller may name a tool. */
export type ToolReference =
  | { readonly kind: "id"; readonly toolId: ToolId }
  | { readonly kind: "name"; readonly name: string };

/** Builds a reference by identifier. */
export function toolById(toolId: ToolId): ToolReference {
  return Object.freeze({ kind: "id", toolId });
}

/** Builds a reference by registered name. */
export function toolByName(name: string): ToolReference {
  return Object.freeze({ kind: "name", name });
}

/**
 * True when the value is a well-formed {@link ToolReference}.
 *
 * Tool references arrive from model output, from stored agent descriptors and from API callers.
 * Each of those is a trust boundary, and each would otherwise re-implement this check slightly
 * differently — which is how a malformed reference reaches a registry lookup and turns into a
 * confusing "not found" instead of a rejected request.
 */
export function isToolReference(value: unknown): value is ToolReference {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  if (reference["kind"] === "id") {
    return typeof reference["toolId"] === "string" && reference["toolId"].length > 0;
  }
  if (reference["kind"] === "name") {
    return typeof reference["name"] === "string" && reference["name"].length > 0;
  }
  return false;
}

/**
 * An immutable registered tool description.
 *
 * The handler is *not* part of the descriptor. Descriptors are what gets serialized
 * into audit rows, event payloads and model tool specs; a function cannot be, and a
 * descriptor carrying one could not be compared, hashed or frozen meaningfully.
 */
export interface ToolDescriptor {
  readonly id: ToolId;
  /** Unique registered name — the name a model is told to call. */
  readonly name: string;
  readonly displayName: string;
  /** Model-facing explanation. Written for the model, not for developers. */
  readonly description: string;
  readonly version: string;
  readonly kind: ToolKind;
  readonly riskLevel: ToolRiskLevel;
  readonly sideEffect: ToolSideEffect;
  readonly permissions: readonly ToolPermission[];
  readonly parameters: ToolParameterSchema;
  /** Human/model-readable description of the success payload. */
  readonly resultDescription: string;
  /** Milliseconds after which the Tool Runtime aborts the call. Always finite. */
  readonly timeoutMs: number;
  readonly supportsCancellation: boolean;
  /** Maximum simultaneous invocations. `1` serializes a tool that must not overlap. */
  readonly maxConcurrency: number;
  readonly requiresApproval: boolean;
  /** Policy set evaluated before invocation, or `null` for the runtime default. */
  readonly policyId: PolicyId | null;
  /** Budget charged for invocations, or `null` when the execution's budget covers it. */
  readonly budgetId: BudgetId | null;
  readonly status: ToolStatus;
  readonly metadata: AiCoreMetadata;
  readonly registeredAt: string;
}

/** The environment a handler is given, satisfied structurally by an execution scope. */
export interface ToolExecutionEnvironment {
  readonly executionId: ExecutionId;
  readonly correlationId: CorrelationId;
  /** 1-based attempt number; the first invocation is attempt 1. */
  readonly attempt: number;
  /** True once cancellation has been requested. Handlers must poll this. */
  isCancelled(): boolean;
  /** Milliseconds left on the deadline, or `null` when there is none. */
  remainingMs(): number | null;
}

/** One tool invocation, as handed to a handler. */
export interface ToolInvocation {
  readonly toolId: ToolId;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly environment: ToolExecutionEnvironment;
  readonly metadata: AiCoreMetadata;
}

/** The immutable audit trail of one tool invocation. */
export interface ToolAuditRecord {
  readonly executionId: ExecutionId;
  readonly correlationId: CorrelationId;
  readonly toolId: ToolId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly attempt: number;
  readonly permissionsRequired: readonly string[];
  readonly policyDecisionOutcome: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /**
   * Argument *keys*, never values.
   *
   * Arguments routinely carry credentials, personal data or free text; recording the
   * keys proves what was asked without recording what was asked for.
   */
  readonly argumentKeys: readonly string[];
}

/** A handler's return value before the runtime normalizes it. */
export type ToolHandlerResult =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly message: string;
      readonly retryable?: boolean;
    };

/** A tool implementation. Only the Tool Runtime may call one. */
export type ToolHandler = (
  invocation: ToolInvocation,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

/** The normalized outcome of a tool invocation, including its audit record. */
export type ToolResult =
  | {
      readonly status: "succeeded";
      readonly toolId: ToolId;
      readonly value: JsonValue;
      readonly durationMs: number;
      readonly audit: ToolAuditRecord;
    }
  | {
      readonly status: "failed";
      readonly toolId: ToolId;
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly timedOut: boolean;
      readonly cancelled: boolean;
      readonly durationMs: number;
      readonly audit: ToolAuditRecord;
    }
  | {
      readonly status: "denied";
      readonly toolId: ToolId;
      /** Stable reason: `unregistered`, `permission`, `policy`, `approval_required`, `disabled`, `concurrency`. */
      readonly reason: ToolDenialReason;
      readonly message: string;
      readonly audit: ToolAuditRecord;
    };

/** Why a tool invocation did not run. */
export const TOOL_DENIAL_REASONS = [
  "unregistered",
  "permission",
  "policy",
  "approval_required",
  "disabled",
  "concurrency",
] as const;

/** A tool denial reason. */
export type ToolDenialReason = (typeof TOOL_DENIAL_REASONS)[number];

/** The tool call bound to an agent, with optional per-agent constraint overrides. */
export interface AgentToolBinding {
  readonly toolId: ToolId;
  /** Per-invocation timeout override; `null` keeps the descriptor's value. */
  readonly timeoutMsOverride: number | null;
  /** Maximum calls to this tool within one execution. `0` means unbounded-by-count. */
  readonly maxCallsPerExecution: number;
  readonly required: boolean;
}
