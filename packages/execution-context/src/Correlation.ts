/**
 * Correlation and causation propagation.
 *
 * Two different questions, two different identifiers, and confusing them loses data:
 *
 * - **Correlation** asks "which pieces of work belong to the same original request?"
 *   One inbound command mints one correlation identifier, and every execution, child
 *   scope, model call and tool call it causes carries the *same* one. It is inherited,
 *   never regenerated: a child that minted a fresh correlation id would silently detach
 *   itself from the request that caused it, and the audit query for that request would
 *   return a partial tree.
 * - **Causation** asks "what *immediately* caused this?" and, per the platform contract
 *   in `@omnis/types`, a causation reference is always the identifier of a **command or
 *   an event** — the messages that cross a boundary. Internal parentage (an execution
 *   spawning a child execution) is therefore *not* causation; it is carried by
 *   `parentExecutionId` on the context. Widening `asCausationId` to accept execution
 *   identifiers would blur the platform's rule that a causal chain is a chain of
 *   messages, and would make event-sourced replay ambiguous.
 *
 * Both are propagated explicitly here rather than through ambient state, so a context
 * can be built, inspected and serialized without anything being set behind the caller's
 * back.
 */

import type { AiCoreIdentity } from "@omnis/ai-core-types";
import { createAiCoreIdentity } from "@omnis/ai-core-types";
import type {
  CausationId,
  CommandId,
  CorrelationId,
  EventId,
  ExecutionId,
  SpanId,
  TraceId,
} from "@omnis/types";
import { asCausationId, createCorrelationId } from "@omnis/types";
import type { ExecutionContext } from "./ExecutionContext.js";

/** Mints a correlation identifier for a new inbound request. */
export function newCorrelationId(): CorrelationId {
  return createCorrelationId();
}

/**
 * Returns the correlation identifier a child must carry.
 *
 * A separate function rather than an inline field copy, so the inheritance rule has one
 * home and one test: a child *always* inherits, and the only way to start a new
 * correlation is to create a root context without a parent.
 */
export function inheritCorrelation(parent: CorrelationId): CorrelationId {
  return parent;
}

/** Builds a causation reference from the command that caused this work. */
export function causationFromCommand(commandId: CommandId): CausationId {
  return asCausationId(commandId);
}

/** Builds a causation reference from the event that caused this work. */
export function causationFromEvent(eventId: EventId): CausationId {
  return asCausationId(eventId);
}

/** True when a context carries a causation reference, i.e. was caused by a message. */
export function hasCausation(context: ExecutionContext): boolean {
  return context.causationId !== null;
}

/** True when a context is a root: nothing in OMNIS caused it. */
export function isRootContext(context: ExecutionContext): boolean {
  return context.parentExecutionId === null && context.causationId === null;
}

/** The identity triple of a context, as the value AI Core records and events carry. */
export function identityOf(context: ExecutionContext): AiCoreIdentity {
  return createAiCoreIdentity(
    context.executionId,
    context.correlationId,
    context.causationId,
    context.traceId,
    context.parentSpanId,
  );
}

/**
 * The identity of a child execution.
 *
 * Correlation is inherited unchanged; causation is whatever message caused the child, or
 * `null` when the child was spawned internally — in which case `parentExecutionId` on the
 * child context carries the parentage.
 */
export function childIdentity(
  parent: AiCoreIdentity,
  childExecutionId: ExecutionId,
  causationId: CausationId | null = null,
  traceId: TraceId | null = null,
  parentSpanId: SpanId | null = null,
): AiCoreIdentity {
  return createAiCoreIdentity(
    childExecutionId,
    parent.correlationId,
    causationId,
    traceId ?? parent.traceId,
    parentSpanId ?? parent.parentSpanId,
  );
}

/** The chain of executions from a root down to this context, as far as this context knows it. */
export interface LineageRecord {
  readonly executionId: ExecutionId;
  readonly parentExecutionId: ExecutionId | null;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
  readonly depth: number;
}

/** Projects a context onto the fields needed to reconstruct its lineage. */
export function lineageOf(context: ExecutionContext): LineageRecord {
  return Object.freeze({
    executionId: context.executionId,
    parentExecutionId: context.parentExecutionId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    depth: context.depth,
  });
}
