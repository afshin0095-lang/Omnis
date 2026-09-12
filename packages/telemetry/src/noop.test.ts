/**
 * No-op telemetry implementation tests.
 *
 * A no-op performs no measurement, but it is not allowed to accept nonsense: the
 * invariants asserted here are the ones every real backend enforces too, so a
 * measurement bug is caught by this suite instead of surfacing later as a corrupted
 * dashboard or an exhausted metrics backend.
 */

import { ConfigurationError } from "@omnis/errors";
import {
  createCorrelationId,
  createSpanId,
  createTenantId,
  createTraceId,
  parseTrimmedString,
  tryParseIdentifier,
} from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  createNoopMeter,
  createNoopTracer,
  METRIC_UNITS,
  NoopCounter,
  NoopGauge,
  NoopHistogram,
  NoopMeter,
  NOOP_METER,
  NOOP_TRACER,
  NoopSpan,
  NoopTracer,
  NO_SAMPLES,
  SPAN_KINDS,
  SPAN_STATUSES,
  disallowedAttributes,
} from "./index.js";
import type { Meter, SpanContext, StartSpanOptions, Tracer } from "./index.js";

const name = (value: string) => parseTrimmedString(value);

/** Starts a span and narrows it to the concrete no-op type. */
function startNoopSpan(tracer: Tracer, spanName: string, options: StartSpanOptions = {}): NoopSpan {
  const span = tracer.startSpan(name(spanName), options);
  if (!(span instanceof NoopSpan)) {
    throw new Error("createNoopTracer must hand out NoopSpan instances");
  }
  return span;
}

describe("the measurement vocabulary", () => {
  it("offers the standard instrument units", () => {
    expect(METRIC_UNITS).toEqual(["1", "ms", "s", "bytes", "usd", "tokens"]);
  });

  it("offers the W3C-compatible span kinds and statuses", () => {
    expect(SPAN_KINDS).toEqual(["internal", "client", "server", "producer", "consumer"]);
    expect(SPAN_STATUSES).toEqual(["unset", "ok", "error"]);
  });
});

describe("disallowedAttributes", () => {
  it("permits everything when no dimensions were declared", () => {
    expect(disallowedAttributes({ "omnis.tenant.id": "tenant_1" }, undefined)).toEqual([]);
  });

  it("treats an empty declaration as unrestricted, per the instrument contract", () => {
    // `InstrumentOptions.allowedAttributes` documents that the restriction applies
    // "when non-empty", so an empty list declares no restriction rather than forbidding
    // every dimension.
    expect(disallowedAttributes({ "omnis.environment": "test" }, [])).toEqual([]);
  });

  it("names exactly the keys outside the declaration", () => {
    expect(
      disallowedAttributes(
        { "omnis.environment": "test", "omnis.tenant.id": "tenant_1", region: "eu" },
        ["omnis.environment"],
      ),
    ).toEqual(["omnis.tenant.id", "region"]);
  });

  it("permits a fully declared attribute set", () => {
    expect(
      disallowedAttributes({ "omnis.environment": "test", "omnis.actor.kind": "service" }, [
        "omnis.environment",
        "omnis.actor.kind",
      ]),
    ).toEqual([]);
  });
});

describe("NoopMeter", () => {
  const meter: Meter = createNoopMeter(name("content-factory"));

  it("keeps its scope name", () => {
    expect(meter.name).toBe("content-factory");
    expect(meter).toBeInstanceOf(NoopMeter);
  });

  it("hands out one instrument per type, each carrying its own name", () => {
    const counter = meter.createCounter(name("agent.executions"));
    const gauge = meter.createGauge(name("queue.depth"));
    const histogram = meter.createHistogram(name("agent.duration"));

    expect(counter).toBeInstanceOf(NoopCounter);
    expect(gauge).toBeInstanceOf(NoopGauge);
    expect(histogram).toBeInstanceOf(NoopHistogram);
    expect(counter.name).toBe("agent.executions");
    expect(gauge.name).toBe("queue.depth");
    expect(histogram.name).toBe("agent.duration");
  });

  it("hands out independent instruments for the same name", () => {
    // Two call sites measuring the same thing must not share mutable state.
    expect(meter.createCounter(name("agent.executions"))).not.toBe(
      meter.createCounter(name("agent.executions")),
    );
  });
});

describe("NoopCounter", () => {
  const meter = createNoopMeter(name("content-factory"));

  it("accepts a non-negative delta, including zero", () => {
    const counter = meter.createCounter(name("agent.executions"));
    expect(() => counter.add(1)).not.toThrow();
    expect(() => counter.add(0)).not.toThrow();
    expect(() => counter.add(2.5)).not.toThrow();
  });

  it("refuses to go backwards", () => {
    // A counter that can decrease is a gauge, and every rate derived from it is wrong.
    const counter = meter.createCounter(name("agent.executions"));
    expect(() => counter.add(-1)).toThrow(RangeError);
    expect(() => counter.add(-1)).toThrow(/cannot decrease/);
    expect(() => counter.add(-1)).toThrow(/gauge instead/);
  });

  it("refuses a value no backend could store", () => {
    const counter = meter.createCounter(name("agent.executions"));
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => counter.add(value)).toThrow(RangeError);
      expect(() => counter.add(value)).toThrow(/non-finite/);
    }
  });

  it("refuses a value that is not a number at all", () => {
    const counter = meter.createCounter(name("agent.executions"));
    expect(() => counter.add("3" as unknown as number)).toThrow(RangeError);
  });

  it("refuses attributes the instrument never declared", () => {
    const counter = meter.createCounter(name("agent.executions"), {
      allowedAttributes: ["omnis.environment"],
    });
    expect(() => counter.add(1, { "omnis.environment": "test" })).not.toThrow();

    let thrown: unknown = null;
    try {
      counter.add(1, { "omnis.environment": "test", "omnis.tenant.id": "tenant_1" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const failure = thrown as ConfigurationError;
    expect(failure.keys).toEqual(["omnis.tenant.id"]);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("unbounded cardinality");
  });

  it("permits any attributes when it declared none", () => {
    const counter = meter.createCounter(name("agent.executions"));
    expect(() => counter.add(1, { "omnis.tenant.id": "tenant_1" })).not.toThrow();
  });
});

describe("NoopGauge", () => {
  const meter = createNoopMeter(name("publishing"));

  it("accepts values that rise and fall", () => {
    const gauge = meter.createGauge(name("queue.depth"));
    expect(() => gauge.set(12)).not.toThrow();
    expect(() => gauge.set(0)).not.toThrow();
    // Unlike a counter, a gauge may legitimately go negative (an account balance).
    expect(() => gauge.set(-4)).not.toThrow();
  });

  it("refuses a non-finite reading", () => {
    const gauge = meter.createGauge(name("queue.depth"));
    expect(() => gauge.set(Number.NaN)).toThrow(RangeError);
    expect(() => gauge.set(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("refuses undeclared attributes", () => {
    const gauge = meter.createGauge(name("queue.depth"), {
      allowedAttributes: ["omnis.environment"],
    });
    expect(() => gauge.set(1, { platform: "youtube" })).toThrow(ConfigurationError);
  });
});

describe("NoopHistogram", () => {
  const meter = createNoopMeter(name("ai-core"));

  it("records a distribution of observations", () => {
    const histogram = meter.createHistogram(name("agent.duration"), { unit: "ms" });
    expect(() => histogram.record(0)).not.toThrow();
    expect(() => histogram.record(812.4)).not.toThrow();
  });

  it("refuses a non-finite observation", () => {
    // A single NaN in a histogram poisons every percentile computed from it.
    const histogram = meter.createHistogram(name("agent.duration"), { unit: "ms" });
    expect(() => histogram.record(Number.NaN)).toThrow(RangeError);
    expect(() => histogram.record(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it("refuses undeclared attributes", () => {
    const histogram = meter.createHistogram(name("agent.duration"), {
      allowedAttributes: ["omnis.actor.kind"],
    });
    expect(() => histogram.record(10, { "omnis.actor.kind": "agent" })).not.toThrow();
    expect(() => histogram.record(10, { "omnis.correlation.id": "correlation_1" })).toThrow(
      ConfigurationError,
    );
  });
});

describe("NoopSpan lifecycle", () => {
  it("starts open and reports itself ended exactly once", () => {
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    expect(span.ended).toBe(false);
    span.end();
    expect(span.ended).toBe(true);
  });

  it("treats a second end as a no-op", () => {
    // Spans are usually ended in a `finally` that an explicit end may already have
    // reached; throwing there would mask the failure that caused the block to run.
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    span.end();
    expect(() => span.end()).not.toThrow();
    expect(span.ended).toBe(true);
  });

  it("records attributes and events while open", () => {
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    expect(() => span.setAttribute("omnis.model", "gpt-5")).not.toThrow();
    expect(() => span.setAttributes({ "omnis.tokens": 1450, "omnis.cached": false })).not.toThrow();
    expect(() => span.addEvent("retry.scheduled", { attempt: 2 })).not.toThrow();
    expect(span.ended).toBe(false);
  });

  it("refuses an empty attribute key", () => {
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    expect(() => span.setAttribute("", "value")).toThrow(RangeError);
  });

  it("refuses every mutation after the span has ended", () => {
    // A measurement recorded after a span closes is silently dropped by every real
    // backend, so the no-op makes the mistake loud instead.
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    span.end();

    const mutations: ReadonlyArray<[string, () => void]> = [
      ["setAttribute", () => span.setAttribute("omnis.model", "gpt-5")],
      ["setAttributes", () => span.setAttributes({ "omnis.model": "gpt-5" })],
      ["setStatus", () => span.setStatus("ok")],
      ["recordException", () => span.recordException(new Error("late"))],
      ["addEvent", () => span.addEvent("late")],
    ];
    for (const [operation, mutate] of mutations) {
      let thrown: unknown = null;
      try {
        mutate();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, operation).toBeInstanceOf(ConfigurationError);
      const failure = thrown as ConfigurationError;
      expect(failure.message, operation).toContain("already ended");
      expect(failure.retryable, operation).toBe(false);
    }
  });

  it("starts with an unset status and keeps the last one set", () => {
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    expect(span.currentStatus).toBe("unset");
    span.setStatus("ok", "completed within budget");
    expect(span.currentStatus).toBe("ok");
    span.setStatus("error");
    expect(span.currentStatus).toBe("error");
  });

  it("records an exception without failing the span or ending it", () => {
    // A caught-and-handled error is worth recording but must not mark the span broken,
    // otherwise every span that logged anything looks failed.
    const span = startNoopSpan(createNoopTracer(name("ai-core")), "draft.script");
    span.recordException(new Error("retried and recovered"));
    expect(span.currentStatus).toBe("unset");
    expect(span.ended).toBe(false);
  });
});

describe("NoopTracer", () => {
  it("keeps its scope name", () => {
    expect(createNoopTracer(name("audience-intelligence")).name).toBe("audience-intelligence");
  });

  it("starts a root span with a fresh, well-formed trace identity", () => {
    const tracer = createNoopTracer(name("ai-core"));
    const span = startNoopSpan(tracer, "draft.script");

    expect(span.kind).toBe("internal");
    expect(span.context.parentSpanId).toBeNull();
    expect(span.context.correlationId).toBeNull();
    expect(span.context.tenantId).toBeNull();
    expect(tryParseIdentifier("trace", span.context.traceId).ok).toBe(true);
    expect(tryParseIdentifier("span", span.context.spanId).ok).toBe(true);
  });

  it("gives every root span its own trace and every span its own identity", () => {
    const tracer = createNoopTracer(name("ai-core"));
    const first = startNoopSpan(tracer, "draft.script");
    const second = startNoopSpan(tracer, "render.video");

    expect(String(first.context.traceId)).not.toBe(String(second.context.traceId));
    expect(String(first.context.spanId)).not.toBe(String(second.context.spanId));
  });

  it("honours an explicit span kind", () => {
    const tracer = createNoopTracer(name("publishing"));
    expect(startNoopSpan(tracer, "publish", { kind: "client" }).kind).toBe("client");
    expect(startNoopSpan(tracer, "ingest", { kind: "consumer" }).kind).toBe("consumer");
  });

  it("attaches a child to its parent's trace and inherits the business chain", () => {
    // The technical chain and the business chain are propagated together, so a trace
    // can be joined to the events and commands it produced.
    const tracer = createNoopTracer(name("ai-core"));
    const correlationId = createCorrelationId();
    const tenantId = createTenantId();
    const parentContext: SpanContext = {
      traceId: createTraceId(),
      spanId: createSpanId(),
      parentSpanId: null,
      correlationId,
      tenantId,
    };

    const child = startNoopSpan(tracer, "generate.thumbnail", { parent: parentContext });

    expect(String(child.context.traceId)).toBe(String(parentContext.traceId));
    expect(String(child.context.parentSpanId)).toBe(String(parentContext.spanId));
    expect(String(child.context.spanId)).not.toBe(String(parentContext.spanId));
    expect(String(child.context.correlationId)).toBe(String(correlationId));
    expect(String(child.context.tenantId)).toBe(String(tenantId));
  });

  it("applies start-time attributes to the new span", () => {
    const tracer = createNoopTracer(name("ai-core"));
    const span = startNoopSpan(tracer, "draft.script", {
      attributes: { "omnis.environment": "test" },
    });
    expect(span.ended).toBe(false);
  });

  it("rejects a start-time attribute with an empty key", () => {
    const tracer = createNoopTracer(name("ai-core"));
    expect(() => startNoopSpan(tracer, "draft.script", { attributes: { "": "value" } })).toThrow(
      RangeError,
    );
  });

  it("retains started spans for inspection", () => {
    const tracer = createNoopTracer(name("ai-core"));
    if (!(tracer instanceof NoopTracer)) {
      throw new Error("createNoopTracer must hand out a NoopTracer");
    }
    startNoopSpan(tracer, "one");
    startNoopSpan(tracer, "two");
    expect(tracer.spans().map((span) => String(span.name))).toEqual(["one", "two"]);
  });

  it("caps retained spans so a long-running local process cannot leak", () => {
    expect(NoopTracer.RETAINED_SPAN_LIMIT).toBe(500);
    const tracer = createNoopTracer(name("ai-core"));
    if (!(tracer instanceof NoopTracer)) {
      throw new Error("createNoopTracer must hand out a NoopTracer");
    }

    const total = NoopTracer.RETAINED_SPAN_LIMIT + 5;
    for (let index = 0; index < total; index += 1) {
      startNoopSpan(tracer, `span-${index}`);
    }

    expect(tracer.spans()).toHaveLength(NoopTracer.RETAINED_SPAN_LIMIT);
    // The oldest spans are the ones dropped, so what remains is the most recent work.
    expect(String(tracer.spans()[0]?.name)).toBe("span-5");
    expect(String(tracer.spans().at(-1)?.name)).toBe(`span-${total - 1}`);
  });
});

describe("the shared no-op singletons", () => {
  it("scopes them to omnis.noop", () => {
    expect(NOOP_METER.name).toBe("omnis.noop");
    expect(NOOP_TRACER.name).toBe("omnis.noop");
  });

  it("makes them usable without any setup", () => {
    // Code that only needs something to call must not have to construct an instrument
    // or guard against a missing backend.
    expect(() => {
      NOOP_METER.createCounter(name("calls")).add(1);
      NOOP_METER.createGauge(name("depth")).set(3);
      NOOP_METER.createHistogram(name("latency"), { unit: "ms" }).record(12);
      NOOP_TRACER.startSpan(name("work")).end();
    }).not.toThrow();
  });

  it("exposes an empty, frozen sample list", () => {
    expect(NO_SAMPLES).toEqual([]);
    expect(Object.isFrozen(NO_SAMPLES)).toBe(true);
  });
});
