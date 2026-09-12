/**
 * `@omnis/telemetry` — provider-independent observability contracts.
 *
 * Sprint 0 supplies the *interfaces* (meters, counters, gauges, histograms,
 * tracers, spans) and validating no-op *implementations*. A concrete backend is a
 * later Sprint; when it arrives it implements these interfaces and no measurement
 * call site changes.
 *
 * Dependencies: `@omnis/types`, `@omnis/errors`, `@omnis/contracts`.
 */

export { disallowedAttributes, METRIC_UNITS } from "./metrics.js";
export type {
  Counter,
  Gauge,
  Histogram,
  InstrumentOptions,
  Meter,
  MetricSample,
  MetricUnit,
  TelemetryAttributes,
} from "./metrics.js";

export { SPAN_KINDS, SPAN_STATUSES } from "./tracing.js";
export type {
  Span,
  SpanContext,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from "./tracing.js";

export {
  createNoopMeter,
  createNoopTracer,
  NO_SAMPLES,
  NOOP_METER,
  NOOP_TRACER,
  NoopCounter,
  NoopGauge,
  NoopHistogram,
  NoopMeter,
  NoopSpan,
  NoopTracer,
} from "./noop.js";

export {
  metricAttributesFromContext,
  METRIC_ATTRIBUTE_KEYS,
  spanAttributesFromContext,
  SPAN_ATTRIBUTE_KEYS,
} from "./attributes.js";
