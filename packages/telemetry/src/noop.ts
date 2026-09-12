/**
 * Deterministic no-op telemetry.
 *
 * These implementations are the sanctioned "fake" of Sprint 0 (§46): they perform
 * no measurement and report nothing, which is exactly what they claim to do. They
 * exist so that local development and tests can run the full platform without a
 * metrics or tracing backend, and so that a real backend can be introduced later
 * by supplying different implementations of the same interfaces.
 *
 * WHAT THEY STILL ENFORCE
 * -----------------------
 * A no-op is not an excuse to accept nonsense. These implementations validate the
 * invariants that every real backend will also enforce — a counter cannot go
 * backwards, a histogram cannot record `NaN`, a span cannot be ended twice and
 * then mutated. Enforcing them here means a bug in measurement code is caught by
 * the test suite rather than surfacing months later as corrupted dashboards, and
 * it means swapping in a real vendor cannot reveal new failures.
 */

import { ConfigurationError } from "@omnis/errors";
import type { JsonValue, TrimmedString } from "@omnis/types";
import { createSpanId, createTraceId, parseTrimmedString } from "@omnis/types";
import type {
  Counter,
  Gauge,
  Histogram,
  InstrumentOptions,
  Meter,
  MetricSample,
  TelemetryAttributes,
} from "./metrics.js";
import { disallowedAttributes } from "./metrics.js";
import type {
  Span,
  SpanContext,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from "./tracing.js";

/** Rejects a value that no backend could store meaningfully. */
function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`Metric "${String(name)}" received a non-finite value: ${String(value)}`);
  }
}

/** Rejects attributes outside an instrument's declared dimensions. */
function assertAttributes(
  name: TrimmedString,
  options: InstrumentOptions | undefined,
  attributes: TelemetryAttributes | undefined,
): void {
  if (attributes === undefined || options?.allowedAttributes === undefined) {
    return;
  }
  const disallowed = disallowedAttributes(attributes, options.allowedAttributes);
  if (disallowed.length > 0) {
    throw new ConfigurationError(
      `Metric "${String(name)}" was given undeclared attributes: ${disallowed.join(", ")}. ` +
        `Declare them in allowedAttributes or remove them; undeclared dimensions cause ` +
        `unbounded cardinality in a real backend.`,
      { keys: disallowed, retryable: false },
    );
  }
}

/** Base for the no-op instruments: holds identity and performs validation. */
abstract class NoopInstrument {
  readonly name: TrimmedString;
  protected readonly options: InstrumentOptions | undefined;

  constructor(name: TrimmedString, options?: InstrumentOptions) {
    this.name = name;
    this.options = options;
  }

  protected check(value: number, attributes: TelemetryAttributes | undefined): void {
    assertFinite(this.name, value);
    assertAttributes(this.name, this.options, attributes);
  }
}

/** A counter that validates and discards. */
export class NoopCounter extends NoopInstrument implements Counter {
  add(value: number, attributes?: TelemetryAttributes): void {
    // Finiteness is checked before the sign so that `-Infinity` is reported as the
    // broken measurement it is, rather than as a decrease.
    assertFinite(this.name, value);
    // A negative delta would make every rate derived from this counter wrong.
    // Refusing it here means the mistake is caught in a test, not in a dashboard.
    if (value < 0) {
      throw new RangeError(
        `Counter "${String(this.name)}" cannot decrease; received ${value}. Use a gauge instead.`,
      );
    }
    this.check(value, attributes);
  }
}

/** A gauge that validates and discards. */
export class NoopGauge extends NoopInstrument implements Gauge {
  set(value: number, attributes?: TelemetryAttributes): void {
    this.check(value, attributes);
  }
}

/** A histogram that validates and discards. */
export class NoopHistogram extends NoopInstrument implements Histogram {
  record(value: number, attributes?: TelemetryAttributes): void {
    this.check(value, attributes);
  }
}

/** A meter that hands out validating no-op instruments. */
export class NoopMeter implements Meter {
  readonly name: TrimmedString;

  constructor(name: TrimmedString) {
    this.name = name;
  }

  createCounter(name: TrimmedString, options?: InstrumentOptions): Counter {
    return new NoopCounter(name, options);
  }

  createGauge(name: TrimmedString, options?: InstrumentOptions): Gauge {
    return new NoopGauge(name, options);
  }

  createHistogram(name: TrimmedString, options?: InstrumentOptions): Histogram {
    return new NoopHistogram(name, options);
  }
}

/** A span that validates lifecycle rules and discards everything else. */
export class NoopSpan implements Span {
  readonly name: TrimmedString;
  readonly kind: SpanKind;
  readonly context: SpanContext;

  private finished = false;
  private status: SpanStatus = "unset";

  constructor(name: TrimmedString, kind: SpanKind, context: SpanContext) {
    this.name = name;
    this.kind = kind;
    this.context = context;
  }

  get ended(): boolean {
    return this.finished;
  }

  /** The status last set on this span, exposed for test assertions. */
  get currentStatus(): SpanStatus {
    return this.status;
  }

  setAttribute(key: string, _value: JsonValue): void {
    this.assertOpen("setAttribute");
    if (key.length === 0) {
      throw new RangeError("Span attribute key must not be empty");
    }
  }

  setAttributes(attributes: TelemetryAttributes): void {
    this.assertOpen("setAttributes");
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }
  }

  setStatus(status: SpanStatus, _message?: string): void {
    this.assertOpen("setStatus");
    this.status = status;
  }

  recordException(_error: unknown): void {
    this.assertOpen("recordException");
  }

  addEvent(_name: string, _attributes?: TelemetryAttributes): void {
    this.assertOpen("addEvent");
  }

  end(): void {
    // Idempotent by contract: a span ended in a `finally` block must not throw
    // and mask the failure that caused the block to run.
    this.finished = true;
  }

  private assertOpen(operation: string): void {
    if (this.finished) {
      throw new ConfigurationError(
        `Span "${String(this.name)}" was already ended; ${operation} is not permitted afterwards. ` +
          `A measurement recorded after a span closes is silently lost in every real backend.`,
        { retryable: false },
      );
    }
  }
}

/**
 * A tracer that starts validating no-op spans.
 *
 * Retained spans are capped, because a no-op tracer is used in long-running local
 * processes and an unbounded array of finished spans would be a slow memory leak
 * in exactly the environment least likely to notice one.
 */
export class NoopTracer implements Tracer {
  /** Upper bound on retained spans. */
  static readonly RETAINED_SPAN_LIMIT = 500;

  readonly name: TrimmedString;
  private readonly started: NoopSpan[] = [];

  constructor(name: TrimmedString) {
    this.name = name;
  }

  startSpan(name: TrimmedString, options: StartSpanOptions = {}): Span {
    const parent = options.parent;
    const context: SpanContext = {
      traceId: parent?.traceId ?? createTraceId(),
      spanId: createSpanId(),
      parentSpanId: parent?.spanId ?? null,
      correlationId: parent?.correlationId ?? null,
      tenantId: parent?.tenantId ?? null,
    };
    const span = new NoopSpan(name, options.kind ?? "internal", context);
    if (options.attributes !== undefined) {
      span.setAttributes(options.attributes);
    }
    this.started.push(span);
    if (this.started.length > NoopTracer.RETAINED_SPAN_LIMIT) {
      this.started.splice(0, this.started.length - NoopTracer.RETAINED_SPAN_LIMIT);
    }
    return span;
  }

  /** Every span this tracer started, for test assertions. */
  spans(): readonly NoopSpan[] {
    return this.started;
  }
}

/** Scope name for the shared no-op instruments. */
const NOOP_SCOPE = parseTrimmedString("omnis.noop");

/** A shared no-op meter, for code that just needs something to call. */
export const NOOP_METER: Meter = new NoopMeter(NOOP_SCOPE);

/** A shared no-op tracer, for code that just needs something to call. */
export const NOOP_TRACER: Tracer = new NoopTracer(NOOP_SCOPE);

/** Creates a no-op meter scoped to a subsystem. */
export function createNoopMeter(name: TrimmedString): Meter {
  return new NoopMeter(name);
}

/** Creates a no-op tracer scoped to a subsystem. */
export function createNoopTracer(name: TrimmedString): Tracer {
  return new NoopTracer(name);
}

/**
 * A metric sample produced by nothing.
 *
 * Exported so that a test can assert an implementation produced no samples
 * without constructing the shape itself.
 */
export const NO_SAMPLES: readonly MetricSample[] = Object.freeze([]);
