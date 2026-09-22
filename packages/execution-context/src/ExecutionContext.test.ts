import { describe, expect, it } from "vitest";
import { createAgentId, createTenantId } from "@omnis/types";
import { manualClock } from "./Clock.js";
import { createDeadline } from "./Deadline.js";
import {
  childDeadline,
  contextRemainingMs,
  contextTelemetryAttributes,
  describeContext,
  isContextExpired,
  isContextUnusable,
} from "./ExecutionContext.js";
import { createExecutionContextFactory } from "./ExecutionContextFactory.js";

const clock = manualClock(1_700_000_000_000);
const factory = createExecutionContextFactory({ clock });

describe("context immutability", () => {
  it("is frozen, including its metadata", () => {
    const context = factory.createContext({ metadata: { channel: "web" } });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.metadata)).toBe(true);
    expect(() => {
      // A frozen context cannot be annotated after the fact, which is what makes a
      // snapshot taken mid-execution trustworthy.
      (context as { agentId?: unknown }).agentId = createAgentId();
    }).toThrow();
  });

  it("records the start instant as both a timestamp and a number", () => {
    const context = factory.createContext();
    expect(context.startedAtMs).toBe(1_700_000_000_000);
    expect(context.startedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("carries every identity field it is given", () => {
    const agentId = createAgentId();
    const tenantId = createTenantId();
    const context = factory.createContext({ agentId, tenantId, requestId: "req_123" });
    expect(context.agentId).toBe(agentId);
    expect(context.tenantId).toBe(tenantId);
    expect(context.requestId).toBe("req_123");
    expect(context.depth).toBe(0);
    expect(context.parentExecutionId).toBeNull();
  });
});

describe("context deadline", () => {
  it("reports remaining time against a supplied instant", () => {
    const context = factory.createContext({ deadline: createDeadline(1_700_000_000_000, 10_000) });
    expect(contextRemainingMs(context, 1_700_000_000_000)).toBe(10_000);
    expect(contextRemainingMs(context, 1_700_000_004_000)).toBe(6_000);
    expect(contextRemainingMs(context, 1_700_000_020_000)).toBe(0);
  });

  it("reports null remaining time when unbounded", () => {
    const context = factory.createContext();
    expect(context.deadline).toBeNull();
    expect(contextRemainingMs(context, 1_800_000_000_000)).toBeNull();
    expect(isContextExpired(context, 1_800_000_000_000)).toBe(false);
  });

  it("expires at the deadline instant", () => {
    const context = factory.createContext({ deadlineMs: 5_000 });
    expect(isContextExpired(context, 1_700_000_004_999)).toBe(false);
    expect(isContextExpired(context, 1_700_000_005_000)).toBe(true);
  });

  it("bounds a child deadline by the parent's", () => {
    const parent = factory.createContext({ deadlineMs: 10_000 });
    const bounded = childDeadline(parent, createDeadline(1_700_000_002_000, 60_000));
    expect(bounded?.atMs).toBe(parent.deadline?.atMs);
    expect(contextRemainingMs({ ...parent, deadline: bounded ?? null }, 1_700_000_002_000)).toBe(
      8_000,
    );
  });
});

describe("context usability", () => {
  it("is unusable once cancelled", () => {
    const scope = factory.createRootScope({ deadlineMs: 60_000 });
    expect(isContextUnusable(scope.context, scope.now())).toBe(false);
    scope.cancel("operator");
    expect(isContextUnusable(scope.context, scope.now())).toBe(true);
  });

  it("is unusable once expired", () => {
    const context = factory.createContext({ deadlineMs: 1_000 });
    expect(isContextUnusable(context, 1_700_000_000_500)).toBe(false);
    expect(isContextUnusable(context, 1_700_000_001_000)).toBe(true);
  });
});

describe("describeContext", () => {
  it("names identifiers and settings but never metadata values", () => {
    const agentId = createAgentId();
    const context = factory.createContext({
      agentId,
      deadlineMs: 30_000,
      metadata: { note: "a private note" },
    });
    const described = describeContext(context);
    expect(described).toContain(`execution=${context.executionId}`);
    expect(described).toContain(`correlation=${context.correlationId}`);
    expect(described).toContain(`agent=${agentId}`);
    expect(described).toContain("deadline=30000ms");
    expect(described).toContain("depth=0");
    // Metadata values are caller-supplied free text and may hold anything.
    expect(described).not.toContain("a private note");
  });

  it("reports cancellation when it has happened", () => {
    const scope = factory.createRootScope();
    expect(describeContext(scope.context)).not.toContain("cancelled=true");
    scope.cancel("stopped");
    expect(describeContext(scope.context)).toContain("cancelled=true");
  });

  it("says when there is no deadline", () => {
    expect(describeContext(factory.createContext())).toContain("deadline=none");
  });
});

describe("contextTelemetryAttributes", () => {
  it("uses the omnis.ai vocabulary and only scalar values", () => {
    const agentId = createAgentId();
    const context = factory.createContext({
      agentId,
      mode: "streaming",
      priority: "high",
      deadlineMs: 1_000,
    });
    const attributes = contextTelemetryAttributes(context);
    expect(attributes["omnis.ai.execution.id"]).toBe(context.executionId);
    expect(attributes["omnis.ai.execution.mode"]).toBe("streaming");
    expect(attributes["omnis.ai.execution.priority"]).toBe("high");
    expect(attributes["omnis.ai.agent.id"]).toBe(agentId);
    expect(attributes["omnis.ai.execution.has_deadline"]).toBe(true);
    expect(attributes["omnis.ai.execution.cancelled"]).toBe(false);
    for (const [key, value] of Object.entries(attributes)) {
      expect(key.startsWith("omnis.ai."), key).toBe(true);
      expect(["string", "number", "boolean"], key).toContain(typeof value);
    }
  });

  it("renders an absent agent or tenant as an empty string rather than dropping the attribute", () => {
    // A span attribute that appears and disappears breaks dashboards; an empty value is
    // explicit about "there was none".
    const attributes = contextTelemetryAttributes(factory.createContext());
    expect(attributes["omnis.ai.agent.id"]).toBe("");
    expect(attributes["omnis.ai.tenant.id"]).toBe("");
    expect(attributes["omnis.ai.execution.has_deadline"]).toBe(false);
  });
});
