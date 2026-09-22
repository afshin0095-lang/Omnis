import { describe, expect, it } from "vitest";
import { createProviderId } from "@omnis/types";
import {
  compareProviderCandidates,
  initialProviderHealth,
  isLiveProviderStatus,
  isSelectableProviderStatus,
  providerById,
  providerBySlug,
  type ProviderCandidate,
  type ProviderDescriptor,
  type ProviderHealth,
} from "./index.js";

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: createProviderId(),
    slug: "primary",
    displayName: "Primary",
    transport: "http",
    status: "ready",
    capabilities: {
      operations: ["chat", "streaming"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      modelCapabilities: ["chat", "streaming"],
    },
    rateLimit: { requestsPerMinute: 600, tokensPerMinute: null, maxConcurrentRequests: 8 },
    priority: 10,
    latencyClass: "medium",
    region: null,
    policyId: null,
    budgetId: null,
    credentialsConfigured: true,
    metadata: {},
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    ...initialProviderHealth(createProviderId(), "2026-01-01T00:00:00.000Z"),
    state: "healthy",
    ...overrides,
  };
}

function candidate(
  score: number,
  overrides: Partial<ProviderDescriptor> = {},
  healthOverrides: Partial<ProviderHealth> = {},
): ProviderCandidate {
  const subject = descriptor(overrides);
  return {
    descriptor: subject,
    health: health({ providerId: subject.id, ...healthOverrides }),
    score,
    reasons: [],
  };
}

describe("provider lifecycle", () => {
  it("selects only ready and degraded providers", () => {
    expect(isSelectableProviderStatus("ready")).toBe(true);
    // Degraded stays selectable: excluding it during an outage would remove the only
    // working candidate for models that no other provider serves.
    expect(isSelectableProviderStatus("degraded")).toBe(true);
    for (const status of ["registered", "initializing", "unavailable", "disabled"] as const) {
      expect(isSelectableProviderStatus(status), status).toBe(false);
    }
  });

  it("treats a disabled provider as no longer live", () => {
    expect(isLiveProviderStatus("ready")).toBe(true);
    expect(isLiveProviderStatus("unavailable")).toBe(true);
    expect(isLiveProviderStatus("disabled")).toBe(false);
  });
});

describe("provider references", () => {
  it("builds both reference kinds", () => {
    const providerId = createProviderId();
    expect(providerById(providerId)).toEqual({ kind: "id", providerId });
    expect(providerBySlug("primary")).toEqual({ kind: "slug", slug: "primary" });
  });
});

describe("initialProviderHealth", () => {
  it("starts unknown with no history and no latency estimate", () => {
    const providerId = createProviderId();
    const subject = initialProviderHealth(providerId, "2026-01-01T00:00:00.000Z");
    expect(subject).toEqual({
      providerId,
      state: "unknown",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureClass: null,
      averageLatencyMs: null,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.isFrozen(subject)).toBe(true);
  });
});

describe("compareProviderCandidates", () => {
  it("prefers the higher score", () => {
    expect(compareProviderCandidates(candidate(90), candidate(10))).toBeLessThan(0);
    expect(compareProviderCandidates(candidate(10), candidate(90))).toBeGreaterThan(0);
  });

  it("ranks a degraded provider below a healthy one at the same score", () => {
    const healthy = candidate(50, { slug: "z-healthy" });
    const degraded = candidate(50, { slug: "a-degraded" }, { state: "degraded" });
    // The slug would otherwise win the tie-break, so this asserts health beats name.
    expect(compareProviderCandidates(healthy, degraded)).toBeLessThan(0);
  });

  it("ranks a degraded descriptor below a ready one at the same score and health", () => {
    const ready = candidate(50, { slug: "z-ready" });
    const degradedDescriptor = candidate(50, { slug: "a-degraded", status: "degraded" });
    expect(compareProviderCandidates(ready, degradedDescriptor)).toBeLessThan(0);
  });

  it("falls back to declared priority, then slug, then identifier", () => {
    expect(
      compareProviderCandidates(
        candidate(50, { priority: 1, slug: "z" }),
        candidate(50, { priority: 9, slug: "a" }),
      ),
    ).toBeLessThan(0);
    expect(
      compareProviderCandidates(
        candidate(50, { priority: 5, slug: "alpha" }),
        candidate(50, { priority: 5, slug: "beta" }),
      ),
    ).toBeLessThan(0);

    const sameId = descriptor();
    const left: ProviderCandidate = {
      descriptor: sameId,
      health: health({ providerId: sameId.id }),
      score: 50,
      reasons: [],
    };
    const right: ProviderCandidate = {
      descriptor: sameId,
      health: health({ providerId: sameId.id }),
      score: 50,
      reasons: [],
    };
    expect(compareProviderCandidates(left, right)).toBe(0);
  });

  it("produces a stable fallback order across repeated sorts", () => {
    const candidates = [
      candidate(10, { slug: "c", priority: 1 }),
      candidate(90, { slug: "b", priority: 9 }),
      candidate(90, { slug: "a", priority: 1 }),
    ];
    const first = [...candidates]
      .sort(compareProviderCandidates)
      .map((entry) => entry.descriptor.slug);
    const second = [...candidates]
      .sort(compareProviderCandidates)
      .map((entry) => entry.descriptor.slug);
    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
  });
});
