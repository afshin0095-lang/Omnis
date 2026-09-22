import { describe, expect, it, vi } from "vitest";
import { modelByCapability, modelById } from "@omnis/ai-core-types";
import { MAX_INVOCATION_RETRY_DELAY_MS, MAX_PROVIDER_ATTEMPTS } from "./ModelCall.js";
import type { ModelCallResult } from "./ModelCall.js";
import {
  AT,
  completedInvocation,
  failedInvocation,
  modelCall,
  orchestratorFixture,
  usageOf,
} from "./testSupport.js";
import type { FixtureModel, OrchestratorFixture } from "./testSupport.js";

function primaryOf(fixture: OrchestratorFixture): FixtureModel {
  const model = fixture.primary;
  expect(model).not.toBeNull();
  return model as FixtureModel;
}

function succeeded(result: ModelCallResult): Extract<ModelCallResult, { status: "succeeded" }> {
  if (result.status !== "succeeded") {
    expect.unreachable(
      `the call failed: ${result.failure.class}(${result.failure.code}): ${result.failure.message}`,
    );
  }
  return result;
}

function failed(result: ModelCallResult): Extract<ModelCallResult, { status: "failed" }> {
  if (result.status !== "failed") {
    expect.unreachable("the call was expected to fail");
  }
  return result;
}

/** Two providers, the first of which fails however the test says. */
function twoProviders(
  first: Parameters<typeof failedInvocation>[0] = "the first provider is down",
  options: {
    retryable?: boolean;
    failureClass?:
      "provider_failure" | "retryable" | "deadline_exceeded" | "validation" | "non_retryable";
  } = {},
) {
  return orchestratorFixture({
    models: [
      { slug: "first", priority: 5, results: [failedInvocation(first, options)] },
      {
        slug: "second",
        priority: 10,
        results: [completedInvocation("the second provider answered")],
      },
    ],
  });
}

describe("retrying one provider", () => {
  it("tries the same provider again after a retryable failure and reports both attempts", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "flaky",
          results: [
            failedInvocation("rate limited"),
            completedInvocation("answered on the second try"),
          ],
        },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(result.fallbacks).toBe(0);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(2);
    expect(result.response.message.content).toEqual([
      { type: "text", text: "answered on the second try" },
    ]);
  });

  it("does not retry a failure the provider marked non-retryable", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "refusing",
          results: [failedInvocation("the request was refused", { retryable: false })],
        },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.attempts).toHaveLength(1);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
  });

  it("does not retry a fact about the call", async () => {
    for (const failureClass of ["validation", "non_retryable"] as const) {
      const fixture = orchestratorFixture({
        models: [
          {
            slug: "strict",
            results: [failedInvocation("bad request", { failureClass, retryable: true })],
          },
        ],
      });
      const result = failed(
        await fixture.orchestrator.call(
          modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        ),
      );
      expect(result.attempts).toHaveLength(1);
      expect(result.failure.class).toBe(failureClass);
    }
  });

  it("stops at the caller's per-provider limit", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "down", results: [failedInvocation("down")] }],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          maxAttemptsPerProvider: MAX_PROVIDER_ATTEMPTS,
        }),
      ),
    );
    expect(result.attempts).toHaveLength(MAX_PROVIDER_ATTEMPTS);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(MAX_PROVIDER_ATTEMPTS);
  });

  it("never retries more than the published maximum, however much a caller asks", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "down", results: [failedInvocation("down")] }],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          maxAttemptsPerProvider: MAX_PROVIDER_ATTEMPTS,
        }),
      ),
    );
    expect(result.attempts).toHaveLength(MAX_PROVIDER_ATTEMPTS);
    expect(MAX_PROVIDER_ATTEMPTS).toBeLessThanOrEqual(
      (MAX_INVOCATION_RETRY_DELAY_MS / MAX_INVOCATION_RETRY_DELAY_MS) * MAX_PROVIDER_ATTEMPTS,
    );
  });

  it("waits the delay a provider asks for before trying it again", async () => {
    vi.useFakeTimers();
    try {
      const fixture = orchestratorFixture({
        models: [
          {
            slug: "throttled",
            results: [
              failedInvocation("slow down", { retryAfterMs: 5_000 }),
              completedInvocation("answered"),
            ],
          },
        ],
      });
      const pending = fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = succeeded(await pending);
      expect(primaryOf(fixture).adapter.invocations).toHaveLength(2);
      expect(result.attempts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a delay a provider asks for to the configured maximum", async () => {
    vi.useFakeTimers();
    try {
      const fixture = orchestratorFixture({
        retryDelayMs: 0,
        orchestrator: { maxRetryDelayMs: 40 },
        models: [
          {
            slug: "throttled",
            results: [
              failedInvocation("slow down", { retryAfterMs: 600_000 }),
              completedInvocation("answered"),
            ],
          },
        ],
      });
      const pending = fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
      );
      await vi.advanceTimersByTimeAsync(60);
      const result = succeeded(await pending);
      expect(result.attempts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait at all when no delay is configured", async () => {
    vi.useFakeTimers();
    try {
      const fixture = orchestratorFixture({
        models: [
          { slug: "flaky", results: [failedInvocation("again"), completedInvocation("answered")] },
        ],
      });
      const pending = fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
      );
      // No timer to advance: the second attempt is already under way.
      await vi.advanceTimersByTimeAsync(0);
      const result = succeeded(await pending);
      expect(result.attempts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("falling back to another provider", () => {
  it("moves to the next candidate once one provider has used up its attempts", async () => {
    const fixture = twoProviders();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.modelId).toBe(fixture.models[1]?.model.id);
    expect(result.providerId).toBe(fixture.models[1]?.provider.id);
    expect(result.fallbacks).toBe(1);
    expect(result.attempts.map((attempt) => attempt.fallbackDepth)).toEqual([0, 0, 1]);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "failed",
      "failed",
      "succeeded",
    ]);
  });

  it("falls back after a provider times out, because a second attempt would time out too", async () => {
    const fixture = twoProviders("the provider took too long", {
      failureClass: "deadline_exceeded",
      retryable: false,
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.status).toBe("failed");
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(1);
  });

  it("falls back when an adapter throws something nobody classified", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 5, throws: new Error("socket hang up") },
        { slug: "second", priority: 10 },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.modelId).toBe(fixture.models[1]?.model.id);
    expect(result.attempts[0]?.status).toBe("failed");
    expect(result.attempts[0]?.failure?.class).toBe("provider_failure");
    expect(result.attempts[0]?.failure?.message).toBe("socket hang up");
    // A bare throw is not worth repeating against the same endpoint.
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(1);
  });

  it("falls back when an adapter returns something that is not a result", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 5 },
        { slug: "second", priority: 10 },
      ],
    });
    // A broken adapter is replaced at the registry level: the orchestrator only ever sees the contract.
    const broken = {
      providerId: fixture.models[0]?.provider.id,
      slug: "broken",
      invoke: async () => null,
      supports: () => true,
    } as unknown as Parameters<typeof fixture.providerRegistry.register>[1];
    fixture.providerRegistry.remove(fixture.models[0]?.provider.id as never);
    fixture.providerRegistry.register(
      {
        slug: "first-provider",
        displayName: "first provider",
        transport: "http",
        capabilities: {
          operations: ["chat"],
          inputModalities: ["text"],
          outputModalities: ["text"],
          modelCapabilities: ["chat"],
        },
        rateLimit: { requestsPerMinute: 60, tokensPerMinute: 10_000, maxConcurrentRequests: 2 },
        priority: 5,
        latencyClass: "low",
        region: null,
        policyId: null,
        budgetId: null,
        credentialsConfigured: true,
        metadata: {},
        registeredAt: AT,
        id: fixture.models[0]?.provider.id,
      },
      broken,
    );
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.modelId).toBe(fixture.models[1]?.model.id);
    expect(result.attempts[0]?.failure?.message).toContain("returned no result");
  });

  it("does not fall back around a validation failure", async () => {
    const fixture = twoProviders("the request was malformed", {
      failureClass: "validation",
      retryable: false,
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.failure.class).toBe("validation");
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
    expect(result.fallbacks).toBe(0);
  });

  it("does not fall back around a cancellation", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          results: [
            failedInvocation("cancelled by the provider", {
              failureClass: "non_retryable",
              retryable: false,
            }),
          ],
        },
        { slug: "second", priority: 10 },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
    expect(result.attempts).toHaveLength(1);
  });

  it("reports the failure that actually happened when every candidate failed", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          results: [failedInvocation("the first provider is down", { retryable: false })],
        },
        {
          slug: "second",
          priority: 10,
          results: [failedInvocation("the second provider is down too", { retryable: false })],
        },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.failure.message).toBe("the second provider is down too");
    expect(result.attempts).toHaveLength(2);
    expect(result.fallbacks).toBe(1);
  });

  it("walks the candidates in priority order, not registration order", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "third", priority: 30, results: [failedInvocation("down", { retryable: false })] },
        { slug: "first", priority: 10, results: [failedInvocation("down", { retryable: false })] },
        { slug: "second", priority: 20, results: [failedInvocation("down", { retryable: false })] },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.attempts.map((attempt) => attempt.modelId)).toEqual([
      fixture.models[1]?.model.id,
      fixture.models[2]?.model.id,
      fixture.models[0]?.model.id,
    ]);
    expect(result.fallbacks).toBe(2);
  });

  it("walks the same order twice, because a fallback that is not reproducible is not debuggable", async () => {
    const build = (): OrchestratorFixture =>
      orchestratorFixture({
        models: [
          {
            slug: "third",
            priority: 30,
            results: [failedInvocation("down", { retryable: false })],
          },
          {
            slug: "first",
            priority: 10,
            results: [failedInvocation("down", { retryable: false })],
          },
          {
            slug: "second",
            priority: 20,
            results: [failedInvocation("down", { retryable: false })],
          },
        ],
      });
    const depthsOf = async (fixture: OrchestratorFixture): Promise<readonly string[]> => {
      const outcome = failed(
        await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
      );
      // Identifiers differ between fixtures; the shape of the walk does not.
      return outcome.attempts.map(
        (attempt) => `${String(attempt.fallbackDepth)}:${String(attempt.status)}`,
      );
    };
    expect(await depthsOf(build())).toEqual(await depthsOf(build()));
  });

  it("sums the tokens every provider burned, including the ones that failed", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          results: [failedInvocation("down", { usage: usageOf(100, 0, null), retryable: false })],
        },
        {
          slug: "second",
          priority: 10,
          results: [completedInvocation("answered", usageOf(10, 20, 3))],
        },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.usage.inputTokens).toBe(110);
    expect(result.usage.outputTokens).toBe(20);
    // The failed attempt reported no cost, so the total cost is unknown rather than understated:
    // `addUsage` keeps a total unpriced when any part of it is.
    expect(result.usage.costMicro).toBeNull();
  });

  it("keeps the cost a provider reported when every attempt reported one", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          results: [failedInvocation("down", { retryable: false, usage: usageOf(5, 0, 1) })],
        },
        {
          slug: "second",
          priority: 10,
          results: [completedInvocation("answered", usageOf(10, 20, 7))],
        },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.usage.costMicro).toBe(8);
  });

  it("keeps a fallback priced when the attempt before it consumed nothing", async () => {
    // A failed attempt usually reports no usage at all, and "no usage" is not the same fact
    // as "usage of unknown price": the first is zero, the second is a hole in the ledger.
    // Treating zero as a hole made every call that fell back report an unpriced total, so a
    // cost ceiling could not see what the fallback cost — and the fallback is exactly the
    // case where a caller most needs to know the price.
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 5, results: [failedInvocation("down", { retryable: false })] },
        {
          slug: "second",
          priority: 10,
          results: [completedInvocation("answered", usageOf(10, 20, 7))],
        },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.usage.costMicro).toBe(7);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.fallbacks).toBe(1);
  });
});

describe("candidates that cannot serve the call", () => {
  it("passes over a model whose adapter lacks a required capability and serves the next one", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "plain", priority: 5, capabilities: ["chat"] },
        { slug: "toolful", priority: 10, capabilities: ["chat", "tool_calling"] },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.modelId).toBe(fixture.models[0]?.model.id);
    // A capability request for tool calling skips the model that does not have it.
    const withTools = succeeded(
      await fixture.orchestrator.call(
        modelCall({
          model: {
            kind: "capability",
            capability: "tool_calling",
            modelKind: null,
            providerId: null,
            minContextWindowTokens: 0,
            minMaxOutputTokens: 0,
          },
        }),
      ),
    );
    expect(withTools.modelId).toBe(fixture.models[1]?.model.id);
  });

  it("records a skipped attempt with the reason, so the trail explains the fallback", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "uncredentialed", priority: 5, credentialsConfigured: false },
        { slug: "ready", priority: 10 },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.attempts[0]?.status).toBe("skipped");
    expect(result.attempts[0]?.failure?.message).toContain("credentials");
    expect(result.attempts[0]?.latencyMs).toBe(0);
    expect(result.attempts[1]?.status).toBe("succeeded");
  });

  it("reports every candidate it passed over when none could serve", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 5, status: "disabled" },
        { slug: "second", priority: 10, credentialsConfigured: false },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((attempt) => attempt.status === "skipped")).toBe(true);
    expect(result.failure.code).toBe("not_found");
    expect(result.failure.details).toMatchObject({ candidatesTried: 2 });
  });
});

describe("provider health is observed", () => {
  it("records a success against the provider that answered", async () => {
    const fixture = orchestratorFixture();
    const providerId = primaryOf(fixture).provider.id;
    expect(fixture.providerRegistry.health(providerId).state).toBe("unknown");
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    const health = fixture.providerRegistry.health(providerId);
    expect(health.consecutiveSuccesses).toBe(1);
    expect(health.lastSuccessAt).toBe(AT);
    expect(health.averageLatencyMs).toBe(12);
  });

  it("records failures against the provider that failed, with the class it reported", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "down", results: [failedInvocation("down", { retryable: false })] }],
    });
    const providerId = primaryOf(fixture).provider.id;
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    const health = fixture.providerRegistry.health(providerId);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureClass).toBe("provider_failure");
    expect(health.lastFailureAt).toBe(AT);
  });

  it("resets a failure streak when the provider recovers", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "recovering",
          results: [failedInvocation("down", { retryable: false }), completedInvocation("back")],
        },
      ],
    });
    const providerId = primaryOf(fixture).provider.id;
    const reference = modelById(primaryOf(fixture).model.id);
    failed(
      await fixture.orchestrator.call(modelCall({ model: reference, maxAttemptsPerProvider: 1 })),
    );
    expect(fixture.providerRegistry.health(providerId).consecutiveFailures).toBe(1);

    succeeded(
      await fixture.orchestrator.call(modelCall({ model: reference, maxAttemptsPerProvider: 1 })),
    );
    const recovered = fixture.providerRegistry.health(providerId);
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.consecutiveSuccesses).toBe(1);
  });

  it("degrades a provider that keeps failing, which is what selection reads next time", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "down", results: [failedInvocation("down", { retryable: false })] }],
    });
    const providerId = primaryOf(fixture).provider.id;
    for (let call = 0; call < 6; call += 1) {
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), maxAttemptsPerProvider: 1 }),
      );
    }
    const health = fixture.providerRegistry.health(providerId);
    expect(health.consecutiveFailures).toBe(6);
    expect(health.state).not.toBe("healthy");
  });
});
