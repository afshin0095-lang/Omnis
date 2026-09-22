import { describe, expect, it } from "vitest";
import { createModelId, createProviderId } from "@omnis/types";
import { MAX_FALLBACK_CANDIDATES } from "@omnis/ai-core-types";
import type { ProviderDescriptor, ProviderHealth } from "@omnis/ai-core-types";
import { applyHealthObservation, unknownHealth } from "./ProviderHealth.js";
import {
  explainExclusions,
  scoreProvider,
  selectProviders,
  SELECTION_WEIGHTS,
} from "./ProviderSelection.js";
import type { ProviderSelectionRequest, SelectableProvider } from "./ProviderSelection.js";
import { scriptedAdapter } from "./testSupport.js";

const AT = "2026-03-01T12:00:00.000Z";

function provider(overrides: Partial<ProviderDescriptor> = {}): SelectableProvider {
  const providerId = overrides.id ?? createProviderId();
  const descriptor: ProviderDescriptor = {
    slug: overrides.slug ?? `provider-${providerId.slice(-4)}`,
    displayName: "Test provider",
    transport: "http",
    status: "ready",
    capabilities: {
      operations: ["chat", "streaming"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      modelCapabilities: ["chat", "streaming", "tool_calling"],
    },
    rateLimit: { requestsPerMinute: 600, tokensPerMinute: null, maxConcurrentRequests: null },
    priority: 10,
    latencyClass: "medium",
    region: null,
    policyId: null,
    budgetId: null,
    credentialsConfigured: true,
    metadata: {},
    registeredAt: AT,
    ...overrides,
    id: providerId,
  };
  const health: ProviderHealth = unknownHealth(providerId, AT);
  return {
    descriptor,
    health,
    adapter: scriptedAdapter({
      providerId,
      slug: descriptor.slug,
      capabilities: descriptor.capabilities.modelCapabilities,
    }),
  };
}

function withHealth(
  candidate: SelectableProvider,
  observations: number,
  kind: "success" | "failure",
): SelectableProvider {
  let health = candidate.health;
  for (let index = 0; index < observations; index += 1) {
    health =
      kind === "success"
        ? applyHealthObservation(health, { kind: "success", latencyMs: 100, observedAt: AT })
        : applyHealthObservation(health, {
            kind: "failure",
            failureClass: "provider_failure",
            observedAt: AT,
          });
  }
  return { ...candidate, health };
}

describe("eligibility", () => {
  it("excludes a provider whose status is not selectable", () => {
    for (const status of ["registered", "initializing", "unavailable", "disabled"] as const) {
      const outcome = scoreProvider(provider({ status }), {});
      expect(outcome.selected, status).toBe(false);
      if (!outcome.selected) {
        expect(outcome.reason).toContain(status);
      }
    }
  });

  it("includes a degraded provider but ranks it below a ready one", () => {
    const degraded = provider({ slug: "degraded", status: "degraded" });
    const ready = provider({ slug: "ready" });
    const selected = selectProviders([degraded, ready]);
    expect(selected.map((candidate) => candidate.descriptor.slug)).toEqual(["ready", "degraded"]);
  });

  it("excludes a provider whose health is unavailable", () => {
    const unhealthy = withHealth(provider(), 3, "failure");
    expect(unhealthy.health.state).toBe("unavailable");
    const outcome = scoreProvider(unhealthy, {});
    expect(outcome.selected).toBe(false);
    if (!outcome.selected) {
      expect(outcome.reason).toContain("health is unavailable");
    }
  });

  it("excludes a provider with no configured credentials", () => {
    const outcome = scoreProvider(provider({ credentialsConfigured: false }), {});
    expect(outcome.selected).toBe(false);
    if (!outcome.selected) {
      expect(outcome.reason).toContain("credentials");
    }
  });

  it("applies a policy allow-list and deny-list", () => {
    const allowed = provider({ slug: "allowed" });
    const denied = provider({ slug: "denied" });
    const allowedOnly = selectProviders([allowed, denied], {
      allowedProviderIds: [allowed.descriptor.id],
    });
    expect(allowedOnly.map((candidate) => candidate.descriptor.slug)).toEqual(["allowed"]);

    const withoutDenied = selectProviders([allowed, denied], {
      deniedProviderIds: [denied.descriptor.id],
    });
    expect(withoutDenied.map((candidate) => candidate.descriptor.slug)).toEqual(["allowed"]);

    const explanations = explainExclusions([allowed, denied], {
      deniedProviderIds: [denied.descriptor.id],
    });
    expect(explanations["denied"]).toBe("denied by policy");
    expect(explanations["allowed"]).toBeUndefined();
  });

  it("excludes a provider outside the permitted regions", () => {
    const inRegion = provider({ slug: "eu", region: "eu-west" });
    const outOfRegion = provider({ slug: "us", region: "us-east" });
    const noRegion = provider({ slug: "local", region: null });
    const selected = selectProviders([inRegion, outOfRegion, noRegion], { regions: ["eu-west"] });
    expect(selected.map((candidate) => candidate.descriptor.slug)).toEqual(["eu"]);
  });

  it("ignores an empty region list", () => {
    expect(selectProviders([provider()], { regions: [] })).toHaveLength(1);
  });

  it("excludes a provider missing a required operation", () => {
    const outcome = scoreProvider(provider(), { operations: ["embeddings"] });
    expect(outcome.selected).toBe(false);
    if (!outcome.selected) {
      expect(outcome.reason).toContain("embeddings");
    }
  });

  it("excludes a provider that does not declare a required capability", () => {
    const outcome = scoreProvider(provider(), { capabilities: ["structured_output"] });
    expect(outcome.selected).toBe(false);
    if (!outcome.selected) {
      expect(outcome.reason).toContain("structured_output");
    }
  });

  it("asks the adapter about a specific model and trusts its answer", () => {
    const modelId = createModelId();
    const candidate = provider();
    expect(scoreProvider(candidate, { capabilities: ["chat"], modelId }).selected).toBe(true);

    // An adapter that refuses the capability for this model excludes the provider even
    // though the descriptor declares it: per-model truth beats per-endpoint declaration.
    const refusing = {
      ...candidate,
      adapter: scriptedAdapter({
        providerId: candidate.descriptor.id,
        slug: candidate.descriptor.slug,
        capabilities: [],
      }),
    };
    const outcome = scoreProvider(refusing, { capabilities: ["chat"], modelId });
    expect(outcome.selected).toBe(false);
    if (!outcome.selected) {
      expect(outcome.reason).toContain("adapter does not support");
    }
  });

  it("excludes a provider whose declared cost exceeds the limit, and keeps an unpriced one", () => {
    const priced = provider({ slug: "priced" });
    const unpriced = provider({ slug: "unpriced" });
    const request: ProviderSelectionRequest = {
      maxCostMicroPerThousandTokens: 1_000,
      costs: { [priced.descriptor.id]: 5_000 },
    };
    const selected = selectProviders([priced, unpriced], request);
    // Unknown pricing is the normal case for local and enterprise endpoints; excluding it
    // would let a cost constraint silently remove half the fleet.
    expect(selected.map((candidate) => candidate.descriptor.slug)).toEqual(["unpriced"]);
  });

  it("keeps a provider whose declared cost is within the limit", () => {
    const candidate = provider();
    const outcome = scoreProvider(candidate, {
      maxCostMicroPerThousandTokens: 5_000,
      costs: { [candidate.descriptor.id]: 1_000 },
    });
    expect(outcome.selected).toBe(true);
  });
});

describe("scoring", () => {
  it("scores status, health, priority and cost with the published weights", () => {
    const candidate = provider({ priority: 10 });
    const healthy = withHealth(candidate, 2, "success");
    const outcome = scoreProvider(healthy, {
      maxCostMicroPerThousandTokens: 5_000,
      costs: { [healthy.descriptor.id]: 1_000 },
    });
    expect(outcome.selected).toBe(true);
    if (!outcome.selected) {
      return;
    }
    expect(outcome.candidate.score).toBe(
      SELECTION_WEIGHTS.statusReady +
        SELECTION_WEIGHTS.healthHealthy +
        (SELECTION_WEIGHTS.priorityCeiling - 10) +
        SELECTION_WEIGHTS.costWithinBudget,
    );
    expect(outcome.candidate.reasons).toEqual([
      `status=ready(+${String(SELECTION_WEIGHTS.statusReady)})`,
      `health=healthy(+${String(SELECTION_WEIGHTS.healthHealthy)})`,
      `priority=10(+${String(SELECTION_WEIGHTS.priorityCeiling - 10)})`,
      `cost=1000(+${String(SELECTION_WEIGHTS.costWithinBudget)})`,
    ]);
  });

  it("records unknown cost without scoring it", () => {
    const outcome = scoreProvider(provider(), {});
    expect(outcome.selected).toBe(true);
    if (outcome.selected) {
      expect(outcome.candidate.reasons).toContain("cost=unknown(+0)");
    }
  });

  it("adds the adapter confirmation bonus only when a model was named", () => {
    const candidate = provider();
    const withoutModel = scoreProvider(candidate, { capabilities: ["chat"] });
    const withModel = scoreProvider(candidate, {
      capabilities: ["chat"],
      modelId: createModelId(),
    });
    if (withoutModel.selected && withModel.selected) {
      expect(withModel.candidate.score - withoutModel.candidate.score).toBe(
        SELECTION_WEIGHTS.adapterConfirmed,
      );
    } else {
      expect.unreachable("both outcomes should be selections");
    }
  });

  it("never scores a priority below zero", () => {
    const outcome = scoreProvider(provider({ priority: 1_000_000 }), {});
    if (outcome.selected) {
      expect(outcome.candidate.reasons.at(-2)).toContain("priority=1000000(+0)");
    } else {
      expect.unreachable("a ready provider with credentials is eligible");
    }
  });
});

describe("ranking", () => {
  it("orders by score, then health, then priority, then slug", () => {
    const best = withHealth(provider({ slug: "aaa", priority: 1 }), 2, "success");
    const mid = provider({ slug: "bbb", priority: 1 });
    const worst = provider({ slug: "ccc", priority: 250 });
    const selected = selectProviders([worst, mid, best]);
    expect(selected.map((candidate) => candidate.descriptor.slug)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("lets an operator's priority outrank a single observed failure", () => {
    // One failure degrades a provider; it does not demote it below an endpoint the operator
    // never preferred. Only unavailable health removes a provider outright.
    const preferred = withHealth(provider({ slug: "preferred", priority: 1 }), 1, "failure");
    const backup = provider({ slug: "backup", priority: 50 });
    const selected = selectProviders([backup, preferred]);
    expect(selected.map((candidate) => candidate.descriptor.slug)).toEqual(["preferred", "backup"]);
  });

  it("is deterministic across repeated calls and input orders", () => {
    const candidates = [provider({ slug: "c" }), provider({ slug: "a" }), provider({ slug: "b" })];
    const first = selectProviders(candidates).map((candidate) => candidate.descriptor.slug);
    const second = selectProviders([...candidates].reverse()).map(
      (candidate) => candidate.descriptor.slug,
    );
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
  });

  it("caps the fallback list at the contract maximum", () => {
    const many = Array.from({ length: MAX_FALLBACK_CANDIDATES + 3 }, (_, index) =>
      provider({ slug: `p${String(index).padStart(2, "0")}` }),
    );
    expect(selectProviders(many)).toHaveLength(MAX_FALLBACK_CANDIDATES);
  });

  it("honors an explicit limit", () => {
    const many = Array.from({ length: 4 }, (_, index) => provider({ slug: `p${String(index)}` }));
    expect(selectProviders(many, { limit: 2 })).toHaveLength(2);
    expect(selectProviders(many, { limit: 10 })).toHaveLength(4);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(selectProviders([provider()]))).toBe(true);
  });

  it("returns nothing when every provider is excluded", () => {
    expect(selectProviders([provider({ status: "disabled" })])).toEqual([]);
  });
});
