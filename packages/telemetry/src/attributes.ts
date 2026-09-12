/**
 * Deriving telemetry attributes from an execution context.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every span and metric that OMNIS emits should be sliceable by the same small
 * set of dimensions: which tenant, which environment, which execution, which
 * correlation chain, which actor kind. If each call site picks its own attribute
 * names, dashboards cannot be shared between services and a cross-domain
 * investigation needs a different query per service.
 *
 * Deriving them from {@link ExecutionContext} in one place means the dimension
 * names are identical everywhere, and adding a dimension is a one-line change
 * rather than a sweep through every service.
 *
 * CARDINALITY
 * -----------
 * The chosen dimensions are deliberately few and low-cardinality *per query*.
 * `tenantId`, `correlationId` and `executionId` are high-cardinality in absolute
 * terms and must therefore be treated as **span attributes**, not as metric
 * labels: on a span they are a search key, on a metric they create a new time
 * series per value and will exhaust a backend. {@link metricAttributesFromContext}
 * returns only the low-cardinality subset for exactly that reason.
 */

import type { ExecutionContext } from "@omnis/contracts";
import type { TelemetryAttributes } from "./metrics.js";

/** Attribute keys used on spans. */
export const SPAN_ATTRIBUTE_KEYS = {
  tenantId: "omnis.tenant.id",
  workspaceId: "omnis.workspace.id",
  executionId: "omnis.execution.id",
  correlationId: "omnis.correlation.id",
  causationId: "omnis.causation.id",
  environment: "omnis.environment",
  actorKind: "omnis.actor.kind",
  actorId: "omnis.actor.id",
  service: "omnis.service",
} as const;

/**
 * Attribute keys safe to use as **metric** labels.
 *
 * Only dimensions whose distinct-value count stays bounded as the system grows.
 * Identifiers are excluded on purpose — see the cardinality note above.
 */
export const METRIC_ATTRIBUTE_KEYS = {
  environment: "omnis.environment",
  actorKind: "omnis.actor.kind",
  service: "omnis.service",
} as const;

/**
 * Full span attributes for an execution context.
 *
 * Absent values are omitted rather than written as `"null"`, because a string
 * `"null"` is indistinguishable from a real value in a search UI and turns
 * "missing" into a phantom dimension value.
 */
export function spanAttributesFromContext(context: ExecutionContext): TelemetryAttributes {
  const attributes: Record<string, string> = {
    [SPAN_ATTRIBUTE_KEYS.environment]: context.environment,
    [SPAN_ATTRIBUTE_KEYS.tenantId]: String(context.tenant.tenantId),
    [SPAN_ATTRIBUTE_KEYS.executionId]: String(context.executionId),
    [SPAN_ATTRIBUTE_KEYS.correlationId]: String(context.correlationId),
  };

  if (context.tenant.workspaceId !== null) {
    attributes[SPAN_ATTRIBUTE_KEYS.workspaceId] = String(context.tenant.workspaceId);
  }
  if (context.causationId !== null) {
    attributes[SPAN_ATTRIBUTE_KEYS.causationId] = String(context.causationId);
  }
  if (context.actor !== null) {
    attributes[SPAN_ATTRIBUTE_KEYS.actorKind] = context.actor.kind;
    if (context.actor.kind === "user" || context.actor.kind === "agent") {
      attributes[SPAN_ATTRIBUTE_KEYS.actorId] = String(context.actor.id);
    }
    if (context.actor.kind === "service") {
      attributes[SPAN_ATTRIBUTE_KEYS.service] = String(context.actor.name);
    }
  }

  return attributes;
}

/**
 * Bounded metric labels for an execution context.
 *
 * Safe to attach to a counter, gauge or histogram without risking cardinality
 * growth proportional to traffic.
 */
export function metricAttributesFromContext(context: ExecutionContext): TelemetryAttributes {
  const attributes: Record<string, string> = {
    [METRIC_ATTRIBUTE_KEYS.environment]: context.environment,
  };
  if (context.actor !== null) {
    attributes[METRIC_ATTRIBUTE_KEYS.actorKind] = context.actor.kind;
    if (context.actor.kind === "service") {
      attributes[METRIC_ATTRIBUTE_KEYS.service] = String(context.actor.name);
    }
  }
  return attributes;
}
