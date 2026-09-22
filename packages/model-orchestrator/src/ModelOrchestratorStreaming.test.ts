import { describe, expect, it } from "vitest";
import { createExecutionId } from "@omnis/types";
import { modelByCapability, modelById } from "@omnis/ai-core-types";
import type {
  ModelRequest,
  ModelStreamEvent,
  ProviderAdapter,
  ProviderInvocationContext,
  ProviderInvocationResult,
} from "@omnis/ai-core-types";
import {
  budgetFixture,
  cancellableContext,
  collect,
  completedInvocation,
  denyAllPolicy,
  modelCall,
  orchestratorFixture,
  registerProvider,
  streamScript,
  testClock,
  usageOf,
} from "./testSupport.js";
import type { FixtureModel, OrchestratorFixture } from "./testSupport.js";

function primaryOf(fixture: OrchestratorFixture): FixtureModel {
  const model = fixture.primary;
  expect(model).not.toBeNull();
  return model as FixtureModel;
}

/** The types of a collected stream, which is the shape a caller actually sees. */
function types(events: readonly ModelStreamEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

/** The single `failed` event a stream ends with, or null when it did not fail. */
function failureEvent(
  events: readonly ModelStreamEvent[],
): Extract<ModelStreamEvent, { type: "failed" }> | null {
  const last = events[events.length - 1];
  return last !== undefined && last.type === "failed" ? last : null;
}

describe("a stream from an adapter that can stream", () => {
  it("yields the provider's events in the order the provider produced them", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", streamEvents: streamScript("hello stream") }],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(types(events)).toEqual(["started", "delta", "usage", "completed"]);
    expect(events[1]).toMatchObject({ type: "delta", text: "hello stream" });
  });

  it("always ends with a terminal event, so a caller is never left waiting", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", streamEvents: streamScript() }],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    const last = events[events.length - 1];
    expect(last?.type === "completed" || last?.type === "failed").toBe(true);
  });

  it("carries the stop reason the provider reported", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", streamEvents: streamScript("truncated", usageOf(), "length") }],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", stopReason: "length" });
  });

  it("sends the adapter a streaming request and records the attempt as streamed", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", streamEvents: streamScript() }],
    });
    await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    const adapter = primaryOf(fixture).adapter;
    expect(adapter.streamInvocations).toHaveLength(1);
    expect(adapter.streamInvocations[0]?.request.streaming).toBe(true);
    expect(adapter.invocations).toHaveLength(0);
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.streamed"]).toBe(true);
  });

  it("commits the usage the stream reported, not an estimate", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [{ slug: "primary", streamEvents: streamScript("answer", usageOf(30, 40, 9)) }],
    });
    const executionId = createExecutionId();
    const events = await collect(
      fixture.orchestrator.stream(
        modelCall({
          model: modelById(primaryOf(fixture).model.id),
          budgetId: budget.budgetId,
          executionId,
        }),
      ),
    );
    expect(failureEvent(events)).toBeNull();
    const reservations = budget.engine.reservationsForExecution(executionId);
    expect(reservations[0]?.state).toBe("committed");
    expect(reservations[0]?.committed.find((hold) => hold.dimension === "tokens")?.amount).toBe(70);
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.usage.output_tokens"]).toBe(40);
  });

  it("delivers events as they arrive rather than buffering the whole answer", async () => {
    // An adapter that never finishes: the caller still sees every delta it produced, and can stop.
    const clock = testClock();
    const fixture = orchestratorFixture({ clock });
    const providerId = primaryOf(fixture).provider.id;
    fixture.providerRegistry.remove(providerId);
    const endless: ProviderAdapter = {
      providerId,
      slug: "endless",
      async invoke(): Promise<ProviderInvocationResult> {
        return completedInvocation("not used");
      },
      supports: () => true,
      async *stream(
        _request: ModelRequest,
        _context: ProviderInvocationContext,
      ): AsyncGenerator<ModelStreamEvent> {
        yield { type: "started", modelId: primaryOf(fixture).model.id, providerId };
        for (let index = 0; index < 1_000; index += 1) {
          yield { type: "delta", text: `part ${String(index)} ` };
        }
        yield { type: "completed", stopReason: "stop", latencyMs: 1 };
      },
    };
    registerProvider(fixture.providerRegistry, endless, {
      id: providerId,
      slug: "primary-provider",
      capabilities: { modelCapabilities: ["chat", "streaming"] },
    });

    const seen: ModelStreamEvent[] = [];
    for await (const event of fixture.orchestrator.stream(
      modelCall({ model: modelById(primaryOf(fixture).model.id) }),
    )) {
      seen.push(event);
      if (seen.length === 4) {
        break;
      }
    }
    expect(types(seen)).toEqual(["started", "delta", "delta", "delta"]);
  });

  it("settles the hold and records the abandonment when a caller stops reading", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 100_000 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [{ slug: "primary", streamEvents: streamScript("partial") }],
    });
    const stream = fixture.orchestrator.stream(
      modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
    );
    const first = await stream.next();
    expect(first.value?.type).toBe("started");
    await stream.return(undefined);

    const attributes = fixture.spans[0]?.recordedAttributes ?? {};
    expect(attributes["omnis.ai.status"]).toBe("failed");
    expect(attributes["omnis.ai.failure.class"]).toBe("cancelled");
    expect(fixture.spans[0]?.ended).toBe(true);
    const reservationId = attributes["omnis.ai.reservation.id"] as string;
    expect(budget.engine.getReservation(reservationId as never)?.state).toBe("released");
  });
});

describe("a stream from an adapter that cannot stream", () => {
  it("synthesizes events from one invocation instead of failing the call", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "plain", capabilities: ["chat", "streaming"] }],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(types(events)).toEqual(["started", "delta", "usage", "completed"]);
    expect(events[1]).toMatchObject({ type: "delta", text: "plain answered" });
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
  });

  it("reports the synthesized answer as not streamed, because it was not", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "plain", capabilities: ["chat", "streaming"] }],
    });
    await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.streamed"]).toBe(false);
  });

  it("passes over an adapter that does not declare the streaming capability", async () => {
    const fixture = orchestratorFixture({
      models: [
        { slug: "plain", priority: 5, capabilities: ["chat"] },
        {
          slug: "streaming",
          priority: 10,
          streamEvents: streamScript("from the streaming provider"),
        },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelByCapability("chat") })),
    );
    expect(events[1]).toMatchObject({ type: "delta", text: "from the streaming provider" });
    expect(fixture.models[0]?.adapter.supportsCalls).toBeGreaterThan(0);
    expect(fixture.models[0]?.adapter.streamInvocations).toHaveLength(0);
  });
});

describe("governance applies to a stream before anything is emitted", () => {
  it("yields one failed event when policy denies the call", async () => {
    const denied = denyAllPolicy();
    const fixture = orchestratorFixture({
      policyEngine: denied.engine,
      models: [{ slug: "primary", streamEvents: streamScript() }],
    });
    const events = await collect(
      fixture.orchestrator.stream(
        modelCall({ model: modelById(primaryOf(fixture).model.id), policyIds: [denied.policyId] }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed", retryable: false });
    expect(primaryOf(fixture).adapter.streamInvocations).toHaveLength(0);
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.policy.outcome"]).toBe("deny");
  });

  it("yields one failed event when the budget cannot cover the call", async () => {
    const budget = budgetFixture([{ dimension: "tokens", window: "execution", limit: 10 }]);
    const fixture = orchestratorFixture({
      budgetEngine: budget.engine,
      models: [{ slug: "primary", streamEvents: streamScript() }],
    });
    const events = await collect(
      fixture.orchestrator.stream(
        modelCall({ model: modelById(primaryOf(fixture).model.id), budgetId: budget.budgetId }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(failureEvent(events)).not.toBeNull();
    expect(fixture.spans[0]?.recordedAttributes["omnis.ai.failure.class"]).toBe("budget_blocked");
    expect(primaryOf(fixture).adapter.streamInvocations).toHaveLength(0);
  });

  it("yields one failed event when nothing matches the reference", async () => {
    const fixture = orchestratorFixture();
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelByCapability("reasoning") })),
    );
    expect(events).toHaveLength(1);
    expect(failureEvent(events)?.errorCode).toBe("not_found");
  });

  it("yields one failed event when the caller was already cancelled", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", streamEvents: streamScript() }],
    });
    const parent = cancellableContext();
    parent.cancel("the caller walked away");
    const events = await collect(
      fixture.orchestrator.stream(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        parent.context,
      ),
    );
    expect(events).toHaveLength(1);
    expect(failureEvent(events)?.message).toContain("the caller walked away");
  });
});

describe("a stream that fails part way", () => {
  it("falls back to another provider when nothing has been emitted yet", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          streamEvents: [
            {
              type: "failed",
              errorCode: "provider_failure",
              message: "the first provider gave up",
              retryable: true,
            },
          ],
        },
        { slug: "second", priority: 10, streamEvents: streamScript("from the second provider") },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelByCapability("chat") })),
    );
    // The intermediate failure is not the caller's business: it got an answer from the fallback.
    expect(failureEvent(events)).toBeNull();
    expect(events[1]).toMatchObject({ type: "delta", text: "from the second provider" });
    expect(fixture.models[1]?.adapter.streamInvocations).toHaveLength(1);
  });

  it("ends the stream with a failure once content has reached the caller", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          streamEvents: [
            {
              type: "started",
              modelId: "mdl_00000000000000000000000000" as never,
              providerId: "prv_00000000000000000000000000" as never,
            },
            { type: "delta", text: "half an answer" },
            {
              type: "failed",
              errorCode: "provider_failure",
              message: "the connection dropped",
              retryable: true,
            },
          ],
        },
        { slug: "second", priority: 10, streamEvents: streamScript("a second answer") },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelByCapability("chat") })),
    );
    expect(types(events)).toEqual(["started", "delta", "failed"]);
    expect(failureEvent(events)?.message).toBe("the connection dropped");
    // Restarting would produce a second answer to one question.
    expect(fixture.models[1]?.adapter.streamInvocations).toHaveLength(0);
  });

  it("reports a stream that stops without a terminal event as a failure", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "truncated", streamEvents: [{ type: "delta", text: "half an answer" }] }],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(types(events)).toEqual(["delta", "failed"]);
    expect(failureEvent(events)?.message).toContain("stopped before it completed");
  });

  it("classifies a throw from the adapter and falls back when nothing was emitted", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "first",
          priority: 5,
          streamEvents: [],
          streamThrows: new Error("the socket closed"),
        },
        { slug: "second", priority: 10, streamEvents: streamScript("from the second provider") },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelByCapability("chat") })),
    );
    expect(failureEvent(events)).toBeNull();
    expect(events[1]).toMatchObject({ type: "delta", text: "from the second provider" });
  });

  it("reports a throw after content was emitted as the failure it was", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "primary",
          streamEvents: [{ type: "delta", text: "partial" }],
          streamThrows: new Error("the socket closed"),
        },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(types(events)).toEqual(["delta", "failed"]);
    expect(failureEvent(events)?.message).toBe("the socket closed");
    expect(failureEvent(events)?.retryable).toBe(false);
  });

  it("stops mid-stream when the caller cancels, and says so", async () => {
    const parent = cancellableContext();
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "primary",
          streamEvents: [
            { type: "delta", text: "first part" },
            { type: "delta", text: "second part" },
          ],
          onInvoke: () => parent.cancel("the caller walked away"),
        },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(
        modelCall({ model: modelById(primaryOf(fixture).model.id) }),
        parent.context,
      ),
    );
    const failure = failureEvent(events);
    expect(failure?.message).toContain("the caller walked away");
    expect(failure?.retryable).toBe(false);
  });

  it("records the failed stream as an attempt, so the trail is complete", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "primary",
          streamEvents: [
            { type: "delta", text: "partial" },
            { type: "failed", errorCode: "provider_failure", message: "dropped", retryable: false },
          ],
        },
      ],
    });
    await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    const attributes = fixture.spans[0]?.recordedAttributes ?? {};
    expect(attributes["omnis.ai.status"]).toBe("failed");
    expect(attributes["omnis.ai.failure.class"]).toBe("provider_failure");
    expect(fixture.spans[0]?.recordedStatuses[0]?.status).toBe("error");
  });
});

describe("streaming and non-streaming calls agree", () => {
  it("answers a streaming request through invoke when the caller used call()", async () => {
    const fixture = orchestratorFixture({
      models: [{ slug: "primary", streamEvents: streamScript() }],
    });
    const result = await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id), streaming: true }),
    );
    expect(result.status).toBe("succeeded");
    // `call` reports one response, so the stream adapter is not used and the row says so.
    expect(primaryOf(fixture).adapter.streamInvocations).toHaveLength(0);
    expect(primaryOf(fixture).adapter.invocations).toHaveLength(1);
    expect(primaryOf(fixture).adapter.invocations[0]?.request.streaming).toBe(true);
  });

  it("fails a stream the same way it fails a call when the provider is down", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "down",
          streamEvents: [],
          streamThrows: new Error("the provider is down"),
          throws: new Error("the provider is down"),
        },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(modelCall({ model: modelById(primaryOf(fixture).model.id) })),
    );
    expect(failureEvent(events)?.message).toBe("the provider is down");
    const callResult = await fixture.orchestrator.call(
      modelCall({ model: modelById(primaryOf(fixture).model.id) }),
    );
    expect(callResult.status).toBe("failed");
  });

  it("does not replay a stream against the same provider, because a stream is one shot", async () => {
    const fixture = orchestratorFixture({
      models: [
        {
          slug: "flaky",
          streamEvents: [
            {
              type: "failed",
              errorCode: "provider_failure",
              message: "transient",
              retryable: true,
            },
          ],
        },
      ],
    });
    const events = await collect(
      fixture.orchestrator.stream(
        modelCall({ model: modelById(primaryOf(fixture).model.id), maxAttemptsPerProvider: 2 }),
      ),
    );
    // Retrying an invocation is safe; replaying a stream the caller has already seen half of is not,
    // and with no other candidate there is nothing left to do but report it.
    expect(failureEvent(events)?.message).toBe("transient");
    expect(primaryOf(fixture).adapter.streamInvocations).toHaveLength(1);
  });
});
