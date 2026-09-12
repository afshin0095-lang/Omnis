/**
 * Metric instruments.
 *
 * WHY INTERFACES FIRST
 * --------------------
 * Sprint 0 establishes the measurement vocabulary without choosing a metrics
 * backend. That ordering is deliberate: the instruments a system needs are
 * determined by what it must be able to ask about, and those questions are
 * known now — how many agent executions failed, what a production run cost, how
 * long publishing takes, how deep a queue is. Which vendor stores the answers is
 * an infrastructure decision that can be made later, and made again, without
 * touching the code that measures.
 *
 * The three instrument types are the standard set and cover every OMNIS
 * measurement without overlap:
 *
 * - {@link Counter} — monotonically increasing totals. Ask "how many since when".
 * - {@link Gauge} — a value that goes up and down. Ask "how much right now".
 * - {@link Histogram} — a distribution. Ask "how long / how big, typically and at
 *   the tail". Averages hide the tail, and the tail is where a user-visible
 *   timeout lives.
 *
 * Every measurement carries optional {@link TelemetryAttributes} so results can be
 * sliced by tenant, environment, platform or character without a new instrument
 * per combination.
 */

import type { JsonValue, TrimmedString } from "@omnis/types";

/**
 * Dimensions attached to a measurement.
 *
 * Values are restricted to JSON scalars because metric attributes become index
 * keys in every real backend. An object or array value would either be rejected
 * or stringified unpredictably, and a metric whose label set varies per call
 * causes unbounded cardinality — the single most common way to take down a
 * metrics backend.
 */
export type TelemetryAttributes = Readonly<Record<string, string | number | boolean>>;

/** Units a metric may be expressed in. */
export const METRIC_UNITS = ["1", "ms", "s", "bytes", "usd", "tokens"] as const;

/** One member of {@link METRIC_UNITS}. */
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** Options accepted when creating an instrument. */
export interface InstrumentOptions {
  /** What the instrument measures, for a metrics explorer. */
  readonly description?: string;
  readonly unit?: MetricUnit;
  /**
   * Attribute keys this instrument is allowed to be sliced by.
   *
   * When non-empty, an implementation should reject or drop attributes outside
   * this list. Declaring the permitted dimensions up front is the practical
   * defence against cardinality explosion: it turns an operational incident into
   * a review comment.
   */
  readonly allowedAttributes?: readonly string[];
}

/** A monotonically increasing total. */
export interface Counter {
  readonly name: TrimmedString;
  /**
   * Adds `value` to the total.
   *
   * @throws {RangeError} implementations must reject a negative delta: a counter
   *   that can decrease is a gauge, and modelling it as a counter makes every
   *   rate computed from it wrong.
   */
  add(value: number, attributes?: TelemetryAttributes): void;
}

/** A value that rises and falls, sampled at the moment it is set. */
export interface Gauge {
  readonly name: TrimmedString;
  set(value: number, attributes?: TelemetryAttributes): void;
}

/** A distribution of observations. */
export interface Histogram {
  readonly name: TrimmedString;
  record(value: number, attributes?: TelemetryAttributes): void;
}

/** Creates and owns a set of instruments for one subsystem. */
export interface Meter {
  /** Scope of this meter, e.g. `content-factory`. */
  readonly name: TrimmedString;
  createCounter(name: TrimmedString, options?: InstrumentOptions): Counter;
  createGauge(name: TrimmedString, options?: InstrumentOptions): Gauge;
  createHistogram(name: TrimmedString, options?: InstrumentOptions): Histogram;
}

/** A metric value paired with its attributes, as observed by an implementation. */
export interface MetricSample {
  readonly instrument: TrimmedString;
  readonly kind: "counter" | "gauge" | "histogram";
  readonly value: JsonValue;
  readonly attributes: TelemetryAttributes;
}

/**
 * Validates an attribute set against an instrument's declared dimensions.
 *
 * Returns the offending keys, empty when the set is permitted. Provided here so
 * every implementation applies the same rule rather than inventing its own.
 */
export function disallowedAttributes(
  attributes: TelemetryAttributes,
  allowed: readonly string[] | undefined,
): string[] {
  if (allowed === undefined || allowed.length === 0) {
    return [];
  }
  return Object.keys(attributes).filter((key) => !allowed.includes(key));
}
