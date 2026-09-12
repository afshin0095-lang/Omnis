/**
 * Telemetry attribute derivation tests.
 *
 * The rules under test are the reason dashboards can be shared between services:
 * one vocabulary of dimension names, derived from the execution context rather than
 * chosen per call site, with identifiers kept off metrics so that a metric's
 * cardinality cannot grow with traffic.
 */

import { parseExecutionContext, serviceActor, SYSTEM_ACTOR } from "@omnis/contracts";
import type { ActorContext, ExecutionContext } from "@omnis/contracts";
import {
  createAgentId,
  createCorrelationId,
  createCausationId,
  createExecutionId,
  createTenantId,
  createUserId,
  createWorkspaceId,
  parseTrimmedString,
} from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  metricAttributesFromContext,
  METRIC_ATTRIBUTE_KEYS,
  spanAttributesFromContext,
  SPAN_ATTRIBUTE_KEYS,
} from "./index.js";

/** A literal promoted to the branded string the contracts expect. */
const trimmed = (value: string) => parseTrimmedString(value);

const TENANT_ID = createTenantId();
const WORKSPACE_ID = createWorkspaceId();
const EXECUTION_ID = createExecutionId();
const CORRELATION_ID = createCorrelationId();
const CAUSATION_ID = createCausationId();

/** Builds a validated execution context, overriding only what a test cares about. */
function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return parseExecutionContext({
    executionId: String(EXECUTION_ID),
    correlationId: String(CORRELATION_ID),
    causationId: null,
    tenant: { tenantId: String(TENANT_ID), workspaceId: null, region: null },
    actor: null,
    environment: "test",
    traceId: null,
    parentSpanId: null,
    deadlineMs: null,
    ...overrides,
  });
}

/** An actor context for a test, built through the contract's own parser. */
function actor(input: unknown): ActorContext {
  const parsed = context({ actor: input as ActorContext });
  if (parsed.actor === null) {
    throw new Error("test actor failed to parse");
  }
  return parsed.actor;
}

describe("spanAttributesFromContext", () => {
  it("always carries the four dimensions every investigation starts from", () => {
    const attributes = spanAttributesFromContext(context());
    expect(attributes[SPAN_ATTRIBUTE_KEYS.environment]).toBe("test");
    expect(attributes[SPAN_ATTRIBUTE_KEYS.tenantId]).toBe(String(TENANT_ID));
    expect(attributes[SPAN_ATTRIBUTE_KEYS.executionId]).toBe(String(EXECUTION_ID));
    expect(attributes[SPAN_ATTRIBUTE_KEYS.correlationId]).toBe(String(CORRELATION_ID));
  });

  it("uses the shared omnis.* vocabulary for every key it emits", () => {
    // A call site inventing its own key name is how one service's dashboard becomes
    // unqueryable from another's.
    const known = new Set<string>(Object.values(SPAN_ATTRIBUTE_KEYS));
    const attributes = spanAttributesFromContext(
      context({
        causationId: CAUSATION_ID,
        tenant: { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, region: trimmed("eu-central") },
        actor: serviceActor(trimmed("content-factory")),
      }),
    );
    for (const key of Object.keys(attributes)) {
      expect(known.has(key), key).toBe(true);
    }
  });

  it("includes the workspace and the causation only when they exist", () => {
    const bare = spanAttributesFromContext(context());
    expect(bare).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.workspaceId);
    expect(bare).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.causationId);

    const scoped = spanAttributesFromContext(
      context({
        causationId: CAUSATION_ID,
        tenant: { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, region: null },
      }),
    );
    expect(scoped[SPAN_ATTRIBUTE_KEYS.workspaceId]).toBe(String(WORKSPACE_ID));
    expect(scoped[SPAN_ATTRIBUTE_KEYS.causationId]).toBe(String(CAUSATION_ID));
  });

  it('never writes the string "null" for an absent value', () => {
    // A string "null" is indistinguishable from a real value in a search UI and turns
    // "missing" into a phantom dimension value.
    const attributes = spanAttributesFromContext(context());
    for (const value of Object.values(attributes)) {
      expect(value).not.toBe("null");
      expect(value).not.toBe("undefined");
    }
  });

  it("emits no actor dimensions when the actor is unknown", () => {
    const attributes = spanAttributesFromContext(context({ actor: null }));
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.actorKind);
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.actorId);
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.service);
  });

  it("attributes a human actor by kind and identifier", () => {
    const userId = createUserId();
    const attributes = spanAttributesFromContext(
      context({
        actor: actor({ kind: "user", id: String(userId), displayName: trimmed("Afshin") }),
      }),
    );
    expect(attributes[SPAN_ATTRIBUTE_KEYS.actorKind]).toBe("user");
    expect(attributes[SPAN_ATTRIBUTE_KEYS.actorId]).toBe(String(userId));
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.service);
  });

  it("attributes an agent actor by kind and identifier", () => {
    const agentId = createAgentId();
    const attributes = spanAttributesFromContext(
      context({
        actor: actor({
          kind: "agent",
          id: String(agentId),
          onBehalfOf: String(createUserId()),
          displayName: "Scriptwriter",
        }),
      }),
    );
    expect(attributes[SPAN_ATTRIBUTE_KEYS.actorKind]).toBe("agent");
    expect(attributes[SPAN_ATTRIBUTE_KEYS.actorId]).toBe(String(agentId));
  });

  it("attributes a service actor by name, not by an identifier it does not have", () => {
    const attributes = spanAttributesFromContext(
      context({ actor: serviceActor(trimmed("content-factory")) }),
    );
    expect(attributes[SPAN_ATTRIBUTE_KEYS.actorKind]).toBe("service");
    expect(attributes[SPAN_ATTRIBUTE_KEYS.service]).toBe("content-factory");
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.actorId);
  });

  it("attributes a system actor by kind alone", () => {
    const attributes = spanAttributesFromContext(context({ actor: SYSTEM_ACTOR }));
    expect(attributes[SPAN_ATTRIBUTE_KEYS.actorKind]).toBe("system");
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.actorId);
    expect(attributes).not.toHaveProperty(SPAN_ATTRIBUTE_KEYS.service);
  });
});

describe("metricAttributesFromContext", () => {
  it("labels a measurement by environment", () => {
    expect(metricAttributesFromContext(context())).toEqual({
      [METRIC_ATTRIBUTE_KEYS.environment]: "test",
    });
  });

  it("never carries an identifier, whatever the context holds", () => {
    // Identifiers on a metric create one time series per value and will exhaust a
    // backend; on a span they are only a search key. This is the rule that keeps the
    // two apart.
    const forbidden = [
      SPAN_ATTRIBUTE_KEYS.tenantId,
      SPAN_ATTRIBUTE_KEYS.workspaceId,
      SPAN_ATTRIBUTE_KEYS.executionId,
      SPAN_ATTRIBUTE_KEYS.correlationId,
      SPAN_ATTRIBUTE_KEYS.causationId,
      SPAN_ATTRIBUTE_KEYS.actorId,
    ];
    const attributes = metricAttributesFromContext(
      context({
        causationId: CAUSATION_ID,
        tenant: { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, region: trimmed("eu-central") },
        actor: actor({
          kind: "agent",
          id: String(createAgentId()),
          onBehalfOf: null,
          displayName: null,
        }),
      }),
    );
    for (const key of forbidden) {
      expect(attributes, key).not.toHaveProperty(key);
    }
    expect(Object.keys(attributes)).toEqual([
      METRIC_ATTRIBUTE_KEYS.environment,
      METRIC_ATTRIBUTE_KEYS.actorKind,
    ]);
  });

  it("allows the actor kind as a dimension but not the actor's identity", () => {
    const userId = createUserId();
    const attributes = metricAttributesFromContext(
      context({ actor: actor({ kind: "user", id: String(userId), displayName: null }) }),
    );
    expect(attributes[METRIC_ATTRIBUTE_KEYS.actorKind]).toBe("user");
    expect(Object.values(attributes)).not.toContain(String(userId));
  });

  it("allows the service name, which is bounded by the number of services", () => {
    const attributes = metricAttributesFromContext(
      context({ actor: serviceActor(trimmed("ai-core")) }),
    );
    expect(attributes).toEqual({
      [METRIC_ATTRIBUTE_KEYS.environment]: "test",
      [METRIC_ATTRIBUTE_KEYS.actorKind]: "service",
      [METRIC_ATTRIBUTE_KEYS.service]: "ai-core",
    });
  });

  it("emits no actor dimension for a system actor beyond its kind", () => {
    expect(metricAttributesFromContext(context({ actor: SYSTEM_ACTOR }))).toEqual({
      [METRIC_ATTRIBUTE_KEYS.environment]: "test",
      [METRIC_ATTRIBUTE_KEYS.actorKind]: "system",
    });
  });
});

describe("the two vocabularies agree", () => {
  it("uses the same key name for a dimension on spans and on metrics", () => {
    // One vocabulary is the point: a dimension named differently on a metric and on a
    // span cannot be joined in an investigation.
    expect(METRIC_ATTRIBUTE_KEYS.environment).toBe(SPAN_ATTRIBUTE_KEYS.environment);
    expect(METRIC_ATTRIBUTE_KEYS.actorKind).toBe(SPAN_ATTRIBUTE_KEYS.actorKind);
    expect(METRIC_ATTRIBUTE_KEYS.service).toBe(SPAN_ATTRIBUTE_KEYS.service);
  });

  it("restricts metric keys to a subset of the span keys", () => {
    const spanKeys = new Set<string>(Object.values(SPAN_ATTRIBUTE_KEYS));
    for (const key of Object.values(METRIC_ATTRIBUTE_KEYS)) {
      expect(spanKeys.has(key), key).toBe(true);
    }
  });

  it("derives the shared dimensions identically from the same context", () => {
    const source = context({ actor: serviceActor(trimmed("publishing")) });
    const spans = spanAttributesFromContext(source);
    const metrics = metricAttributesFromContext(source);
    for (const [key, value] of Object.entries(metrics)) {
      expect(spans[key], key).toBe(value);
    }
  });

  it("labels a metric with a causation identifier only through the span vocabulary", () => {
    // Concretely: the value a metric must never carry is exactly the value a span must.
    const source = context({ causationId: createCausationId() });
    const spans = spanAttributesFromContext(source);
    const metrics = metricAttributesFromContext(source);
    expect(spans[SPAN_ATTRIBUTE_KEYS.causationId]).toBeDefined();
    expect(Object.values(metrics)).not.toContain(spans[SPAN_ATTRIBUTE_KEYS.causationId]);
  });
});
