/**
 * Distributed tracing contracts.
 *
 * WHY OMNIS NEEDS TRACES AND NOT JUST LOGS
 * ----------------------------------------
 * One business operation — "turn an audience request into a published video" —
 * crosses Audience Intelligence, Content Strategy, the Content Factory, several
 * model providers, Publishing and Analytics. It may take hours. A log line per
 * step is not enough to answer "where is this stuck?" or "why did this one cost
 * $4.20?".
 *
 * A trace answers both, provided the identifiers are propagated consistently.
 * OMNIS therefore carries **two** parallel chains:
 *
 * - `correlationId` / `causationId` — the *business* chain, defined in
 *   `@omnis/contracts`. Survives retries, restarts and queue hops, because it is
 *   part of the event envelope and is persisted with it.
 * - `traceId` / `spanId` — the *technical* chain, defined here. Compatible with
 *   W3C trace context so an external vendor's tooling can render it.
 *
 * Both are kept because they have different lifetimes: a trace typically ends
 * when a request ends, while a business correlation can span days of scheduled
 * production work.
 */

import type {
  CorrelationId,
  JsonValue,
  SpanId,
  TenantId,
  TraceId,
  TrimmedString,
} from "@omnis/types";
import type { TelemetryAttributes } from "./metrics.js";

/** The role a span plays relative to other processes. */
export const SPAN_KINDS = ["internal", "client", "server", "producer", "consumer"] as const;

/** One member of {@link SPAN_KINDS}. */
export type SpanKind = (typeof SPAN_KINDS)[number];

/** The outcome of a span. */
export const SPAN_STATUSES = ["unset", "ok", "error"] as const;

/** One member of {@link SPAN_STATUSES}. */
export type SpanStatus = (typeof SPAN_STATUSES)[number];

/** Propagated identity of a span, safe to send across a process boundary. */
export type SpanContext = {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  /** `null` for a root span. */
  readonly parentSpanId: SpanId | null;
  /** Business correlation carried alongside the technical trace. */
  readonly correlationId: CorrelationId | null;
  readonly tenantId: TenantId | null;
};

/** A timed unit of work within a trace. */
export interface Span {
  readonly name: TrimmedString;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  /** True once {@link Span.end} has been called. */
  readonly ended: boolean;

  setAttribute(key: string, value: JsonValue): void;
  setAttributes(attributes: TelemetryAttributes): void;
  setStatus(status: SpanStatus, message?: string): void;
  /**
   * Records an exception against the span **without** ending it or changing its
   * status.
   *
   * Separated from `setStatus` because a caught-and-handled error is worth
   * recording but should not mark the span as failed, while an error that aborts
   * the work should do both. Conflating them produces traces where every span
   * that logged anything looks broken.
   */
  recordException(error: unknown): void;
  /** Adds a timestamped note. */
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  /**
   * Ends the span.
   *
   * Idempotent: ending an already-ended span is a no-op rather than an error,
   * because spans are frequently ended in a `finally` block that can also be
   * reached by an earlier explicit end, and throwing there would mask the
   * original failure.
   */
  end(): void;
}

/** Options for starting a span. */
export interface StartSpanOptions {
  readonly kind?: SpanKind;
  /** Parent to attach to. Omitted for a root span. */
  readonly parent?: SpanContext;
  readonly attributes?: TelemetryAttributes;
  /** Explicit start time; defaults to now. */
  readonly startTime?: Date;
}

/** Creates spans within one named scope. */
export interface Tracer {
  readonly name: TrimmedString;
  startSpan(name: TrimmedString, options?: StartSpanOptions): Span;
}
