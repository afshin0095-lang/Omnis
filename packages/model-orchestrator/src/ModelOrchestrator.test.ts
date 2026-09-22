import { describe, expect, it } from "vitest";
import { createAgentId, createExecutionId, createTenantId } from "@omnis/types";
import { modelByCapability, modelById, modelBySlug } from "@omnis/ai-core-types";
import { ExecutionScope, toIso } from "@omnis/execution-context";
import { ValidationError } from "@omnis/errors";
import {
  createModelOrchestrator,
  InMemoryModelOrchestrator,
  MAX_CALL_CANDIDATES,
} from "./ModelOrchestrator.js";
import {
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_MAX_PROVIDER_ATTEMPTS,
  MAX_PROVIDER_ATTEMPTS,
} from "./ModelCall.js";
import type { ModelCallResult } from "./ModelCall.js";
import type { FixtureModel, OrchestratorFixture } from "./testSupport.js";
import {
  AT,
  cancellableContext,
  completedInvocation,
  failedInvocation,
  modelCall,
  orchestratorFixture,
  testClock,
  toolSpec,
  userMessage,
} from "./testSupport.js";

/** The one model a default fixture registers, asserted present so a test can name it. */
function primaryOf(fixture: OrchestratorFixture): FixtureModel {
  const model = fixture.primary;
  expect(model).not.toBeNull();
  return model as FixtureModel;
}

/** Narrows a result to the success branch, failing the test when it is not one. */
function succeeded(result: ModelCallResult): Extract<ModelCallResult, { status: "succeeded" }> {
  if (result.status !== "succeeded") {
    expect.unreachable(
      `the call failed: ${result.failure.class}(${result.failure.code}): ${result.failure.message}`,
    );
  }
  return result;
}

/** Narrows a result to the failure branch. */
function failed(result: ModelCallResult): Extract<ModelCallResult, { status: "failed" }> {
  if (result.status !== "failed") {
    expect.unreachable("the call was expected to fail");
  }
  return result;
}

describe("a call that nothing interferes with", () => {
  it("reports success with the model and provider that answered", async () => {
    const fixture = orchestratorFixture();
    const model = primaryOf(fixture);
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(model.model.id) })),
    );
    expect(result.status).toBe("succeeded");
    expect(result.modelId).toBe(model.model.id);
    expect(result.providerId).toBe(model.provider.id);
    expect(result.fallbacks).toBe(0);
    expect(result.attempts).toHaveLength(1);
  });

  it("names the model and provider that answered on the response itself", async () => {
    const fixture = orchestratorFixture();
    const model = primaryOf(fixture);
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(model.model.id) })),
    );
    // The adapter's fixture response carries placeholder identifiers: which descriptor served the
    // call is the orchestrator's knowledge, not the adapter's.
    expect(result.response.modelId).toBe(model.model.id);
    expect(result.response.providerId).toBe(model.provider.id);
    expect(result.response.message.content).toEqual([{ type: "text", text: "primary answered" }]);
  });

  it("reports the usage the provider measured", async () => {
    const fixture = orchestratorFixture();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(34);
    expect(result.usage.costMicro).toBe(4);
    expect(result.attempts[0]?.usage).toEqual(result.usage);
  });

  it("records one attempt row with the timestamps of the clock it was given", async () => {
    const fixture = orchestratorFixture();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    const attempt = result.attempts[0];
    expect(attempt?.status).toBe("succeeded");
    expect(attempt?.attempt).toBe(1);
    expect(attempt?.fallbackDepth).toBe(0);
    expect(attempt?.startedAt).toBe(AT);
    expect(attempt?.finishedAt).toBe(AT);
    expect(attempt?.failure).toBeNull();
    expect(result.startedAt).toBe(AT);
    expect(result.completedAt).toBe(AT);
  });

  it("measures the whole call with the clock, including time the provider took", async () => {
    const clock = testClock();
    const fixture = orchestratorFixture({
      clock,
      models: [{ slug: "slow", onInvoke: () => clock.advance(120) }],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.latencyMs).toBe(120);
    expect(result.completedAt).toBe(toIso(clock.now()));
  });

  it("reports no policy and no budget when neither was configured", async () => {
    const fixture = orchestratorFixture();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.policyOutcome).toBeNull();
    expect(result.policyId).toBeNull();
    expect(result.budgetId).toBeNull();
    expect(result.budgetStatus).toBeNull();
  });

  it("freezes the result and its attempt rows, so a caller cannot rewrite history", async () => {
    const fixture = orchestratorFixture();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attempts)).toBe(true);
    expect(Object.isFrozen(result.attempts[0])).toBe(true);
  });

  it("keeps two calls apart: neither sees the other's attempts", async () => {
    const fixture = orchestratorFixture();
    const reference = modelById(primaryOf(fixture).model.id);
    const first = succeeded(await fixture.orchestrator.call(modelCall({ model: reference })));
    const second = succeeded(await fixture.orchestrator.call(modelCall({ model: reference })));
    expect(first.attempts).toHaveLength(1);
    expect(second.attempts).toHaveLength(1);
    expect(first.executionId).not.toBe(second.executionId);
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(2);
  });
});

describe("identity and context", () => {
  it("reuses an execution identifier the caller already opened", async () => {
    const fixture = orchestratorFixture();
    const executionId = createExecutionId();
    const result = await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id), executionId }),
    );
    expect(result.executionId).toBe(executionId);
  });

  it("mints an execution identifier when the caller has none", async () => {
    const fixture = orchestratorFixture();
    const result = await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id) }),
    );
    expect(result.executionId).toMatch(/^exe_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("carries the caller's correlation, tenant and agent into the scope it opens", async () => {
    const fixture = orchestratorFixture();
    const parent = ExecutionScope.createRoot(
      { tenantId: createTenantId(), agentId: createAgentId() },
      { clock: testClock() },
    );
    await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id) }),
      parent.context,
    );
    const span = fixture.spans[0];
    expect(span?.recordedAttributes["omnis.ai.tenant.id"]).toBe(parent.context.tenantId);
    expect(span?.recordedAttributes["omnis.ai.agent.id"]).toBe(parent.context.agentId);
  });

  it("opens a child scope for a caller's context, so cancelling the call cannot cancel the caller", async () => {
    const fixture = orchestratorFixture();
    const parent = cancellableContext();
    const result = succeeded(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        parent.context,
      ),
    );
    expect(result.executionId).not.toBe(parent.context.executionId);
    expect(parent.scope.isDisposed).toBe(false);
  });

  it("puts the caller's execution on the span as the parent of this one", async () => {
    const fixture = orchestratorFixture();
    const parent = cancellableContext();
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        correlationId: parent.context.correlationId,
      }),
      parent.context,
    );
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.correlation.id"]).toBe(
      parent.context.correlationId,
    );
  });
});

describe("resolution", () => {
  it("resolves a slug to the model registered under it", async () => {
    const fixture = orchestratorFixture({ models: [{ slug: "chat-mini" }] });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelBySlug("chat-mini") })),
    );
    expect(result.modelId).toBe(fixture.primary?.model.id);
  });

  it("resolves a capability request to the highest-priority model that has it", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "fallback", priority: 50 },
        { slug: "preferred", priority: 5 },
      ],
    });
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelByCapability("chat") })),
    );
    expect(result.modelId).toBe(fixture.models[1]?.model.id);
  });

  it("lists the candidates a reference resolves to, in the order it would try them", () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "fallback", priority: 50 },
        { slug: "preferred", priority: 5 },
      ],
    });
    const candidates = fixture.orchestrator.candidatesFor(modelByCapability("chat"));
    expect(candidates.map((candidate) => candidate.slug)).toEqual(["preferred", "fallback"]);
    expect(candidates[0]?.priority).toBe(5);
  });

  it("lists no candidates for a reference nothing matches", () => {
    const fixture = orchestratorFixture();
    expect(fixture.orchestrator.candidatesFor(modelBySlug("does-not-exist"))).toEqual([]);
  });

  it("fails as a missing model when nothing matches, without touching a provider", async () => {
    const fixture = orchestratorFixture();
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelBySlug("does-not-exist") })),
    );
    expect(result.failure.class).toBe("non_retryable");
    expect(result.failure.code).toBe("not_found");
    expect(result.attempts).toHaveLength(0);
    expect(result.modelId).toBeNull();
    expect(fixture.models[0]?.adapter.invocations).toHaveLength(0);
  });

  it("bounds how many candidates one call considers", async () => {
    const models = Array.from({ length: MAX_CALL_CANDIDATES + 3 }, (_, index) => ({
      slug: `model-${String(index)}`,
      priority: index + 1,
      results: [failedInvocation("down", { retryable: false })],
    }));
    const fixture = orchestratorFixture({ models });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelByCapability("chat"), maxProviders: MAX_CALL_CANDIDATES }),
      ),
    );
    expect(result.attempts.length).toBeLessThanOrEqual(MAX_CALL_CANDIDATES);
    expect(result.status).toBe("failed");
  });

  it("honours a caller's smaller provider bound", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "first", priority: 1, results: [failedInvocation("down")] },
        { slug: "second", priority: 2 },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelByCapability("chat"), maxProviders: 1 }),
      ),
    );
    expect(result.attempts).toHaveLength(DEFAULT_MAX_PROVIDER_ATTEMPTS);
    expect(fixture.models[1]?.adapter.invocations).toHaveLength(0);
  });
});

describe("what the provider is sent", () => {
  it("sends the vendor-facing model name and the conversation", async () => {
    const fixture = orchestratorFixture({ models: [{ slug: "primary" }] });
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    const sent = fixture.primary?.adapter.invocations[0]?.request;
    expect(sent?.providerModelName).toBe("primary");
    expect(sent?.messages).toEqual([userMessage("hello")]);
  });

  it("fills in the parameters a caller left out, so an adapter always sees the whole shape", async () => {
    const fixture = orchestratorFixture();
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        parameters: { temperature: 0.4 },
      }),
    );
    const sent = fixture.primary?.adapter.invocations[0]?.request;
    expect(sent?.parameters).toEqual({
      temperature: 0.4,
      topP: null,
      maxOutputTokens: null,
      stop: [],
      seed: null,
      responseFormat: null,
    });
  });

  it("passes call metadata to the adapter, which may need it for a tenant header", async () => {
    const fixture = orchestratorFixture();
    await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id), metadata: { tenant: "acme" } }),
    );
    expect(fixture.primary?.adapter.invocations[0]?.request.metadata).toEqual({ tenant: "acme" });
  });

  it("tells the adapter how long it has, taking the tightest bound available", async () => {
    const fixture = orchestratorFixture();
    await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id), timeoutMs: 1_500 }),
    );
    expect(fixture.primary?.adapter.invocations[0]?.context.timeoutMs).toBe(1_500);
  });

  it("bounds an invocation by the call deadline even when the caller asked for more", async () => {
    const fixture = orchestratorFixture();
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        timeoutMs: 60_000,
        deadlineMs: 400,
      }),
    );
    expect(fixture.primary?.adapter.invocations[0]?.context.timeoutMs).toBe(400);
  });

  it("falls back to the configured per-invocation timeout when nothing bounds the call", async () => {
    const fixture = orchestratorFixture({ defaultTimeoutMs: 2_500 });
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    expect(fixture.primary?.adapter.invocations[0]?.context.timeoutMs).toBe(2_500);
    expect(DEFAULT_INVOCATION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("reports the attempt number to the adapter, so a provider can log its own retries", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "flaky",
          results: [failedInvocation("rate limited"), completedInvocation("second time")],
        },
      ],
    });
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    const attempts = fixture.primary?.adapter.invocations.map(
      (invocation) => invocation.context.attempt,
    );
    expect(attempts).toEqual([1, 2]);
  });

  it("asks for tool calling only when the call declares tools", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "toolful", capabilities: ["chat", "tool_calling"] }],
    });
    await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id), tools: [toolSpec()] }),
    );
    expect(fixture.primary?.adapter.invocations[0]?.request.tools).toHaveLength(1);
  });
});

describe("a call that cannot be served", () => {
  it("passes over a model whose adapter cannot serve an implied capability", async () => {
    // The adapter declares only `chat`, so a call with tools cannot be served by it.
    const fixture = orchestratorFixture({ models: [{ slug: "plain", capabilities: ["chat"] }] });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id), tools: [toolSpec()] }),
      ),
    );
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.status).toBe("skipped");
    expect(result.attempts[0]?.failure?.message).toContain("tool_calling");
    expect(fixture.primary?.adapter.invocations).toHaveLength(0);
  });

  it("passes over a provider that is disabled", async () => {
    const fixture = orchestratorFixture({ models: [{ slug: "primary", status: "disabled" }] });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.attempts[0]?.status).toBe("skipped");
    expect(result.attempts[0]?.failure?.message).toContain("disabled");
    expect(fixture.primary?.adapter.invocations).toHaveLength(0);
  });

  it("passes over a provider with no credentials rather than surfacing a vendor authentication error", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", credentialsConfigured: false }],
    });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.attempts[0]?.failure?.message).toContain("credentials");
    expect(fixture.primary?.adapter.invocations).toHaveLength(0);
  });

  it("reports no provider available once every candidate has been passed over", async () => {
    const fixture = orchestratorFixture({ models: [{ slug: "primary", status: "unavailable" }] });
    const result = failed(
      await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.failure.code).toBe("not_found");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.details).toMatchObject({
      candidatesTried: 1,
      reason: "every candidate failed",
    });
  });
});

describe("cancellation and deadlines", () => {
  it("refuses a call whose caller has already been cancelled, without touching a provider", async () => {
    const fixture = orchestratorFixture();
    const parent = cancellableContext();
    parent.cancel("the caller walked away");
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        parent.context,
      ),
    );
    expect(result.failure.class).toBe("cancelled");
    expect(result.failure.message).toContain("the caller walked away");
    expect(result.attempts).toHaveLength(0);
    expect(fixture.primary?.adapter.invocations).toHaveLength(0);
  });

  it("stops between retries when the caller cancels mid-call", async () => {
    const clock = testClock();
    const parent = cancellableContext({ clock });
    let calls = 0;
    const fixture = orchestratorFixture({
      clock,
      models: [
        {
          slug: "flaky",
          results: [failedInvocation("rate limited")],
          onInvoke: () => {
            calls += 1;
            if (calls === 1) {
              parent.cancel("stop now");
            }
          },
        },
      ],
    });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          maxAttemptsPerProvider: MAX_PROVIDER_ATTEMPTS,
        }),
        parent.context,
      ),
    );
    expect(result.failure.class).toBe("cancelled");
    expect(result.attempts).toHaveLength(1);
    expect(fixture.primary?.adapter.invocations).toHaveLength(1);
  });

  it("refuses a call whose deadline has already passed", async () => {
    const clock = testClock();
    const parent = cancellableContext({ clock, deadlineMs: 100 });
    clock.advance(150);
    const fixture = orchestratorFixture({ clock });
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        parent.context,
      ),
    );
    expect(result.failure.class).toBe("deadline_exceeded");
    expect(result.failure.code).toBe("timeout");
    expect(result.attempts).toHaveLength(0);
  });

  it("reports a deadline the call itself declares", async () => {
    const clock = testClock();
    const fixture = orchestratorFixture({ clock });
    const parent = ExecutionScope.createRoot({ deadlineMs: 10 }, { clock });
    clock.advance(50);
    const result = failed(
      await fixture.orchestrator.call(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        parent.context,
      ),
    );
    expect(result.failure.class).toBe("deadline_exceeded");
  });
});

describe("validation at the boundary", () => {
  it("refuses a request that is not a ModelCallRequest", async () => {
    const fixture = orchestratorFixture();
    await expect(
      fixture.orchestrator.call({ model: modelById(primaryOf(fixture).model.id), messages: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses sampling parameters outside their bounds", async () => {
    const fixture = orchestratorFixture();
    await expect(
      fixture.orchestrator.call(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          parameters: { temperature: 4 },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.primary?.adapter.invocations).toHaveLength(0);
  });

  it("refuses an unknown field rather than dropping it silently", async () => {
    const fixture = orchestratorFixture();
    const reference = modelById(primaryOf(fixture).model.id);
    const withUnknownField = {
      ...modelCall({ model: reference }),
      providerId: "prv_whatever",
    } as unknown as Parameters<typeof fixture.orchestrator.call>[0];
    await expect(fixture.orchestrator.call(withUnknownField)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses to be built without registries", () => {
    expect(
      () =>
        new InMemoryModelOrchestrator(
          {} as unknown as ConstructorParameters<typeof InMemoryModelOrchestrator>[0],
        ),
    ).toThrow(ValidationError);
  });
});

describe("telemetry", () => {
  it("opens one span per call, names it after the reference kind, and ends it", async () => {
    const fixture = orchestratorFixture();
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    expect(fixture.spans).toHaveLength(1);
    expect(fixture.spans[0]?.recordedName).toBe("model.call id");
    expect(fixture.spans[0]?.ended).toBe(true);
  });

  it("puts identifiers and measurements on the span, and nothing else", async () => {
    const fixture = orchestratorFixture();
    const result = succeeded(
      await fixture.orchestrator.call(modelCall({ model: modelBySlug("primary") })),
    );
    const attributes = fixture.spans[0]?.recordedAttributes ?? {};
    expect(attributes["omnis.ai.execution.id"]).toBe(result.executionId);
    expect(attributes["omnis.ai.model.id"]).toBe(result.modelId);
    expect(attributes["omnis.ai.provider.id"]).toBe(result.providerId);
    expect(attributes["omnis.ai.model.slug"]).toBe("primary");
    expect(attributes["omnis.ai.status"]).toBe("succeeded");
    expect(attributes["omnis.ai.execution.status"]).toBe("succeeded");
    expect(attributes["omnis.ai.usage.input_tokens"]).toBe(12);
    expect(attributes["omnis.ai.usage.output_tokens"]).toBe(34);
    expect(attributes["omnis.ai.usage.cost_micro_usd"]).toBe(4);
    expect(attributes["omnis.ai.streamed"]).toBe(false);
    expect(attributes["omnis.ai.fallback.depth"]).toBe(0);
    expect(fixture.spans[0]?.recordedStatuses).toEqual([{ status: "ok", message: undefined }]);
  });

  it("keeps the conversation off the span, because a span is copied to every backend", async () => {
    const fixture = orchestratorFixture();
    await fixture.orchestrator.call(
      modelCall({
        model: modelById(primaryOf(fixture).model.id),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "a secret prompt about payroll" }],
            name: null,
            metadata: {},
          },
        ],
      }),
    );
    const rendered = JSON.stringify(fixture.spans[0]?.recordedAttributes ?? {});
    expect(rendered).not.toContain("payroll");
  });

  it("marks the span as an error and says why when the call fails", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "down", results: [failedInvocation("the provider is down", { retryable: false })] },
      ],
    });
    await fixture.orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) }));
    const statuses = fixture.spans[0]?.recordedStatuses ?? [];
    expect(statuses[0]?.status).toBe("error");
    expect(statuses[0]?.message).toContain("the provider is down");
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.failure.class"]).toBe("provider_failure");
  });
});

describe("the factory", () => {
  it("builds an orchestrator that answers a call", async () => {
    const fixture = orchestratorFixture();
    const orchestrator = createModelOrchestrator({
      modelRegistry: fixture.modelRegistry,
      providerRegistry: fixture.providerRegistry,
      clock: testClock(),
    });
    const result = succeeded(
      await orchestrator.call(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(result.usage.outputTokens).toBe(34);
  });
});
