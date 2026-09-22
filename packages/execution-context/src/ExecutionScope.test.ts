import { describe, expect, it } from "vitest";
import { classifyError, createExecutionId } from "@omnis/ai-core-types";
import { createAgentId, createTenantId } from "@omnis/types";
import { manualClock } from "./Clock.js";
import { createDeadline } from "./Deadline.js";
import { ExecutionScope } from "./ExecutionScope.js";
import { createExecutionContextFactory } from "./ExecutionContextFactory.js";

function rooted(deadlineMs: number | null = null) {
  const clock = manualClock(1_000_000);
  const factory = createExecutionContextFactory({ clock, defaultDeadlineMs: deadlineMs });
  return { clock, factory, root: factory.createRootScope({ deadlineMs }) };
}

describe("root scopes", () => {
  it("mints an execution and a correlation identifier", () => {
    const { root } = rooted();
    expect(root.context.executionId).toMatch(/^exe_/);
    expect(root.context.correlationId).toMatch(/^cor_/);
    expect(root.context.depth).toBe(0);
    expect(root.context.parentExecutionId).toBeNull();
  });

  it("accepts an execution identifier supplied by the caller", () => {
    const executionId = createExecutionId();
    const clock = manualClock(0);
    const scope = ExecutionScope.createRoot({ executionId }, { clock });
    expect(scope.context.executionId).toBe(executionId);
  });

  it("owns its cancellation and starts uncancelled", () => {
    const { root } = rooted();
    expect(root.cancelled).toBe(false);
    expect(root.cancellationReason).toBeNull();
    root.cancel("operator stopped it");
    expect(root.cancelled).toBe(true);
    expect(root.cancellationReason).toBe("operator stopped it");
    expect(root.context.cancellation.cancelled).toBe(true);
  });
});

describe("child scopes", () => {
  it("inherits identity and records its parent", () => {
    const agentId = createAgentId();
    const tenantId = createTenantId();
    const parent = ExecutionScope.createRoot(
      { agentId, tenantId, requestId: "req_1" },
      { clock: manualClock(0) },
    );
    const child = parent.child();

    expect(child.context.correlationId).toBe(parent.context.correlationId);
    expect(child.context.parentExecutionId).toBe(parent.context.executionId);
    expect(child.context.executionId).not.toBe(parent.context.executionId);
    expect(child.context.depth).toBe(1);
    expect(child.context.agentId).toBe(agentId);
    expect(child.context.tenantId).toBe(tenantId);
    expect(child.context.requestId).toBe("req_1");
    expect(child.context.mode).toBe(parent.context.mode);
    expect(child.context.priority).toBe(parent.context.priority);
    expect(parent.context.depth).toBe(0);
  });

  it("increments depth through a chain", () => {
    const { root } = rooted();
    expect(root.child().child().child().context.depth).toBe(3);
  });

  it("lets a child override the agent it runs for", () => {
    const parent = ExecutionScope.createRoot({}, { clock: manualClock(0) });
    const agentId = createAgentId();
    expect(parent.child({ agentId }).context.agentId).toBe(agentId);
  });

  it("bounds the child deadline by the parent's", () => {
    const clock = manualClock(0);
    const parent = ExecutionScope.createRoot({ deadlineMs: 10_000 }, { clock });
    const child = parent.child({ deadlineMs: 60_000 });
    expect(child.context.deadline?.atMs).toBe(10_000);
    expect(child.remainingMs()).toBe(10_000);
    clock.advance(4_000);
    expect(child.remainingMs()).toBe(6_000);
    expect(parent.remainingMs()).toBe(6_000);
  });

  it("honors a shorter child deadline", () => {
    const clock = manualClock(0);
    const parent = ExecutionScope.createRoot({ deadlineMs: 10_000 }, { clock });
    const child = parent.child({ deadlineMs: 2_000 });
    expect(child.remainingMs()).toBe(2_000);
    clock.advance(3_000);
    expect(child.isExpired()).toBe(true);
    // The parent is unaffected by its child's tighter budget.
    expect(parent.isExpired()).toBe(false);
  });

  it("inherits the parent deadline when it asks for none", () => {
    const clock = manualClock(0);
    const parent = ExecutionScope.createRoot({ deadlineMs: 10_000 }, { clock });
    const child = parent.child();
    expect(child.context.deadline).toBe(parent.context.deadline);
  });

  it("creates a child from a bare context", () => {
    const clock = manualClock(0);
    const factory = createExecutionContextFactory({ clock });
    const context = factory.createContext({ deadlineMs: 5_000 });
    const scope = factory.createChildScopeOfContext(context);
    expect(scope.context.parentExecutionId).toBe(context.executionId);
    expect(scope.context.depth).toBe(1);
    // A scope created from a bare context owns its own cancellation, so it can be
    // cancelled even though the context it came from could not be.
    expect(scope.cancelled).toBe(false);
    scope.cancel("from the scope");
    expect(scope.cancelled).toBe(true);
  });
});

describe("cancellation propagation", () => {
  it("cancels children when the parent is cancelled", () => {
    const { root } = rooted();
    const child = root.child();
    const grandchild = child.child();
    root.cancel("root stopped");
    expect(child.cancelled).toBe(true);
    expect(grandchild.cancelled).toBe(true);
    expect(grandchild.cancellationReason).toContain("root stopped");
  });

  it("does not cancel the parent when a child is cancelled", () => {
    const { root } = rooted();
    const child = root.child();
    child.cancel("only this branch");
    expect(child.cancelled).toBe(true);
    expect(root.cancelled).toBe(false);
  });

  it("starts a child cancelled when the parent already was", () => {
    const { root } = rooted();
    root.cancel("already stopped");
    expect(root.child().cancelled).toBe(true);
  });
});

describe("dispose", () => {
  it("cancels work still running under the scope", () => {
    // Leaving a scope without disposing it means work nobody intends to wait for is
    // still running; the honest reading is "stop it", not "keep spending budget".
    const { root } = rooted();
    const child = root.child();
    expect(child.isDisposed).toBe(false);
    child.dispose();
    expect(child.isDisposed).toBe(true);
    expect(child.cancelled).toBe(true);
    expect(child.cancellationReason).toBe("scope disposed");
  });

  it("is idempotent and keeps the first reason", () => {
    const { root } = rooted();
    root.cancel("operator");
    root.dispose();
    root.dispose();
    expect(root.cancellationReason).toBe("operator");
  });

  it("detaches a disposed child from its parent", () => {
    const { root } = rooted();
    const child = root.child();
    child.dispose();
    // The parent must not accumulate references to finished children.
    expect(root.cancelled).toBe(false);
    root.cancel("later");
    expect(child.cancellationReason).toBe("scope disposed");
  });
});

describe("metadata isolation", () => {
  it("gives a child a copy that the parent cannot see change", () => {
    const clock = manualClock(0);
    const parent = ExecutionScope.createRoot({ metadata: { channel: "web" } }, { clock });
    const child = parent.child({ metadata: { step: "plan" } });

    expect(child.context.metadata).toEqual({ channel: "web", step: "plan" });
    expect(parent.context.metadata).toEqual({ channel: "web" });
    expect(child.context.metadata).not.toBe(parent.context.metadata);
  });

  it("does not let a sibling see another sibling's metadata", () => {
    const clock = manualClock(0);
    const parent = ExecutionScope.createRoot({}, { clock });
    const first = parent.child({ metadata: { branch: "first" } });
    const second = parent.child({ metadata: { branch: "second" } });
    expect(first.context.metadata["branch"]).toBe("first");
    expect(second.context.metadata["branch"]).toBe("second");
    expect(parent.context.metadata).toEqual({});
  });

  it("redacts a secret-shaped metadata value on the way in", () => {
    const credential = `AIza${"A".repeat(35)}`;
    const scope = ExecutionScope.createRoot(
      { metadata: { note: `using ${credential}` } },
      { clock: manualClock(0) },
    );
    expect(String(scope.context.metadata["note"])).not.toContain(credential);
  });
});

describe("usability guards", () => {
  it("throws a typed cancellation error that classifies as cancelled", () => {
    const { root } = rooted();
    expect(() => root.throwIfUnusable()).not.toThrow();
    root.cancel("operator");
    let caught: unknown;
    try {
      root.throwIfUnusable();
    } catch (error) {
      caught = error;
    }
    expect(classifyError(caught)).toBe("cancelled");
    expect(() => root.throwIfCancelled()).toThrow();
  });

  it("throws a typed deadline error that classifies as deadline_exceeded", () => {
    const clock = manualClock(0);
    const scope = ExecutionScope.createRoot({ deadlineMs: 1_000 }, { clock });
    clock.advance(1_500);
    let caught: unknown;
    try {
      scope.throwIfUnusable();
    } catch (error) {
      caught = error;
    }
    expect(classifyError(caught)).toBe("deadline_exceeded");
    expect(scope.isExpired()).toBe(true);
    expect(scope.remainingMs()).toBe(0);
  });

  it("reports no expiry when the scope is unbounded", () => {
    const clock = manualClock(0);
    const scope = ExecutionScope.createRoot({}, { clock });
    clock.advance(10_000_000);
    expect(scope.isExpired()).toBe(false);
    expect(scope.remainingMs()).toBeNull();
    expect(() => scope.throwIfUnusable()).not.toThrow();
  });

  it("reads time through its own clock", () => {
    const clock = manualClock(5_000);
    const scope = ExecutionScope.createRoot({}, { clock });
    expect(scope.now()).toBe(5_000);
    clock.advance(10);
    expect(scope.now()).toBe(5_010);
  });
});

describe("explicit deadlines", () => {
  it("accepts an absolute deadline", () => {
    const clock = manualClock(1_000);
    const scope = ExecutionScope.createRoot({ deadline: createDeadline(1_000, 9_000) }, { clock });
    expect(scope.remainingMs()).toBe(9_000);
  });
});
