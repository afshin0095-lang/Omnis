/**
 * Provider health.
 *
 * Health is *inferred from observed outcomes*, not believed from a self-report. An
 * adapter that says "I am healthy" while every call fails is not healthy, and a provider
 * that reports its own status could hide an outage from the orchestrator's fallback
 * logic — which is exactly when the information matters.
 *
 * The reducer here is a pure function: `(snapshot, observation) -> snapshot`. No timers,
 * no background probing, no wall-clock reads — the observation carries its own timestamp,
 * which is what makes an outage window reconstructible from an audit log and the reducer
 * testable without waiting.
 *
 * The state machine has three bands rather than two because the interesting case is the
 * middle one. A provider that failed once is not out of service, and a provider that has
 * failed five times in a row is not a candidate; "degraded" is the band that keeps a
 * struggling provider selectable-but-last, so a single transient error does not remove
 * the only provider serving a model.
 */

import { initialProviderHealth } from "@omnis/ai-core-types";
import type { ProviderHealth, ProviderHealthObservation, ProviderId } from "@omnis/ai-core-types";

/** Tuning for the health reducer. All integers, all deterministic. */
export interface ProviderHealthOptions {
  /** Consecutive failures after which the provider is considered unavailable. */
  readonly failureThreshold: number;
  /** Consecutive failures after which the provider is considered degraded. */
  readonly degradedThreshold: number;
  /** Consecutive successes after which a degraded or unavailable provider is healthy again. */
  readonly recoveryThreshold: number;
  /**
   * Weight of the newest latency sample in the running average, in percent.
   *
   * Integer percent rather than a float alpha so the average is computed with integer
   * arithmetic and two runs over the same observations produce bit-identical results.
   */
  readonly latencySamplePercent: number;
}

/** The defaults: three strikes out, one strike to degraded, two successes to recover. */
export const DEFAULT_PROVIDER_HEALTH_OPTIONS: ProviderHealthOptions = Object.freeze({
  failureThreshold: 3,
  degradedThreshold: 1,
  recoveryThreshold: 2,
  latencySamplePercent: 25,
});

/** Asserts the thresholds are ordered sensibly. */
export function assertProviderHealthOptions(options: ProviderHealthOptions): void {
  if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
    throw new RangeError(
      `failureThreshold must be a positive integer, received ${String(options.failureThreshold)}`,
    );
  }
  if (!Number.isInteger(options.degradedThreshold) || options.degradedThreshold < 1) {
    throw new RangeError(
      `degradedThreshold must be a positive integer, received ${String(options.degradedThreshold)}`,
    );
  }
  if (options.degradedThreshold > options.failureThreshold) {
    throw new RangeError("degradedThreshold must not exceed failureThreshold");
  }
  if (!Number.isInteger(options.recoveryThreshold) || options.recoveryThreshold < 1) {
    throw new RangeError(
      `recoveryThreshold must be a positive integer, received ${String(options.recoveryThreshold)}`,
    );
  }
  if (
    !Number.isInteger(options.latencySamplePercent) ||
    options.latencySamplePercent < 1 ||
    options.latencySamplePercent > 100
  ) {
    throw new RangeError(
      `latencySamplePercent must be an integer between 1 and 100, received ${String(options.latencySamplePercent)}`,
    );
  }
}

/** The health snapshot for a provider that has never been observed. */
export function unknownHealth(providerId: ProviderId, observedAt: string): ProviderHealth {
  return initialProviderHealth(providerId, observedAt);
}

/**
 * Applies one observation, returning a new snapshot.
 *
 * Pure and total: every observation kind produces a snapshot, and the previous one is
 * never mutated, so a registry can hand the same snapshot to two callers without either
 * seeing the other's update.
 */
export function applyHealthObservation(
  health: ProviderHealth,
  observation: ProviderHealthObservation,
  options: ProviderHealthOptions = DEFAULT_PROVIDER_HEALTH_OPTIONS,
): ProviderHealth {
  switch (observation.kind) {
    case "success":
      return applySuccess(health, observation.latencyMs, observation.observedAt, options);
    case "failure":
      return applyFailure(health, observation.failureClass, observation.observedAt, options);
    case "probe":
      return Object.freeze({
        ...health,
        state: observation.state,
        observedAt: observation.observedAt,
      });
  }
}

function applySuccess(
  health: ProviderHealth,
  latencyMs: number,
  observedAt: string,
  options: ProviderHealthOptions,
): ProviderHealth {
  const consecutiveSuccesses = health.consecutiveSuccesses + 1;
  const recovered = consecutiveSuccesses >= options.recoveryThreshold;
  // A provider coming back from unavailable is degraded until it has proven itself for
  // `recoveryThreshold` calls, so the orchestrator does not immediately route all traffic
  // to an endpoint that just stopped failing.
  const wasUnwell = health.state === "unavailable" || health.state === "degraded";
  const state = recovered || !wasUnwell ? "healthy" : "degraded";

  return Object.freeze({
    providerId: health.providerId,
    state,
    consecutiveFailures: 0,
    consecutiveSuccesses,
    lastSuccessAt: observedAt,
    lastFailureAt: health.lastFailureAt,
    lastFailureClass: health.lastFailureClass,
    averageLatencyMs: movingAverage(
      health.averageLatencyMs,
      latencyMs,
      options.latencySamplePercent,
    ),
    observedAt,
  });
}

function applyFailure(
  health: ProviderHealth,
  failureClass: string,
  observedAt: string,
  options: ProviderHealthOptions,
): ProviderHealth {
  const consecutiveFailures = health.consecutiveFailures + 1;
  const state =
    consecutiveFailures >= options.failureThreshold
      ? "unavailable"
      : consecutiveFailures >= options.degradedThreshold
        ? "degraded"
        : health.state;

  return Object.freeze({
    providerId: health.providerId,
    state,
    consecutiveFailures,
    consecutiveSuccesses: 0,
    lastSuccessAt: health.lastSuccessAt,
    lastFailureAt: observedAt,
    lastFailureClass: failureClass,
    averageLatencyMs: health.averageLatencyMs,
    observedAt,
  });
}

/**
 * Integer exponential moving average.
 *
 * Rounded to a whole millisecond at every step: a float average would accumulate
 * representation error and make two identical observation sequences produce different
 * health snapshots, which would in turn change selection order.
 */
export function movingAverage(
  previous: number | null,
  sample: number,
  samplePercent: number,
): number {
  if (!Number.isFinite(sample) || sample < 0) {
    throw new RangeError(
      `latency sample must be a non-negative finite number, received ${String(sample)}`,
    );
  }
  if (previous === null) {
    return Math.round(sample);
  }
  const delta = Math.round(((sample - previous) * samplePercent) / 100);
  return Math.max(0, previous + delta);
}

/** True when a provider in this health state may be selected. */
export function isSelectableHealthState(state: ProviderHealth["state"]): boolean {
  return state === "healthy" || state === "degraded" || state === "unknown";
}

/** True when health says the provider should not be given new work. */
export function isHealthBlocking(state: ProviderHealth["state"]): boolean {
  return state === "unavailable";
}

/** A short, log-safe rendering of a health snapshot. */
export function describeHealth(health: ProviderHealth): string {
  const latency = health.averageLatencyMs === null ? "n/a" : `${String(health.averageLatencyMs)}ms`;
  return `${health.state}(failures=${String(health.consecutiveFailures)}, successes=${String(health.consecutiveSuccesses)}, latency=${latency})`;
}
