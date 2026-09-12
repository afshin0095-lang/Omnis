/**
 * Log context and the structured log record.
 *
 * WHY A FIXED CONTEXT SHAPE
 * -------------------------
 * §15 of the OMNIS architecture requires that every serious subsystem emit
 * correlation identifiers consistently. If each service invents its own field
 * names — `tenant` here, `tenantId` there, `trace_id` somewhere else — then no
 * query can span services, and an incident that crosses two domains becomes two
 * unrelated investigations.
 *
 * These fields are therefore fixed and named exactly as they are on the event
 * envelope, so a log line and an event can be joined on the same identifiers
 * without a mapping table.
 *
 * Everything is optional except the message: a startup log line legitimately has
 * no tenant, and a background job legitimately has no actor. Forcing empty values
 * into those slots would make logs noisy and, worse, would make a placeholder
 * indistinguishable from a real identifier.
 *
 * Free-form data goes in `attributes`, not in new top-level fields. That keeps
 * the joinable set small and stable while leaving room for anything a service
 * needs to say.
 */

import type { JsonObject } from "@omnis/types";
import type {
  AgentId,
  CausationId,
  CharacterId,
  ContentId,
  CorrelationId,
  EnvironmentName,
  ExecutionId,
  LogLevel,
  TenantId,
  TrimmedString,
  UtcTimestamp,
} from "@omnis/types";

/** Identifiers and scopes attached to a log call. */
export type LogContext = {
  /** Logical service name, e.g. `content-factory`. */
  readonly service?: TrimmedString;
  readonly environment?: EnvironmentName;
  readonly executionId?: ExecutionId;
  readonly correlationId?: CorrelationId;
  readonly causationId?: CausationId;
  readonly tenantId?: TenantId;
  /**
   * The acting principal, as a single opaque reference.
   *
   * A string rather than the full `ActorContext` because a log line needs to
   * *find* the actor, not describe it; the discriminated union lives on the event
   * envelope where it is actually reasoned about.
   */
  readonly actorId?: string;
  readonly characterId?: CharacterId;
  readonly agentId?: AgentId;
  readonly contentId?: ContentId;
  /**
   * The error being logged, if any.
   *
   * Kept as `unknown` so a caught value of any provenance can be passed straight
   * in; the logger serializes it through the OMNIS error hierarchy, which redacts
   * it on the way out.
   */
  readonly error?: unknown;
  /** Free-form, JSON-safe data specific to this log call. */
  readonly attributes?: JsonObject;
};

/** A fully-resolved, serializable log record. */
export type LogRecord = {
  readonly timestamp: UtcTimestamp;
  readonly level: LogLevel;
  readonly message: string;
  readonly service: TrimmedString | null;
  readonly environment: EnvironmentName | null;
  readonly executionId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly characterId: string | null;
  readonly agentId: string | null;
  readonly contentId: string | null;
  /** Caller-supplied attributes, redacted. */
  readonly attributes: JsonObject;
  /** The serialized error, or `null` when the record is not about a failure. */
  readonly error: JsonObject | null;
};

/**
 * Merges two contexts, with `overlay` winning field by field.
 *
 * This is what makes `logger.child({...})` work: bindings established once for a
 * request are carried into every subsequent call without each call site repeating
 * them, and a specific call can still override one of them.
 *
 * Merging is explicit rather than a spread, so adding a field to
 * {@link LogContext} produces a compile error here until the merge is updated. A
 * spread would silently drop or mis-inherit a new field — the kind of bug that
 * shows up as missing correlation IDs in production logs and nothing else.
 *
 * A field absent from the overlay inherits from the base. There is no way to
 * erase an inherited field, which is deliberate: `LogContext` fields are all
 * optional and non-nullable, so "not set" and "explicitly cleared" are the same
 * state, and inventing a sentinel to distinguish them would add a way to be wrong.
 */
export function mergeLogContext(base: LogContext, overlay: LogContext): LogContext {
  return {
    service: overlay.service ?? base.service,
    environment: overlay.environment ?? base.environment,
    executionId: overlay.executionId ?? base.executionId,
    correlationId: overlay.correlationId ?? base.correlationId,
    causationId: overlay.causationId ?? base.causationId,
    tenantId: overlay.tenantId ?? base.tenantId,
    actorId: overlay.actorId ?? base.actorId,
    characterId: overlay.characterId ?? base.characterId,
    agentId: overlay.agentId ?? base.agentId,
    contentId: overlay.contentId ?? base.contentId,
    error: overlay.error ?? base.error,
    attributes: mergeAttributes(base.attributes, overlay.attributes),
  };
}

/** Merges two attribute bags, or returns `undefined` when both are empty. */
function mergeAttributes(
  base: JsonObject | undefined,
  overlay: JsonObject | undefined,
): JsonObject | undefined {
  if (base === undefined && overlay === undefined) {
    return undefined;
  }
  return { ...base, ...overlay };
}
