import { describe, expect, it } from "vitest";
import { createCancellationSource, NEVER_CANCELLED } from "./Cancellation.js";
import { manualClock } from "./Clock.js";
import {
  createExecutionContext,
  createExecutionContextFactory,
  startedAtIso,
} from "./ExecutionContextFactory.js";
import { ExecutionScope } from "./ExecutionScope.js";

describe("factory defaults", () => {
  it("applies the configured clock, mode, priority and deadline", () => {
    const clock = manualClock(2_000);
    const factory = createExecutionContextFactory({
      clock,
      defaultDeadlineMs: 15_000,
      defaultMode: "batch",
      defaultPriority: "low",
    });

    expect(factory.clock).toBe(clock);
    expect(factory.defaultDeadlineMs).toBe(15_000);
    expect(factory.defaultMode).toBe("batch");
    expect(factory.defaultPriority).toBe("low");

    const context = factory.createContext();
    expect(context.startedAtMs).toBe(2_000);
    expect(context.mode).toBe("batch");
    expect(context.priority).toBe("low");
    expect(context.deadline?.durationMs).toBe(15_000);
  });

  it("defaults to interactive, normal priority and no deadline", () => {
    const factory = createExecutionContextFactory({ clock: manualClock(0) });
    expect(factory.defaultDeadlineMs).toBeNull();
    const context = factory.createContext();
    expect(context.mode).toBe("interactive");
    expect(context.priority).toBe("normal");
    expect(context.deadline).toBeNull();
  });

  it("lets a call override every default", () => {
    const factory = createExecutionContextFactory({
      clock: manualClock(0),
      defaultDeadlineMs: 15_000,
      defaultMode: "batch",
    });
    const context = factory.createContext({
      deadlineMs: 1_000,
      mode: "streaming",
      priority: "critical",
    });
    expect(context.deadline?.durationMs).toBe(1_000);
    expect(context.mode).toBe("streaming");
    expect(context.priority).toBe("critical");
  });

  it("treats an explicit null deadline as unbounded even when a default exists", () => {
    const factory = createExecutionContextFactory({
      clock: manualClock(0),
      defaultDeadlineMs: 15_000,
    });
    expect(factory.createContext({ deadlineMs: null }).deadline).toBeNull();
  });

  it("attaches base metadata to every context it creates", () => {
    const factory = createExecutionContextFactory({
      clock: manualClock(0),
      baseMetadata: { deployment: "eu-west", build: "2026.09" },
    });
    expect(factory.createContext().metadata).toEqual({ deployment: "eu-west", build: "2026.09" });
    expect(factory.createRootScope().context.metadata).toEqual({
      deployment: "eu-west",
      build: "2026.09",
    });
    expect(factory.createContext({ metadata: { channel: "web" } }).metadata).toEqual({
      deployment: "eu-west",
      build: "2026.09",
      channel: "web",
    });
  });

  it("sanitizes base metadata once, at construction", () => {
    const baseMetadata: Record<string, unknown> = { deployment: "eu-west" };
    const factory = createExecutionContextFactory({ clock: manualClock(0), baseMetadata });
    baseMetadata["deployment"] = "changed-later";
    // The factory resolved its defaults at construction, so a later mutation of the
    // caller's object cannot change what executions are labeled with.
    expect(factory.createContext().metadata).toEqual({ deployment: "eu-west" });
  });
});

describe("bare contexts", () => {
  it("is not cancellable unless the caller supplies a token", () => {
    const factory = createExecutionContextFactory({ clock: manualClock(0) });
    const context = factory.createContext();
    expect(context.cancellation).toBe(NEVER_CANCELLED);
    expect(context.cancellation.cancelled).toBe(false);
  });

  it("attaches an externally-owned token when given one", () => {
    const factory = createExecutionContextFactory({ clock: manualClock(0) });
    const source = createCancellationSource();
    const context = factory.createContext({ cancellation: source.token });
    expect(context.cancellation.cancelled).toBe(false);
    source.cancel("external owner");
    expect(context.cancellation.cancelled).toBe(true);
    expect(context.cancellation.reason).toBe("external owner");
  });
});

describe("scopes created by a factory", () => {
  it("creates roots and children that share the factory clock", () => {
    const clock = manualClock(1_000);
    const factory = createExecutionContextFactory({ clock, defaultDeadlineMs: 10_000 });
    const root = factory.createRootScope();
    expect(root).toBeInstanceOf(ExecutionScope);
    expect(root.now()).toBe(1_000);

    clock.advance(2_000);
    const child = factory.createChildScope(root);
    expect(child.now()).toBe(3_000);
    expect(child.remainingMs()).toBe(8_000);
    expect(child.context.depth).toBe(1);
  });

  it("exposes its dependencies so a scope can be created elsewhere with the same defaults", () => {
    const clock = manualClock(0);
    const factory = createExecutionContextFactory({
      clock,
      defaultDeadlineMs: 5_000,
      defaultPriority: "high",
    });
    const scope = ExecutionScope.createRoot({}, factory.scopeDependencies());
    expect(scope.context.deadline?.durationMs).toBe(5_000);
    expect(scope.context.priority).toBe("high");
  });

  it("freezes the factory", () => {
    expect(Object.isFrozen(createExecutionContextFactory())).toBe(true);
  });
});

describe("standalone helpers", () => {
  it("creates a single context without a factory", () => {
    const context = createExecutionContext({ mode: "background" }, { clock: manualClock(7_000) });
    expect(context.mode).toBe("background");
    expect(context.startedAtMs).toBe(7_000);
  });

  it("formats a start instant", () => {
    expect(startedAtIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
