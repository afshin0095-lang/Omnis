/**
 * When the first answer does not come, what happens next.
 *
 * Fallback is the one behaviour in the AI Core that a caller cannot implement for
 * itself: it needs the candidate list, the retry classification, the policy gate and
 * the budget, in that order, for every candidate. Getting it wrong is not a degraded
 * answer, it is an ungoverned one — a second provider called because the first refused
 * on *policy* grounds would be a policy that only applies to whoever answered first.
 *
 * Every test here watches the adapters, because "the call succeeded" is equally true of
 * a call that respected the gates and one that went around them.
 */

import { describe, expect, it } from "vitest";
import { agentBySlug, modelByCapability, modelById, textMessage } from "@omnis/ai-core-types";
import type { ModelCapability, ProviderInvocationResult } from "@omnis/ai-core-types";
import { createModelId, createProviderId } from "@omnis/types";
import { createPolicyEngine } from "@omnis/policy-engine";
import {
  AT,
  buildAiCorePlatform,
  budgetInput,
  completedInvocation,
  failedInvocation,
  FLAT_PRICING,
  scriptedAdapter,
  singleOutcomePolicySet,
  usageOf,
} from "../support/aiCoreTestPlatform.js";
import type { AiCoreTestPlatform } from "../support/aiCoreTestPlatform.js";

/** A call the platform's models are all candidates for. */
function capabilityCall() {
  return {
    model: modelByCapability("chat"),
    messages: [textMessage("user", "say something brief")],
  };
}

/** A call pinned to one model, which has exactly one candidate and nowhere to fall back to. */
function pinnedCall(platform: AiCoreTestPlatform) {
  return {
    model: modelById(platform.primary.model.id),
    messages: [textMessage("user", "say something brief")],
  };
}

/**
 * Registers a third provider and model on an existing platform.
 *
 * Two providers are enough to prove a fallback happens; a third is what proves the order
 * is a decision rather than an accident of registration.
 */
function addProvider(
  platform: AiCoreTestPlatform,
  options: {
    readonly slug: string;
    readonly priority: number;
    readonly results: readonly ProviderInvocationResult[];
  },
) {
  const providerId = createProviderId();
  const modelId = createModelId();
  const capabilities: readonly ModelCapability[] = ["chat"];
  const adapter = scriptedAdapter({
    providerId,
    slug: options.slug,
    capabilities,
    results: options.results,
  });
  const registered = platform.runtime.registerProvider(
    {
      slug: options.slug,
      displayName: options.slug,
      transport: "http",
      capabilities: {
        operations: ["chat"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        modelCapabilities: capabilities,
      },
      rateLimit: { requestsPerMinute: 600, tokensPerMinute: 100_000, maxConcurrentRequests: 8 },
      priority: options.priority,
      latencyClass: "low",
      region: null,
      credentialsConfigured: true,
      registeredAt: AT,
    },
    adapter,
  );
  const provider = platform.runtime.providers.setStatus(registered.id, "ready");
  const model = platform.runtime.registerModel({
    id: modelId,
    slug: options.slug,
    displayName: options.slug,
    providerId: provider.id,
    kind: "general",
    capabilities,
    modalities: { input: ["text"], output: ["text"] },
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    pricing: FLAT_PRICING,
    priority: options.priority,
    latencyClass: "low",
    providerModelName: options.slug,
    registeredAt: AT,
  });
  return { model, provider, adapter };
}

describe("falling back to another provider", () => {
  it("answers from the second candidate when the first refuses", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });

    const result = await platform.runtime.executeModel(capabilityCall());

    expect(result.status).toBe("succeeded");
    expect(platform.primary.adapter.invocations).toHaveLength(1);
    expect(platform.secondary?.adapter.invocations).toHaveLength(1);
    if (result.status === "succeeded") {
      expect(result.fallbacks).toBe(1);
      expect(String(result.providerId)).toBe(String(platform.secondary?.provider.id));
      // The response reported is the one that answered, not the one that was asked first.
      expect(result.response.message.content[0]).toMatchObject({
        type: "text",
        text: "the secondary answered",
      });
    }
  });

  it("does not fall back at all for a call pinned to one model", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });

    const result = await platform.runtime.executeModel(pinnedCall(platform));
    expect(result.status).toBe("failed");
    // A caller that named a model named a decision. Silently substituting another one
    // would answer a question the caller did not ask, at a price they did not agree to.
    expect(platform.secondary?.adapter.invocations).toHaveLength(0);
  });

  it("reports every candidate it tried when none of them answered", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [failedInvocation("the secondary refused too", { retryable: false })],
    });

    const result = await platform.runtime.executeModel(capabilityCall());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toHaveLength(2);
      expect(result.fallbacks).toBe(1);
      // The result names the model the call was about; the attempt trail names every
      // candidate it reached, so a caller can see the call ended at the end of the list.
      expect(String(result.modelId)).toBe(String(platform.primary.model.id));
      expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
      // The failure says what the last candidate did, and the attempts say what all of
      // them did: a caller deciding whether to retry needs both.
      expect(result.failure.message.length).toBeGreaterThan(0);
    }
    expect(platform.primary.adapter.invocations).toHaveLength(1);
    expect(platform.secondary?.adapter.invocations).toHaveLength(1);
  });

  it("keeps one span for one call, however many candidates it took", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });
    await platform.runtime.executeModel(capabilityCall());

    const modelCalls = platform.spans.filter((span) => span.recordedName.startsWith("model.call"));
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]?.ended).toBe(true);
    // A span per candidate would make one call look like two in every dashboard that
    // counts spans, and the trace would not say which one answered.
    expect(new Set(platform.spans.map((span) => String(span.context.traceId))).size).toBe(1);
  });

  it("charges the budget once for a call that needed a fallback", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });
    const budget = platform.runtime.registerBudget(budgetInput(100, "requests", "total"));

    const result = await platform.runtime.executeModel({
      ...capabilityCall(),
      budgetId: budget.id,
    });
    expect(result.status).toBe("succeeded");
    // One call is one unit of allowance. Charging per candidate would make a provider
    // outage cost the caller money twice: once for the refusal and once for the answer.
    expect(platform.runtime.budgets.reservationsForExecution(result.executionId)).toHaveLength(1);
  });

  it("reports the usage of the call that answered", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered", usageOf(7, 9, 2))],
    });

    const result = await platform.runtime.executeModel(capabilityCall());
    expect(result.status).toBe("succeeded");
    // The refused attempt consumed nothing, and a total that included it would either bill
    // for tokens nobody generated or report the whole call as unpriced, which is how a cost
    // ceiling stops being able to see what a fallback cost.
    expect(result.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 9,
      totalTokens: 16,
      costMicro: 2,
    });
  });
});

describe("retrying is not falling back", () => {
  it("tries the same provider again for a failure that says it is worth retrying", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [
        failedInvocation("the provider hiccuped", { retryable: true }),
        completedInvocation("answered on the second try"),
      ],
    });

    const result = await platform.runtime.executeModel({
      ...pinnedCall(platform),
      maxAttemptsPerProvider: 2,
    });
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.attempts).toHaveLength(2);
      // Two attempts at one candidate is a retry; a retry is not a fallback, and a
      // dashboard that counts them the same way cannot tell an outage from a hiccup.
      expect(result.fallbacks).toBe(0);
    }
    expect(platform.primary.adapter.invocations).toHaveLength(2);
    expect(platform.secondary).toBeNull();
  });

  it("does not retry a failure that says retrying will not help", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the request was refused", { retryable: false })],
    });

    const result = await platform.runtime.executeModel({
      ...pinnedCall(platform),
      maxAttemptsPerProvider: 3,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toHaveLength(1);
    }
    expect(platform.primary.adapter.invocations).toHaveLength(1);
  });

  it("never retries without a bound", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("always refusing", { retryable: true })],
    });

    const result = await platform.runtime.executeModel({
      ...pinnedCall(platform),
      maxAttemptsPerProvider: 3,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toHaveLength(3);
    }
    // An unbounded retry against a failing provider is an outage the platform causes.
    expect(platform.primary.adapter.invocations).toHaveLength(3);
  });
});

describe("which candidate is tried first", () => {
  it("tries the higher-priority provider before the lower one", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [completedInvocation("the premium answered")],
    });
    const premium = addProvider(platform, {
      slug: "premium-provider",
      priority: 1,
      results: [completedInvocation("premium answered")],
    });
    // The fixture's own provider is priority 10; a lower number is a higher priority.
    platform.runtime.providers.setStatus(platform.primary.provider.id, "ready");

    const result = await platform.runtime.executeModel(capabilityCall());
    expect(result.status).toBe("succeeded");
    expect(premium.adapter.invocations).toHaveLength(1);
    // The cheaper, higher-priority provider answered, so the fixture's provider was never
    // asked: selection is what keeps a call off an expensive path nobody chose.
    expect(platform.primary.adapter.invocations).toHaveLength(0);
    if (result.status === "succeeded") {
      expect(String(result.providerId)).toBe(String(premium.provider.id));
      expect(result.fallbacks).toBe(0);
    }
  });

  it("skips a provider that has been disabled, without failing the call", async () => {
    const platform = buildAiCorePlatform({
      secondaryResults: [completedInvocation("the secondary answered")],
    });
    platform.runtime.providers.setStatus(platform.primary.provider.id, "disabled");

    const result = await platform.runtime.executeModel(capabilityCall());
    expect(result.status).toBe("succeeded");
    // A disabled provider is not a candidate: calling one would be calling something an
    // operator deliberately turned off, which is how a decommissioned account gets billed.
    expect(platform.primary.adapter.invocations).toHaveLength(0);
    expect(platform.secondary?.adapter.invocations).toHaveLength(1);
    if (result.status === "succeeded") {
      // Moving past an unusable candidate is itself a candidate switch, and saying so is
      // what lets a reader tell "the first provider was off" from "the first provider
      // answered". The attempt trail names the reason: the skipped one is recorded.
      expect(result.fallbacks).toBe(1);
      expect(result.attempts.map((attempt) => attempt.status)).toEqual(["skipped", "succeeded"]);
    }
  });

  it("still uses a degraded provider when it is the only one left", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [completedInvocation("answered while degraded")],
    });
    platform.runtime.providers.setStatus(platform.primary.provider.id, "degraded");

    const result = await platform.runtime.executeModel(pinnedCall(platform));
    // Degraded is not disabled. Refusing to use the only provider that exists would turn a
    // partial outage into a total one.
    expect(result.status).toBe("succeeded");
    expect(platform.primary.adapter.invocations).toHaveLength(1);
  });

  it("bounds how many candidates one call may try", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [failedInvocation("the secondary refused", { retryable: false })],
    });
    const third = addProvider(platform, {
      slug: "third-provider",
      priority: 50,
      results: [completedInvocation("the third answered")],
    });

    const result = await platform.runtime.executeModel({ ...capabilityCall(), maxProviders: 2 });
    expect(result.status).toBe("failed");
    expect(platform.primary.adapter.invocations).toHaveLength(1);
    expect(platform.secondary?.adapter.invocations).toHaveLength(1);
    // The bound is the point: a call that walks every registered provider turns one
    // request into an outage-wide retry storm, and the caller asked for two.
    expect(third.adapter.invocations).toHaveLength(0);
  });

  it("lists the candidates a capability resolves to, before anything is spent", () => {
    const platform = buildAiCorePlatform({
      secondaryResults: [completedInvocation("the secondary answered")],
    });
    const third = addProvider(platform, {
      slug: "third-provider",
      priority: 50,
      results: [completedInvocation("the third answered")],
    });
    const candidates = platform.runtime.orchestrator.candidatesFor(modelByCapability("chat"));

    expect(candidates.map((candidate) => candidate.slug)).toEqual([
      "primary",
      "secondary",
      "third-provider",
    ]);
    // The candidate list is a fact a caller can read before spending anything, which is
    // what makes "why did my call go to that provider?" answerable without a trace.
    expect(candidates.map((candidate) => String(candidate.providerId))).toContain(
      String(third.provider.id),
    );
  });
});

describe("a fallback is a governed call too", () => {
  it("never reaches a provider when policy refuses the call", async () => {
    const policyEngine = createPolicyEngine({ clock: () => AT });
    const set = policyEngine.registerPolicySet(singleOutcomePolicySet("deny"));
    const platform = buildAiCorePlatform({
      runtime: { policyEngine },
      defaultPolicyIds: [set.id],
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });

    const result = await platform.runtime.executeModel(capabilityCall());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.class).toBe("policy_blocked");
    }
    // Neither candidate was asked: a denial applies to the call, not to the first
    // provider that happens to be in the list.
    expect(platform.primary.adapter.invocations).toHaveLength(0);
    expect(platform.secondary?.adapter.invocations).toHaveLength(0);
  });

  it("never reaches a provider when the budget cannot cover the call", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });
    const budget = platform.runtime.registerBudget(budgetInput(1, "cost_micro_usd", "total"));

    const result = await platform.runtime.executeModel({
      ...capabilityCall(),
      budgetId: budget.id,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.class).toBe("budget_blocked");
    }
    expect(platform.primary.adapter.invocations).toHaveLength(0);
    expect(platform.secondary?.adapter.invocations).toHaveLength(0);
  });
});

describe("an agent run survives a provider outage", () => {
  it("names the model each step runs against, and does not substitute one mid-run", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [completedInvocation("the secondary answered")],
    });

    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
      // A step may ask for a capability, but the plan resolves it to one model before the
      // run starts: an approved plan says what it will run, and a substitution decided
      // mid-run would be a different plan from the one anybody looked at.
      steps: [{ id: "answer", kind: "model", model: modelByCapability("chat") }],
    });

    expect(String(result.record.plan?.steps[0]?.modelId)).toBe(String(platform.primary.model.id));
    expect(result.status).toBe("failed");
    expect(platform.secondary?.adapter.invocations).toHaveLength(0);
    // Fallback belongs to a direct model call, where the caller asked for "a model that can
    // do this" rather than for this one.
    const direct = await platform.runtime.executeModel(capabilityCall());
    expect(direct.status).toBe("succeeded");
    expect(platform.secondary?.adapter.invocations).toHaveLength(1);
  });

  it("fails the run, with a record, when no provider can answer", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the primary refused", { retryable: false })],
      secondaryResults: [failedInvocation("the secondary refused too", { retryable: false })],
    });

    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
      steps: [{ id: "answer", kind: "model", model: modelByCapability("chat"), maxAttempts: 1 }],
    });

    expect(result.status).toBe("failed");
    expect(result.instance.state).toBe("failed");
    expect(result.failure).not.toBeNull();
    expect(platform.runtime.listExecutions()).toHaveLength(1);
    // A run that produced nothing still produced a record: without it, the only evidence
    // that the work was attempted would be a provider's own logs.
    expect(platform.runtime.requireExecution(result.record.request.id).status).toBe("failed");
  });
});
