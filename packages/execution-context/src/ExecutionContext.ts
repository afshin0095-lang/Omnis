/**
 * The execution context.
 *
 * One immutable value carrying everything an execution needs to know about itself: who
 * it is, what caused it, how long it has, whether it has been cancelled, how urgent it
 * is, and what it may be logged with.
 *
 * It is passed **explicitly**. No async-local storage, no module-level "current
 * context", no context hidden inside a closure. Ambient context is how an execution ends
 * up charging the wrong budget, correlating with the wrong request, or surviving a
 * cancellation it should have honored — and it cannot be unit-tested without running the
 * code that sets it up.
 *
 * The value is frozen at construction, and the only mutable things reachable from it are
 * the cancellation token (whose state changes are the point) and nothing else. In
 * particular `metadata` is a frozen, sanitized, *copied* bag, so a child scope's
 * annotations cannot appear on its parent.
 */

import type { AiCoreMetadata } from "@omnis/ai-core-types";
import type {
  AgentId,
  CausationId,
  CorrelationId,
  ExecutionId,
  SpanId,
  TenantId,
  TraceId,
} from "@omnis/ai-core-types";
import type { ExecutionMode, ExecutionPriority } from "@omnis/ai-core-types";
import type { CancellationToken } from "./Cancellation.js";
import { boundDeadline, isExpired, remainingMs, type Deadline } from "./Deadline.js";

/** The immutable identity, timing and governance envelope of one execution. */
export interface ExecutionContext {
  readonly executionId: ExecutionId;
  /** Inherited unchanged by every child scope. */
  readonly correlationId: CorrelationId;
  /** The command or event that caused this execution, or `null` for internally-spawned work. */
  readonly causationId: CausationId | null;
  /** The execution that spawned this one, or `null` for a root. */
  readonly parentExecutionId: ExecutionId | null;
  readonly tenantId: TenantId | null;
  readonly agentId: AgentId | null;
  /** The inbound API request identifier, when this execution serves one. */
  readonly requestId: string | null;
  readonly traceId: TraceId | null;
  /** Span this execution reports under, or `null` when no span was started. */
  readonly parentSpanId: SpanId | null;
  /** ISO 8601 timestamp, for records and events. */
  readonly startedAt: string;
  /** The same instant in epoch milliseconds, for arithmetic. */
  readonly startedAtMs: number;
  /** Absolute deadline, or `null` when the execution is unbounded. */
  readonly deadline: Deadline | null;
  readonly cancellation: CancellationToken;
  readonly priority: ExecutionPriority;
  readonly mode: ExecutionMode;
  /** Nesting depth: `0` for a root context, `parent.depth + 1` for a child scope. */
  readonly depth: number;
  /** Sanitized, frozen, JSON-safe metadata. */
  readonly metadata: AiCoreMetadata;
}

/** Milliseconds left on the context deadline, or `null` when unbounded. */
export function contextRemainingMs(context: ExecutionContext, nowMs: number): number | null {
  return remainingMs(context.deadline, nowMs);
}

/** True when the context deadline has passed. */
export function isContextExpired(context: ExecutionContext, nowMs: number): boolean {
  return isExpired(context.deadline, nowMs);
}

/** True when the context can no longer be used: cancelled or past its deadline. */
export function isContextUnusable(context: ExecutionContext, nowMs: number): boolean {
  return context.cancellation.cancelled || isContextExpired(context, nowMs);
}

/**
 * The deadline a child of this context may have.
 *
 * A child can shorten the allowance, never extend it: without this bound, a deep call
 * tree would each add its own timeout and the root execution would run for the sum of
 * them, long after its own deadline passed.
 */
export function childDeadline(
  context: ExecutionContext,
  requested: Deadline | null,
): Deadline | null {
  return boundDeadline(context.deadline, requested);
}

/** A log-safe one-line description. Identifiers only, never metadata values. */
export function describeContext(context: ExecutionContext): string {
  const parts = [
    `execution=${context.executionId}`,
    `correlation=${context.correlationId}`,
    `depth=${String(context.depth)}`,
    `mode=${context.mode}`,
    `priority=${context.priority}`,
    context.agentId === null ? null : `agent=${context.agentId}`,
    context.tenantId === null ? null : `tenant=${context.tenantId}`,
    context.deadline === null
      ? "deadline=none"
      : `deadline=${String(context.deadline.durationMs)}ms`,
    context.cancellation.cancelled ? "cancelled=true" : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" ");
}

/** The context fields that identify it in telemetry, as a flat JSON-safe object. */
export function contextTelemetryAttributes(
  context: ExecutionContext,
): Readonly<Record<string, string | number | boolean>> {
  return Object.freeze({
    "omnis.ai.execution.id": context.executionId,
    "omnis.ai.execution.mode": context.mode,
    "omnis.ai.execution.priority": context.priority,
    "omnis.ai.execution.depth": context.depth,
    "omnis.ai.correlation.id": context.correlationId,
    "omnis.ai.agent.id": context.agentId ?? "",
    "omnis.ai.tenant.id": context.tenantId ?? "",
    "omnis.ai.execution.cancelled": context.cancellation.cancelled,
    "omnis.ai.execution.has_deadline": context.deadline !== null,
  });
}

/**
 * The span a context reports under, in the shape a tracer's `parent` option takes.
 *
 * `undefined` when the context carries no trace, which is the honest answer for work
 * started outside one: a tracer given a half-known parent would either mint a second trace
 * for the same run or attach it to a span nobody opened.
 *
 * Defined here rather than in each package that opens a span, because the kernel, the model
 * orchestrator and the tool runtime all need the same answer, and three copies of this rule
 * is three ways for one run to become three traces. The return type is structural, so this
 * package still does not depend on the telemetry one.
 */
export interface SpanParent {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId: null;
  readonly correlationId: CorrelationId | null;
  readonly tenantId: TenantId | null;
}

/** The span parent a context implies, or `undefined` when it is not part of a trace. */
export function spanParentOf(context: ExecutionContext): SpanParent | undefined {
  if (context.traceId === null || context.parentSpanId === null) {
    return undefined;
  }
  return Object.freeze({
    traceId: context.traceId,
    spanId: context.parentSpanId,
    parentSpanId: null,
    correlationId: context.correlationId,
    tenantId: context.tenantId,
  });
}
