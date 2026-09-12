/**
 * In-memory event bus tests.
 *
 * The bus is the reference implementation every durable transport will be judged
 * against, so these tests pin the semantics a consumer is allowed to rely on:
 * validation before dispatch, sequential delivery in subscription order, and failure
 * isolation between handlers. Anything not asserted here is something a production
 * transport is free to change.
 */

import { CONTRACT_VERSION, createEvent } from "@omnis/contracts";
import type { EventEnvelope } from "@omnis/contracts";
import { ExecutionError, NotFoundError, ValidationError } from "@omnis/errors";
import { createAgentId, createCharacterId, createTenantId, parseEventType } from "@omnis/types";
import type { JsonObject } from "@omnis/types";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_EVENT_TYPES,
  CHARACTER_EVENT_TYPES,
  createEventRegistry,
  createInMemoryEventBus,
  EVENT_OWNERS,
  SPRINT0_EVENT_DEFINITIONS,
  SYSTEM_EVENT_TYPES,
} from "./index.js";
import type { InMemoryEventBus } from "./index.js";

async function captureAsync(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return null;
}

/** A registry seeded with the Sprint 0 vocabulary, and a bus bound to it. */
function harness(): { registry: ReturnType<typeof createEventRegistry>; bus: InMemoryEventBus } {
  const registry = createEventRegistry();
  registry.registerAll(SPRINT0_EVENT_DEFINITIONS);
  return { registry, bus: createInMemoryEventBus(registry) };
}

/** A `character.created` event, valid against its registered contract. */
function characterCreated(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return createEvent({
    type: CHARACTER_EVENT_TYPES.created,
    payload: {
      characterId: String(createCharacterId()),
      workspaceId: null,
      displayName: "Ava",
      definitionVersion: "1.0.0",
    },
    source: EVENT_OWNERS.characterOs,
    tenantId: createTenantId(),
    ...overrides,
  });
}

/** An `agent.execution.started` event, valid against its registered contract. */
function agentExecutionStarted(): EventEnvelope {
  return createEvent({
    type: AGENT_EVENT_TYPES.executionStarted,
    payload: { agentId: String(createAgentId()), capability: "script.draft", model: null },
    source: EVENT_OWNERS.aiCore,
    tenantId: createTenantId(),
  });
}

describe("publish", () => {
  it("delivers an event to a handler subscribed to its type", async () => {
    const { bus } = harness();
    const handler = vi.fn();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, handler);

    const event = characterCreated();
    await bus.publish(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(event);
    expect(bus.publishedCount).toBe(1);
  });

  it("delivers only to handlers subscribed to that type", async () => {
    const { bus } = harness();
    const characters = vi.fn();
    const agents = vi.fn();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, characters);
    bus.subscribe(AGENT_EVENT_TYPES.executionStarted, agents);

    await bus.publish(characterCreated());

    expect(characters).toHaveBeenCalledTimes(1);
    expect(agents).not.toHaveBeenCalled();
  });

  it("delivers everything to a subscribeAll handler", async () => {
    const { bus } = harness();
    const all = vi.fn();
    bus.subscribeAll(all);

    await bus.publish(characterCreated());
    await bus.publish(agentExecutionStarted());

    expect(all).toHaveBeenCalledTimes(2);
    expect(all.mock.calls[0]?.[0]?.type).toBe(CHARACTER_EVENT_TYPES.created);
    expect(all.mock.calls[1]?.[0]?.type).toBe(AGENT_EVENT_TYPES.executionStarted);
  });

  it("runs handlers sequentially in subscription order", async () => {
    // Deliberate for the reference implementation: it makes causality observable and
    // reproducible. A durable transport delivers concurrently across processes, so
    // anything needing order must derive it from the event's own identifiers and
    // timestamps rather than from delivery sequence.
    const { bus } = harness();
    const order: string[] = [];
    bus.subscribe(CHARACTER_EVENT_TYPES.created, async () => {
      await Promise.resolve();
      order.push("first");
    });
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {
      order.push("second");
    });
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {
      order.push("third");
    });

    await bus.publish(characterCreated());
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("awaits an asynchronous handler before resolving", async () => {
    const { bus } = harness();
    let finished = false;
    bus.subscribe(CHARACTER_EVENT_TYPES.created, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });
    await bus.publish(characterCreated());
    expect(finished).toBe(true);
  });

  it("succeeds with no subscribers", async () => {
    // An event nobody listens to yet is not an error: producers must not have to know
    // who consumes them.
    const { bus } = harness();
    await expect(bus.publish(characterCreated())).resolves.toBeUndefined();
    expect(bus.publishedCount).toBe(1);
  });

  it("validates before dispatch, so a malformed event reaches nobody", async () => {
    const { bus } = harness();
    const handler = vi.fn();
    bus.subscribe(SYSTEM_EVENT_TYPES.initialized, handler);

    const event = createEvent({
      type: SYSTEM_EVENT_TYPES.initialized,
      payload: { service: "content-factory" },
      source: EVENT_OWNERS.platform,
      tenantId: createTenantId(),
    });
    const thrown = await captureAsync(() => bus.publish(event));

    expect(thrown).toBeInstanceOf(ValidationError);
    expect(handler).not.toHaveBeenCalled();
    expect(bus.publishedCount).toBe(0);
  });

  it("refuses to dispatch an event type nobody has defined", async () => {
    // A consumer receiving an undefined type would either crash or, worse, silently
    // misinterpret it.
    const { bus } = harness();
    const handler = vi.fn();
    bus.subscribeAll(handler);

    const event = createEvent({
      type: SYSTEM_EVENT_TYPES.shutdownRequested,
      payload: {},
      source: EVENT_OWNERS.platform,
      tenantId: createTenantId(),
    });
    const thrown = await captureAsync(() => bus.publish(event));

    expect(thrown).toBeInstanceOf(NotFoundError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an event produced at an unknown type entirely", async () => {
    const { bus } = harness();
    const event = {
      ...characterCreated(),
      type: parseEventType("billing.invoice.paid"),
    };
    expect(await captureAsync(() => bus.publish(event))).toBeInstanceOf(NotFoundError);
  });

  it("counts a dispatched event even when a handler failed", async () => {
    // `publishedCount` records events that were validated and dispatched, which is the
    // number an operator compares against a producer's own count.
    const { bus } = harness();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {
      throw new Error("consumer bug");
    });
    await captureAsync(() => bus.publish(characterCreated()));
    expect(bus.publishedCount).toBe(1);
  });
});

describe("failure isolation", () => {
  it("lets every other handler see the event when one throws", async () => {
    // One broken consumer must not blind every other consumer to the same event; in a
    // durable transport this is what makes per-consumer retry and dead-lettering
    // possible.
    const { bus } = harness();
    const before = vi.fn();
    const after = vi.fn();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, before);
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {
      throw new Error("consumer bug");
    });
    bus.subscribe(CHARACTER_EVENT_TYPES.created, after);

    // publish still reports the failure; what matters here is that the healthy
    // handlers were offered the event regardless.
    const thrown = await captureAsync(() => bus.publish(characterCreated()));
    expect(thrown).toBeInstanceOf(ExecutionError);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("reports the failure once every handler has been offered the event", async () => {
    const { bus } = harness();
    const failing = vi.fn(() => {
      throw new Error("consumer bug");
    });
    bus.subscribe(CHARACTER_EVENT_TYPES.created, failing);
    bus.subscribe(CHARACTER_EVENT_TYPES.created, failing);

    const thrown = await captureAsync(() => bus.publish(characterCreated()));
    expect(thrown).toBeInstanceOf(ExecutionError);
    const failure = thrown as ExecutionError;
    expect(failure.message).toContain("2 of 2 handler(s) failed");
    expect(failure.metadata["handlerCount"]).toBe(2);
    expect(failure.metadata["failureCount"]).toBe(2);
    expect(failure.metadata["eventType"]).toBe(String(CHARACTER_EVENT_TYPES.created));
    // Not retryable: re-dispatching to the same broken consumer would fail identically,
    // and would double-apply every handler that did succeed.
    expect(failure.retryable).toBe(false);
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it("carries the correlation so a failed dispatch can be traced", async () => {
    const { bus } = harness();
    const event = characterCreated();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {
      throw new Error("consumer bug");
    });

    const thrown = (await captureAsync(() => bus.publish(event))) as ExecutionError;
    expect(thrown.metadata["eventId"]).toBe(String(event.id));
    expect(thrown.metadata["correlationId"]).toBe(String(event.correlationId));
  });

  it("isolates a handler that rejects asynchronously", async () => {
    const { bus } = harness();
    const healthy = vi.fn();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, async () => {
      await Promise.resolve();
      throw new Error("async consumer bug");
    });
    bus.subscribe(CHARACTER_EVENT_TYPES.created, healthy);

    const thrown = await captureAsync(() => bus.publish(characterCreated()));
    expect(thrown).toBeInstanceOf(ExecutionError);
    expect((thrown as ExecutionError).metadata["failureCount"]).toBe(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});

describe("subscriptions", () => {
  it("returns the type it was made for", () => {
    const { bus } = harness();
    expect(bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {}).type).toBe(
      CHARACTER_EVENT_TYPES.created,
    );
    expect(bus.subscribeAll(() => {}).type).toBeNull();
  });

  it("stops delivering after unsubscribe", async () => {
    const { bus } = harness();
    const handler = vi.fn();
    const subscription = bus.subscribe(CHARACTER_EVENT_TYPES.created, handler);

    await bus.publish(characterCreated());
    subscription.unsubscribe();
    await bus.publish(characterCreated());

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("makes a repeated unsubscribe harmless", async () => {
    // Double-unsubscribe happens in cleanup paths, and throwing there would mask the
    // original reason the cleanup ran.
    const { bus } = harness();
    const subscription = bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {});
    subscription.unsubscribe();
    expect(() => subscription.unsubscribe()).not.toThrow();
    expect(bus.subscriberCount(CHARACTER_EVENT_TYPES.created)).toBe(0);
    await expect(bus.publish(characterCreated())).resolves.toBeUndefined();
  });

  it("unsubscribes one handler without disturbing its neighbours", async () => {
    const { bus } = harness();
    const first = vi.fn();
    const second = vi.fn();
    const removable = bus.subscribe(CHARACTER_EVENT_TYPES.created, first);
    bus.subscribe(CHARACTER_EVENT_TYPES.created, second);

    removable.unsubscribe();
    await bus.publish(characterCreated());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("counts subscribers for a type and in total", () => {
    const { bus } = harness();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {});
    bus.subscribe(CHARACTER_EVENT_TYPES.created, () => {});
    bus.subscribe(AGENT_EVENT_TYPES.executionStarted, () => {});
    bus.subscribeAll(() => {});

    expect(bus.subscriberCount(CHARACTER_EVENT_TYPES.created)).toBe(2);
    expect(bus.subscriberCount(AGENT_EVENT_TYPES.executionStarted)).toBe(1);
    expect(bus.subscriberCount(SYSTEM_EVENT_TYPES.initialized)).toBe(0);
    // The total includes subscribeAll handlers, which belong to no single type.
    expect(bus.subscriberCount()).toBe(4);
  });
});

describe("clear", () => {
  it("removes every subscription and resets the count", async () => {
    const { bus } = harness();
    const handler = vi.fn();
    bus.subscribe(CHARACTER_EVENT_TYPES.created, handler);
    await bus.publish(characterCreated());

    bus.clear();

    expect(bus.subscriberCount()).toBe(0);
    expect(bus.publishedCount).toBe(0);
    await bus.publish(characterCreated());
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("the bus and the registry agree", () => {
  it("accepts a payload the registered contract defines and rejects one it does not", async () => {
    const { bus } = harness();
    const handler = vi.fn();
    bus.subscribeAll(handler);

    await bus.publish(characterCreated());
    expect(handler).toHaveBeenCalledTimes(1);

    // Envelope payloads are read-only, so a malformed variant is constructed rather
    // than mutated in place — the same way a buggy producer would emit one.
    const good = characterCreated();
    const bad: EventEnvelope = { ...good, payload: { ...good.payload, displayName: "   " } };
    expect(await captureAsync(() => bus.publish(bad))).toBeInstanceOf(ValidationError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("publishes every defined Sprint 0 event type without error", async () => {
    // Smoke coverage across the whole vocabulary: a definition whose payload schema
    // cannot be satisfied by any value would otherwise sit in the registry unnoticed
    // until a producer tried to use it.
    const { registry, bus } = harness();
    const payloads: Readonly<Record<string, JsonObject>> = {
      "system.initialized": { service: "content-factory", version: "0.1.0", environment: "test" },
      "system.configuration.loaded": {
        service: "content-factory",
        environment: "test",
        keys: ["OMNIS_ENV"],
        usedDefaults: true,
      },
      "agent.execution.started": {
        agentId: String(createAgentId()),
        capability: "script.draft",
        model: null,
      },
      "agent.execution.completed": {
        agentId: String(createAgentId()),
        capability: "script.draft",
        durationMs: 12,
        tokensUsed: null,
        costUsd: null,
      },
      "agent.execution.failed": {
        agentId: String(createAgentId()),
        capability: "script.draft",
        durationMs: 12,
        errorCode: "provider_failure",
        errorMessage: "provider unavailable",
        retryable: true,
      },
      "character.created": {
        characterId: String(createCharacterId()),
        workspaceId: null,
        displayName: "Ava",
        definitionVersion: "1.0.0",
      },
    };

    for (const type of registry.types()) {
      const payload = payloads[String(type)];
      if (payload === undefined) {
        // Types without a sample payload here are covered by payloads.test.ts.
        continue;
      }
      const event = createEvent({
        type,
        payload,
        source: registry.require(type).owner,
        tenantId: createTenantId(),
        version: CONTRACT_VERSION,
      });
      await expect(bus.publish(event), String(type)).resolves.toBeUndefined();
    }
  });
});
