import { describe, expect, it } from "vitest";
import { createExecutionId, createModelId, createProviderId } from "@omnis/types";
import { EMPTY_USAGE } from "@omnis/ai-core-types";
import type {
  ExecutionFailure,
  Message,
  ModelDescriptor,
  UsageSummary,
} from "@omnis/ai-core-types";
import { InMemoryModelRegistry } from "@omnis/model-registry";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { createCancellationSource, ExecutionScope } from "@omnis/execution-context";
import {
  buildModelRequest,
  CHARACTERS_PER_ESTIMATED_TOKEN,
  describeCallTarget,
  estimateInputTokens,
  failureFromAdapter,
  holdsForCall,
  holdsForUsage,
  impliedCapabilities,
  invocationContext,
  invocationDelayMs,
  invocationTimeoutMs,
  isProviderRetryable,
  normalizeInvocationResult,
  shouldTryNextProvider,
  toolsOf,
} from "./invocation.js";
import { modelParameters } from "./ModelCall.js";
import type { ModelCallRequest } from "./ModelCall.js";
import {
  AT,
  AT_MS,
  completedInvocation,
  FLAT_PRICING,
  failedInvocation,
  registerModel,
  testClock,
  toolSpec,
  usageOf,
} from "./testSupport.js";

const PROVIDER_ID = createProviderId();
const registry = new InMemoryModelRegistry({ clock: () => AT });

/** A counter rather than randomness: a slug that changes between runs makes a failure unreproducible. */
let sequence = 0;
function nextSlug(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence)}`;
}

/** A priced chat model, as most tests want one. */
function pricedModel(
  overrides: Partial<Parameters<typeof registerModel>[1]> = {},
): ModelDescriptor {
  return registerModel(registry, {
    slug: nextSlug("priced"),
    providerId: PROVIDER_ID,
    pricing: FLAT_PRICING,
    maxOutputTokens: 1_000,
    ...overrides,
  });
}

/** An unpriced model: pricing is genuinely unknown, which is not the same as free. */
function unpricedModel(): ModelDescriptor {
  return registerModel(registry, {
    slug: nextSlug("local"),
    providerId: PROVIDER_ID,
    pricing: null,
    maxOutputTokens: 512,
  });
}

function textMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], name: null, metadata: {} };
}

function call(overrides: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    model: { kind: "id", modelId: createModelId() },
    messages: [textMessage("hello there")],
    ...overrides,
  };
}

function failure(overrides: Partial<ExecutionFailure> = {}): ExecutionFailure {
  return {
    class: "provider_failure",
    code: "provider_failure",
    message: "the provider refused",
    retryable: true,
    retryAfterMs: null,
    attempt: 1,
    stepId: null,
    executionId: null,
    modelId: null,
    providerId: null,
    toolId: null,
    details: {},
    occurredAt: AT,
    ...overrides,
  };
}

describe("impliedCapabilities", () => {
  it("implies chat for a plain call", () => {
    expect(impliedCapabilities(call(), modelParameters())).toEqual(["chat"]);
  });

  it("implies streaming when a stream is asked for", () => {
    expect(impliedCapabilities(call({ streaming: true }), modelParameters())).toEqual([
      "chat",
      "streaming",
    ]);
  });

  it("implies tool calling when tools are supplied", () => {
    const withTools = call({ tools: [toolSpec()] });
    expect(impliedCapabilities(withTools, modelParameters())).toEqual(["chat", "tool_calling"]);
  });

  it("implies structured output for a JSON response format", () => {
    expect(
      impliedCapabilities(call(), modelParameters({ responseFormat: { type: "json_object" } })),
    ).toContain("structured_output");
    expect(
      impliedCapabilities(
        call(),
        modelParameters({ responseFormat: { type: "json_schema", name: "shape", schema: {} } }),
      ),
    ).toContain("structured_output");
  });

  it("does not imply structured output for a plain text format", () => {
    expect(
      impliedCapabilities(call(), modelParameters({ responseFormat: { type: "text" } })),
    ).toEqual(["chat"]);
  });

  it("appends required capabilities without duplicating an implied one", () => {
    const capabilities = impliedCapabilities(
      call({ streaming: true, requiredCapabilities: ["streaming", "reasoning"] }),
      modelParameters(),
    );
    expect(capabilities).toEqual(["chat", "streaming", "reasoning"]);
  });

  it("freezes what it returns", () => {
    expect(Object.isFrozen(impliedCapabilities(call(), modelParameters()))).toBe(true);
  });
});

describe("estimateInputTokens", () => {
  it("counts text at the documented characters-per-token ratio", () => {
    expect(estimateInputTokens([textMessage("abcdefgh")])).toBe(8 / CHARACTERS_PER_ESTIMATED_TOKEN);
  });

  it("rounds up, because a partial token is still a token a provider charges for", () => {
    expect(estimateInputTokens([textMessage("abcde")])).toBe(2);
  });

  it("counts every text and reasoning part across the conversation", () => {
    const messages: Message[] = [
      textMessage("aaaa"),
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "bbbb", redacted: false }],
        name: null,
        metadata: {},
      },
      textMessage("cccc"),
    ];
    expect(estimateInputTokens(messages)).toBe(3);
  });

  it("counts no tokens for content it cannot measure", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            reference: "https://example.invalid/a.png",
            description: null,
          },
        ],
        name: null,
        metadata: {},
      },
    ];
    expect(estimateInputTokens(messages)).toBe(0);
  });

  it("counts nothing for an empty conversation", () => {
    expect(estimateInputTokens([])).toBe(0);
  });
});

describe("holdsForCall", () => {
  it("holds tokens, requests, model calls and cost for a priced model", () => {
    const descriptor = pricedModel();
    const holds = holdsForCall(descriptor, modelParameters(), [textMessage("aaaa")]);
    const dimensions = holds.map((hold) => hold.dimension);
    expect(dimensions).toContain("tokens");
    expect(dimensions).toContain("requests");
    expect(dimensions).toContain("model_calls");
    expect(dimensions).toContain("cost_micro_usd");
  });

  it("holds against the declared maximum output, not against a guess about the answer", () => {
    const descriptor = pricedModel({ maxOutputTokens: 1_000 });
    const holds = holdsForCall(descriptor, modelParameters(), [textMessage("aaaa")]);
    const tokens = holds.find((hold) => hold.dimension === "tokens");
    expect(tokens?.amount).toBe(1_001);
  });

  it("prefers the caller's output limit over the model's", () => {
    const descriptor = pricedModel({ maxOutputTokens: 1_000 });
    const holds = holdsForCall(descriptor, modelParameters({ maxOutputTokens: 50 }), [
      textMessage("aaaa"),
    ]);
    expect(holds.find((hold) => hold.dimension === "tokens")?.amount).toBe(51);
  });

  it("holds no cost for an unpriced model, and says so by omission", () => {
    const holds = holdsForCall(unpricedModel(), modelParameters(), [textMessage("aaaa")]);
    expect(holds.map((hold) => hold.dimension)).not.toContain("cost_micro_usd");
    expect(holds.map((hold) => hold.dimension)).toContain("tokens");
  });

  it("holds integer micro-USD, because money is never a float here", () => {
    const holds = holdsForCall(pricedModel(), modelParameters(), [textMessage("aaaa")]);
    const cost = holds.find((hold) => hold.dimension === "cost_micro_usd");
    expect(Number.isInteger(cost?.amount)).toBe(true);
  });
});

describe("holdsForUsage", () => {
  it("holds what was measured", () => {
    const usage: UsageSummary = { ...usageOf(100, 200, null), requests: 1 };
    const holds = holdsForUsage(pricedModel(), usage);
    expect(holds.find((hold) => hold.dimension === "tokens")?.amount).toBe(300);
    expect(holds.find((hold) => hold.dimension === "requests")?.amount).toBe(1);
  });

  it("charges nothing for empty usage", () => {
    expect(holdsForUsage(pricedModel(), EMPTY_USAGE)).toEqual([]);
  });

  it("counts cached input tokens at the discounted rate when the model publishes one", () => {
    const descriptor = pricedModel({
      pricing: { ...FLAT_PRICING, cachedInputPerThousandTokens: 10 },
    });
    // Cached tokens are a subset of input tokens: 500 at full price and 500 at the discount.
    const usage = { ...usageOf(1_000, 0, null), cachedInputTokens: 500 };
    const cost = holdsForUsage(descriptor, usage).find(
      (hold) => hold.dimension === "cost_micro_usd",
    );
    expect(cost?.amount).toBe(55);
  });

  it("refuses usage that claims more cached tokens than it received", () => {
    const descriptor = pricedModel({
      pricing: { ...FLAT_PRICING, cachedInputPerThousandTokens: 10 },
    });
    expect(() =>
      holdsForUsage(descriptor, { ...usageOf(100, 0, null), cachedInputTokens: 500 }),
    ).toThrow(RangeError);
  });
});

describe("buildModelRequest", () => {
  it("gives the adapter the vendor-facing model name, so it never has to consult a registry", () => {
    const descriptor = pricedModel({ providerModelName: "vendor-chat-3" });
    const request = buildModelRequest(descriptor, call(), modelParameters(), false);
    expect(request.providerModelName).toBe("vendor-chat-3");
    expect(request.modelId).toBe(descriptor.id);
    expect(request.providerId).toBe(descriptor.providerId);
  });

  it("carries the streaming flag the call asked for", () => {
    const descriptor = pricedModel();
    expect(buildModelRequest(descriptor, call(), modelParameters(), true).streaming).toBe(true);
    expect(buildModelRequest(descriptor, call(), modelParameters(), false).streaming).toBe(false);
  });

  it("copies the conversation and the tools rather than sharing them", () => {
    const descriptor = pricedModel();
    const messages = [textMessage("hi")];
    const request = buildModelRequest(
      descriptor,
      call({ messages, tools: [] }),
      modelParameters(),
      false,
    );
    expect(request.messages).toEqual(messages);
    expect(request.messages).not.toBe(messages);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.messages)).toBe(true);
  });

  it("passes call metadata through, because an adapter may need a tenant header", () => {
    const descriptor = pricedModel();
    const request = buildModelRequest(
      descriptor,
      call({ metadata: { tenant: "acme" } }),
      modelParameters(),
      false,
    );
    expect(request.metadata).toEqual({ tenant: "acme" });
  });
});

describe("invocationContext", () => {
  const descriptor = pricedModel();
  const scope = ExecutionScope.createRoot(
    { executionId: createExecutionId(), mode: "interactive" },
    { clock: testClock() },
  );

  it("tells the adapter how long it has and which attempt this is", () => {
    const context = invocationContext({
      context: scope.context,
      descriptor,
      attempt: 2,
      timeoutMs: 1_500,
      streaming: false,
      remainingMs: () => 4_000,
    });
    expect(context.attempt).toBe(2);
    expect(context.timeoutMs).toBe(1_500);
    expect(context.modelId).toBe(descriptor.id);
    expect(context.providerId).toBe(descriptor.providerId);
    expect(context.streaming).toBe(false);
  });

  it("reports cancellation from the scope's own token", () => {
    const source = createCancellationSource();
    const cancellable = ExecutionScope.createRoot(
      { cancellation: source.token },
      { clock: testClock() },
    );
    const context = invocationContext({
      context: cancellable.context,
      descriptor,
      attempt: 1,
      timeoutMs: 100,
      streaming: false,
      remainingMs: () => null,
    });
    expect(context.isCancelled()).toBe(false);
    source.cancel("stop");
    expect(context.isCancelled()).toBe(true);
  });

  it("delegates remaining time instead of snapshotting it", () => {
    const clock = testClock();
    const bounded = ExecutionScope.createRoot({ deadlineMs: 1_000 }, { clock });
    const context = invocationContext({
      context: bounded.context,
      descriptor,
      attempt: 1,
      timeoutMs: 500,
      streaming: false,
      remainingMs: () => bounded.remainingMs(),
    });
    expect(context.remainingMs()).toBe(1_000);
    clock.advance(400);
    expect(context.remainingMs()).toBe(600);
  });

  it("freezes the metadata it hands over", () => {
    const context = invocationContext({
      context: scope.context,
      descriptor,
      attempt: 1,
      timeoutMs: 100,
      streaming: false,
      remainingMs: () => null,
      metadata: { fallbackDepth: 1 },
    });
    expect(context.metadata).toEqual({ fallbackDepth: 1 });
    expect(Object.isFrozen(context.metadata)).toBe(true);
  });
});

describe("invocationTimeoutMs", () => {
  it("takes the tightest of what the caller, policy and the deadline allow", () => {
    expect(
      invocationTimeoutMs({
        requested: 5_000,
        policyLimit: 2_000,
        remainingMs: 3_000,
        fallback: 30_000,
      }),
    ).toBe(2_000);
  });

  it("falls back when nothing bounds the call", () => {
    expect(
      invocationTimeoutMs({
        requested: null,
        policyLimit: null,
        remainingMs: null,
        fallback: 30_000,
      }),
    ).toBe(30_000);
  });

  it("ignores a non-positive or non-finite bound", () => {
    expect(
      invocationTimeoutMs({
        requested: 0,
        policyLimit: -5,
        remainingMs: Number.NaN,
        fallback: 900,
      }),
    ).toBe(900);
  });

  it("never returns zero, because a zero timeout would fail every call", () => {
    expect(
      invocationTimeoutMs({ requested: 0.4, policyLimit: null, remainingMs: null, fallback: 900 }),
    ).toBe(1);
  });

  it("truncates rather than rounding up, so an adapter is never given more time than it was allowed", () => {
    expect(
      invocationTimeoutMs({
        requested: 1_000.9,
        policyLimit: null,
        remainingMs: null,
        fallback: 900,
      }),
    ).toBe(1_000);
  });
});

describe("normalizeInvocationResult", () => {
  const descriptor = pricedModel();
  const input = {
    executionId: createExecutionId(),
    descriptor,
    attempt: 1,
    startedAtMs: AT_MS,
    clock: () => AT_MS + 7,
  };

  it("passes a completed result through untouched", () => {
    const completed = completedInvocation("answered");
    expect(normalizeInvocationResult(completed, input)).toBe(completed);
  });

  it("passes a failed result through with its own classification", () => {
    const failed = failedInvocation("rate limited", {
      failureClass: "retryable",
      retryAfterMs: 250,
    });
    const normalized = normalizeInvocationResult(failed, input);
    expect(normalized.status).toBe("failed");
    if (normalized.status === "failed") {
      expect(normalized.failure.class).toBe("retryable");
      expect(normalized.failure.retryAfterMs).toBe(250);
    }
  });

  it("measures latency from the clock when the adapter reports none", () => {
    const normalized = normalizeInvocationResult(
      { status: "failed", failure: failure(), usage: EMPTY_USAGE },
      input,
    );
    expect(normalized.latencyMs).toBe(7);
  });

  it("reports null as a provider failure rather than inventing a response", () => {
    const normalized = normalizeInvocationResult(null, input);
    expect(normalized.status).toBe("failed");
    if (normalized.status === "failed") {
      expect(normalized.failure.class).toBe("provider_failure");
      expect(normalized.failure.retryable).toBe(false);
      expect(normalized.failure.message).toContain("returned no result");
    }
  });

  it("reports an unrecognized object as a provider failure", () => {
    const normalized = normalizeInvocationResult({ status: "completed" }, input);
    expect(normalized.status).toBe("failed");
    if (normalized.status === "failed") {
      expect(normalized.failure.class).toBe("provider_failure");
      expect(normalized.failure.message).toContain("unrecognized result");
      expect(normalized.failure.modelId).toBe(descriptor.id);
      expect(normalized.failure.providerId).toBe(descriptor.providerId);
    }
  });

  it("stamps the execution identity onto the failure it produces", () => {
    const normalized = normalizeInvocationResult(undefined, input);
    if (normalized.status === "failed") {
      expect(normalized.failure.executionId).toBe(input.executionId);
      expect(normalized.failure.attempt).toBe(1);
    } else {
      expect.unreachable("an absent result is a failure");
    }
  });
});

describe("failureFromAdapter", () => {
  const descriptor = pricedModel();
  const input = { executionId: createExecutionId(), descriptor, attempt: 2 };

  it("classifies a platform error by its code", () => {
    expect(failureFromAdapter(new NotFoundError("model", "gone"), input).class).toBe(
      "non_retryable",
    );
    expect(failureFromAdapter(new ValidationError("bad request"), input).class).toBe("validation");
  });

  it("classifies a bare throw as a provider failure, because the only code in between is the adapter", () => {
    const normalized = failureFromAdapter(new Error("socket hang up"), input);
    expect(normalized.class).toBe("provider_failure");
    expect(normalized.retryable).toBe(false);
    expect(normalized.message).toBe("socket hang up");
  });

  it("carries the identifiers of the model and provider that failed", () => {
    const normalized = failureFromAdapter(new ConflictError("provider", "conflict"), input);
    expect(normalized.modelId).toBe(descriptor.id);
    expect(normalized.providerId).toBe(descriptor.providerId);
    expect(normalized.executionId).toBe(input.executionId);
    expect(normalized.attempt).toBe(2);
  });

  it("classifies a non-error value rather than throwing on it", () => {
    expect(() => failureFromAdapter("it broke", input)).not.toThrow();
    expect(failureFromAdapter("it broke", input).message).toBe("it broke");
  });
});

describe("isProviderRetryable", () => {
  it("retries a retryable provider failure", () => {
    expect(isProviderRetryable(failure({ class: "provider_failure", retryable: true }))).toBe(true);
    expect(isProviderRetryable(failure({ class: "retryable", retryable: true }))).toBe(true);
  });

  it("does not retry a failure the provider marked non-retryable", () => {
    expect(isProviderRetryable(failure({ class: "provider_failure", retryable: false }))).toBe(
      false,
    );
  });

  it("does not retry a fact about the call", () => {
    for (const failureClass of [
      "validation",
      "policy_blocked",
      "budget_blocked",
      "cancelled",
      "non_retryable",
    ] as const) {
      expect(isProviderRetryable(failure({ class: failureClass, retryable: true }))).toBe(false);
    }
  });

  it("does not retry a timeout against the same provider", () => {
    expect(isProviderRetryable(failure({ class: "deadline_exceeded", retryable: true }))).toBe(
      false,
    );
  });
});

describe("shouldTryNextProvider", () => {
  it("falls back after a provider failure, a retryable failure or a timeout", () => {
    expect(shouldTryNextProvider(failure({ class: "provider_failure" }))).toBe(true);
    expect(shouldTryNextProvider(failure({ class: "retryable" }))).toBe(true);
    expect(shouldTryNextProvider(failure({ class: "deadline_exceeded" }))).toBe(true);
  });

  it("does not fall back around governance", () => {
    expect(shouldTryNextProvider(failure({ class: "policy_blocked" }))).toBe(false);
    expect(shouldTryNextProvider(failure({ class: "budget_blocked" }))).toBe(false);
    expect(shouldTryNextProvider(failure({ class: "cancelled" }))).toBe(false);
    expect(shouldTryNextProvider(failure({ class: "validation" }))).toBe(false);
  });

  it("does not fall back on a classification it does not recognize", () => {
    expect(shouldTryNextProvider(failure({ class: "unknown" }))).toBe(false);
    expect(shouldTryNextProvider(failure({ class: "non_retryable" }))).toBe(false);
  });
});

describe("invocationDelayMs", () => {
  it("honours what the provider asked for", () => {
    expect(invocationDelayMs(failure({ retryAfterMs: 1_200 }), 0)).toBe(1_200);
  });

  it("uses the configured delay when the provider asked for nothing", () => {
    expect(invocationDelayMs(failure({ retryAfterMs: null }), 250)).toBe(250);
    expect(invocationDelayMs(null, 250)).toBe(250);
  });

  it("clamps to the published maximum, so a provider cannot stall an execution", () => {
    expect(invocationDelayMs(failure({ retryAfterMs: 600_000 }), 0, 30_000)).toBe(30_000);
  });

  it("waits zero rather than a negative or non-finite amount", () => {
    expect(invocationDelayMs(failure({ retryAfterMs: -10 }), 0)).toBe(0);
    expect(invocationDelayMs(failure({ retryAfterMs: Number.NaN }), 0)).toBe(0);
  });
});

describe("describeCallTarget and toolsOf", () => {
  it("renders a target as provider and slug, which is safe to log", () => {
    const descriptor = pricedModel({ slug: "chat-mini" });
    expect(describeCallTarget(descriptor)).toBe(`${PROVIDER_ID}/chat-mini`);
  });

  it("freezes the tool list it returns", () => {
    const tools = [toolSpec()];
    const frozen = toolsOf(call({ tools }));
    expect(frozen).toEqual(tools);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it("returns an empty list for a call with no tools", () => {
    expect(toolsOf(call())).toEqual([]);
  });
});
