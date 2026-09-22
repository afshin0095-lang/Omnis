import { describe, expect, it } from "vitest";
import { createProviderId } from "@omnis/types";
import {
  applyHealthObservation,
  assertProviderHealthOptions,
  DEFAULT_PROVIDER_HEALTH_OPTIONS,
  describeHealth,
  isHealthBlocking,
  isSelectableHealthState,
  movingAverage,
  unknownHealth,
} from "./ProviderHealth.js";

const AT = "2026-03-01T12:00:00.000Z";
const providerId = createProviderId();

function success(latencyMs: number, at: string = AT) {
  return { kind: "success", latencyMs, observedAt: at } as const;
}

function failure(failureClass: string, at: string = AT) {
  return { kind: "failure", failureClass, observedAt: at } as const;
}

describe("unknownHealth", () => {
  it("starts with no history and no latency estimate", () => {
    const health = unknownHealth(providerId, AT);
    expect(health.state).toBe("unknown");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.consecutiveSuccesses).toBe(0);
    expect(health.averageLatencyMs).toBeNull();
    expect(Object.isFrozen(health)).toBe(true);
  });
});

describe("applyHealthObservation", () => {
  it("records a first success as healthy", () => {
    // One success is enough to be healthy from unknown, but not enough to *recover* from
    // unavailable — that takes the recovery threshold.
    const health = applyHealthObservation(unknownHealth(providerId, AT), success(120));
    expect(health.state).toBe("healthy");
    expect(health.consecutiveSuccesses).toBe(1);
    expect(health.lastSuccessAt).toBe(AT);
    expect(health.averageLatencyMs).toBe(120);
  });

  it("degrades on the first failure and goes unavailable at the threshold", () => {
    const options = DEFAULT_PROVIDER_HEALTH_OPTIONS;
    let health = unknownHealth(providerId, AT);
    health = applyHealthObservation(health, failure("provider_failure"), options);
    expect(health.state).toBe("degraded");
    expect(health.consecutiveFailures).toBe(1);

    health = applyHealthObservation(health, failure("provider_failure"), options);
    expect(health.state).toBe("degraded");
    expect(health.consecutiveFailures).toBe(2);

    health = applyHealthObservation(health, failure("deadline_exceeded"), options);
    expect(health.state).toBe("unavailable");
    expect(health.consecutiveFailures).toBe(3);
    expect(health.lastFailureClass).toBe("deadline_exceeded");
    expect(health.consecutiveSuccesses).toBe(0);
  });

  it("resets the failure streak on any success", () => {
    let health = unknownHealth(providerId, AT);
    health = applyHealthObservation(health, failure("provider_failure"));
    health = applyHealthObservation(health, failure("provider_failure"));
    health = applyHealthObservation(health, success(50));
    expect(health.consecutiveFailures).toBe(0);
    expect(health.consecutiveSuccesses).toBe(1);
    // Two failures then a success then two more failures must not add up to unavailable.
    health = applyHealthObservation(health, failure("provider_failure"));
    health = applyHealthObservation(health, failure("provider_failure"));
    expect(health.state).toBe("degraded");
  });

  it("recovers from unavailable only after the recovery threshold", () => {
    const options = DEFAULT_PROVIDER_HEALTH_OPTIONS;
    let health = unknownHealth(providerId, AT);
    for (let index = 0; index < options.failureThreshold; index += 1) {
      health = applyHealthObservation(health, failure("provider_failure"), options);
    }
    expect(health.state).toBe("unavailable");

    // The first success after an outage makes the provider degraded, not healthy: routing
    // all traffic at an endpoint that just stopped failing is how an outage becomes two.
    health = applyHealthObservation(health, success(200), options);
    expect(health.state).toBe("degraded");
    expect(health.consecutiveSuccesses).toBe(1);

    health = applyHealthObservation(health, success(180), options);
    expect(health.state).toBe("healthy");
    expect(health.consecutiveSuccesses).toBe(2);
  });

  it("keeps a healthy provider healthy across successes", () => {
    let health = applyHealthObservation(unknownHealth(providerId, AT), success(100));
    health = applyHealthObservation(health, success(100));
    health = applyHealthObservation(health, success(100));
    expect(health.state).toBe("healthy");
    expect(health.consecutiveSuccesses).toBe(3);
  });

  it("accepts an external probe as a state report without touching the counters", () => {
    let health = applyHealthObservation(unknownHealth(providerId, AT), success(100));
    health = applyHealthObservation(health, {
      kind: "probe",
      state: "unavailable",
      observedAt: AT,
    });
    expect(health.state).toBe("unavailable");
    expect(health.consecutiveSuccesses).toBe(1);
    expect(health.averageLatencyMs).toBe(100);
  });

  it("does not mutate the previous snapshot", () => {
    const before = unknownHealth(providerId, AT);
    const after = applyHealthObservation(before, failure("provider_failure"));
    expect(before.state).toBe("unknown");
    expect(before.consecutiveFailures).toBe(0);
    expect(after).not.toBe(before);
  });

  it("honors custom thresholds", () => {
    const options = {
      failureThreshold: 1,
      degradedThreshold: 1,
      recoveryThreshold: 1,
      latencySamplePercent: 100,
    };
    const health = applyHealthObservation(
      unknownHealth(providerId, AT),
      failure("provider_failure"),
      options,
    );
    expect(health.state).toBe("unavailable");
    expect(applyHealthObservation(health, success(10), options).state).toBe("healthy");
  });
});

describe("movingAverage", () => {
  it("takes the first sample as the average", () => {
    expect(movingAverage(null, 250, 25)).toBe(250);
  });

  it("weights the newest sample by an integer percentage", () => {
    expect(movingAverage(100, 200, 25)).toBe(125);
    expect(movingAverage(100, 200, 50)).toBe(150);
    expect(movingAverage(100, 200, 100)).toBe(200);
  });

  it("produces an integer at every step", () => {
    let average: number | null = null;
    for (const sample of [101, 202, 303, 404]) {
      average = movingAverage(average, sample, 25);
      expect(Number.isInteger(average), String(average)).toBe(true);
    }
  });

  it("is deterministic: the same samples in the same order give the same result", () => {
    const run = (): number | null =>
      [10, 20, 30].reduce<number | null>((acc, sample) => movingAverage(acc, sample, 25), null);
    expect(run()).toBe(run());
  });

  it("never goes negative and rejects an invalid sample", () => {
    expect(movingAverage(10, 0, 25)).toBeGreaterThanOrEqual(0);
    expect(() => movingAverage(10, -5, 25)).toThrow(RangeError);
    expect(() => movingAverage(10, Number.NaN, 25)).toThrow(RangeError);
  });
});

describe("assertProviderHealthOptions", () => {
  it("accepts the defaults", () => {
    expect(() => assertProviderHealthOptions(DEFAULT_PROVIDER_HEALTH_OPTIONS)).not.toThrow();
  });

  it("rejects thresholds that would make the bands unreachable", () => {
    expect(() =>
      assertProviderHealthOptions({ ...DEFAULT_PROVIDER_HEALTH_OPTIONS, failureThreshold: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      assertProviderHealthOptions({
        ...DEFAULT_PROVIDER_HEALTH_OPTIONS,
        degradedThreshold: 5,
        failureThreshold: 3,
      }),
    ).toThrow(RangeError);
    expect(() =>
      assertProviderHealthOptions({ ...DEFAULT_PROVIDER_HEALTH_OPTIONS, recoveryThreshold: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      assertProviderHealthOptions({ ...DEFAULT_PROVIDER_HEALTH_OPTIONS, latencySamplePercent: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      assertProviderHealthOptions({
        ...DEFAULT_PROVIDER_HEALTH_OPTIONS,
        latencySamplePercent: 101,
      }),
    ).toThrow(RangeError);
  });
});

describe("health predicates", () => {
  it("keeps unknown and degraded selectable and blocks unavailable", () => {
    expect(isSelectableHealthState("healthy")).toBe(true);
    expect(isSelectableHealthState("unknown")).toBe(true);
    expect(isSelectableHealthState("degraded")).toBe(true);
    expect(isSelectableHealthState("unavailable")).toBe(false);
    expect(isHealthBlocking("unavailable")).toBe(true);
    expect(isHealthBlocking("degraded")).toBe(false);
  });

  it("describes a snapshot on one line", () => {
    const health = applyHealthObservation(unknownHealth(providerId, AT), success(120));
    expect(describeHealth(health)).toBe("healthy(failures=0, successes=1, latency=120ms)");
    expect(describeHealth(unknownHealth(providerId, AT))).toContain("latency=n/a");
  });
});
