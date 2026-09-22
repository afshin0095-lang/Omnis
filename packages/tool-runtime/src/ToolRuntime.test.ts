import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionId, createSpanId, createToolId, createTraceId } from "@omnis/types";
import { createCancellationSource, createExecutionContext } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import { NotFoundError, ValidationError } from "@omnis/errors";
import { InMemoryPolicyEngine } from "@omnis/policy-engine";
import type { PolicyEngine } from "@omnis/policy-engine";
import type { ToolDescriptor, ToolHandler, ToolInvocation } from "@omnis/ai-core-types";
import { InMemoryToolRegistry } from "./InMemoryToolRegistry.js";
import { InMemoryToolRuntime, TOOL_ERROR_CODES } from "./ToolRuntime.js";
import type { ToolInvocationRequest } from "./ToolRuntime.js";
import { createCollectingAuditSink } from "./ToolAudit.js";
import {
  AT,
  AT_MS,
  cancellableHandler,
  context,
  errorResultHandler,
  recordingHandler,
  recordingTracer,
  slowHandler,
  throwingHandler,
  toolDescriptorInput,
  valueHandler,
} from "./testSupport.js";

interface Harness {
  readonly runtime: InMemoryToolRuntime;
  readonly registry: InMemoryToolRegistry;
  readonly audit: ReturnType<typeof createCollectingAuditSink>;
  readonly spans: ReturnType<typeof recordingTracer>["spans"];
}

/** A runtime wired to a recording tracer, a collecting audit sink and a fixed clock. */
/** Resolves the permissions a context grants, as the runtime option does. */
type GrantResolver = (context: ExecutionContext, descriptor: ToolDescriptor) => readonly string[];

function harness(
  options: { policyEngine?: PolicyEngine | null; resolveGrants?: GrantResolver } = {},
): Harness {
  const registry = new InMemoryToolRegistry({ clock: () => AT });
  const audit = createCollectingAuditSink();
  const { tracer, spans } = recordingTracer();
  const runtime = createRuntime(
    registry,
    audit,
    tracer,
    options.policyEngine ?? null,
    options.resolveGrants,
  );
  return { runtime, registry, audit, spans };
}

function createRuntime(
  registry: InMemoryToolRegistry,
  audit: ReturnType<typeof createCollectingAuditSink>,
  tracer: ReturnType<typeof recordingTracer>["tracer"],
  policyEngine: PolicyEngine | null,
  resolveGrants?: GrantResolver,
): InMemoryToolRuntime {
  return new InMemoryToolRuntime({
    registry,
    policyEngine,
    tracer,
    clock: () => AT_MS,
    audit,
    ...(resolveGrants === undefined ? {} : { resolveGrants }),
  });
}

/** Registers a tool and returns its descriptor. */
function register(
  h: Harness,
  overrides: Partial<Parameters<typeof toolDescriptorInput>[0]> = {},
  handler: ToolHandler = valueHandler("ok"),
): ToolDescriptor {
  return h.registry.register(toolDescriptorInput({ registeredAt: AT, ...overrides }), handler);
}

/** A request for a registered tool. */
function request(
  descriptor: ToolDescriptor,
  overrides: Partial<ToolInvocationRequest> = {},
): ToolInvocationRequest {
  return {
    tool: { kind: "id", toolId: descriptor.id },
    arguments: { query: "quarterly report" },
    context: context(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the happy path", () => {
  it("runs the handler and normalizes its value", async () => {
    const h = harness();
    const descriptor = register(h, {}, valueHandler({ rows: [1, 2] }));
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      return;
    }
    expect(result.value).toEqual({ rows: [1, 2] });
    expect(result.toolId).toBe(descriptor.id);
    expect(result.durationMs).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("gives the handler the invocation, and only the invocation", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(h, { metadata: { owner: "search" } }, recorded.handler);
    const invocationContext = context({ metadata: { environment: "test" } });
    await h.runtime.invoke(
      request(descriptor, {
        context: invocationContext,
        attempt: 3,
        metadata: { stepId: "step-1", secret: "AIza" + "A".repeat(35) },
      }),
    );

    const invocation = recorded.invocations[0];
    expect(invocation).toBeDefined();
    if (invocation === undefined) {
      return;
    }
    expect(invocation.toolId).toBe(descriptor.id);
    expect(invocation.name).toBe("search_documents");
    expect(invocation.arguments).toEqual({ query: "quarterly report" });
    expect(Object.isFrozen(invocation.arguments)).toBe(true);
    expect(invocation.environment.executionId).toBe(invocationContext.executionId);
    expect(invocation.environment.correlationId).toBe(invocationContext.correlationId);
    expect(invocation.environment.attempt).toBe(3);
    expect(invocation.environment.isCancelled()).toBe(false);
    expect(invocation.environment.remainingMs()).toBe(1_000);
    // Metadata is sanitized before it reaches a handler: a secret in a step's metadata must not
    // be handed to code that may log it.
    expect(String((invocation.metadata as Record<string, unknown>)["secret"])).not.toContain(
      "AIza",
    );
    expect((invocation.metadata as Record<string, unknown>)["stepId"]).toBe("step-1");
  });

  it("defaults the attempt to one and the arguments to empty", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(
      h,
      { parameters: { kind: "object", properties: {}, required: [] } },
      recorded.handler,
    );
    const result = await h.runtime.invoke({
      tool: { kind: "id", toolId: descriptor.id },
      context: context(),
    });
    expect(result.status).toBe("succeeded");
    expect(recorded.invocations[0]?.environment.attempt).toBe(1);
    expect(recorded.invocations[0]?.arguments).toEqual({});
  });

  it("resolves a tool by the name a model called", async () => {
    const h = harness();
    register(h);
    const result = await h.runtime.invoke({
      tool: { kind: "name", name: "search_documents" },
      arguments: { query: "x" },
      context: context(),
    });
    expect(result.status).toBe("succeeded");
  });

  it("throws when the tool is not registered, because there is nothing to audit against", async () => {
    const h = harness();
    await expect(
      h.runtime.invoke({ tool: { kind: "id", toolId: createToolId() }, context: context() }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      h.runtime.invoke({ tool: { kind: "name", name: "nope" }, context: context() }),
    ).rejects.toThrow(NotFoundError);
    expect(h.audit.records).toEqual([]);
  });
});

describe("gates before execution", () => {
  it("refuses a disabled tool without calling the handler", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(h, { status: "disabled" }, recorded.handler);
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("disabled");
      expect(result.message).toContain("disabled");
    }
    expect(recorded.invocations).toEqual([]);
  });

  it("runs a deprecated tool, because deprecation warns authors rather than stopping work", async () => {
    const h = harness();
    const descriptor = register(h, { status: "deprecated" });
    expect((await h.runtime.invoke(request(descriptor))).status).toBe("succeeded");
  });

  it("refuses invalid arguments before anything else reads them", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(h, {}, recorded.handler);
    const result = await h.runtime.invoke(request(descriptor, { arguments: { limit: "ten" } }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe(TOOL_ERROR_CODES.argumentsInvalid);
      expect(result.message).toContain("query is required");
      expect(result.retryable).toBe(false);
    }
    expect(recorded.invocations).toEqual([]);
  });

  it("refuses a tool whose permissions were not granted", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(
      h,
      {
        permissions: [
          { resource: "documents", action: "read" },
          { resource: "documents", action: "write" },
        ],
      },
      recorded.handler,
    );
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("permission");
      expect(result.message).toContain("documents:read");
      expect(result.message).toContain("documents:write");
    }
    expect(recorded.invocations).toEqual([]);
  });

  it("runs once every required permission is granted", async () => {
    const h = harness();
    const descriptor = register(h, { permissions: [{ resource: "documents", action: "read" }] });
    const result = await h.runtime.invoke(
      request(descriptor, { grantedPermissions: ["documents:read", "other:admin"] }),
    );
    expect(result.status).toBe("succeeded");
  });

  it("takes grants from the configured resolver when the request carries none", async () => {
    const resolveGrants = vi.fn(() => ["documents:read"]);
    const h = harness({ resolveGrants });
    const descriptor = register(h, { permissions: [{ resource: "documents", action: "read" }] });
    expect((await h.runtime.invoke(request(descriptor))).status).toBe("succeeded");
    expect(resolveGrants).toHaveBeenCalledTimes(1);
  });

  it("fails closed when no grant source is configured", async () => {
    const h = harness();
    const descriptor = register(h, { permissions: [{ resource: "documents", action: "read" }] });
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("permission");
    }
  });

  it("refuses a tool that requires approval and has none", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(h, { requiresApproval: true }, recorded.handler);
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("approval_required");
    }
    expect(recorded.invocations).toEqual([]);

    const approved = await h.runtime.invoke(
      request(descriptor, { approval: { approved: true, approver: "operator", approvedAt: AT } }),
    );
    expect(approved.status).toBe("succeeded");
    expect(recorded.invocations).toHaveLength(1);
  });

  it("treats an approval that was refused as no approval", async () => {
    const h = harness();
    const descriptor = register(h, { requiresApproval: true });
    const result = await h.runtime.invoke(
      request(descriptor, { approval: { approved: false, approver: "operator", approvedAt: AT } }),
    );
    expect(result.status).toBe("denied");
  });
});

describe("policy gate", () => {
  /** A policy engine with a deny rule for one tool and an approval rule for risky ones. */
  function policyHarness(): {
    harness: Harness;
    policyEngine: PolicyEngine;
    denySearch: ToolDescriptor;
    risky: ToolDescriptor;
  } {
    const policyEngine = new InMemoryPolicyEngine({ clock: () => AT });
    const denySet = policyEngine.registerPolicySet({
      name: "tools",
      defaultOutcome: "allow",
      createdAt: AT,
      rules: [
        {
          id: "deny-search",
          name: "Deny search",
          description: "search is off limits",
          outcome: "deny",
          target: { action: "tool.invoke", resource: "search_documents" },
        },
        {
          id: "approve-risky",
          name: "Approve risky",
          description: "risky tools need a human",
          outcome: "require_approval",
          priority: 20,
          target: { action: "tool.invoke", minimumRiskLevel: "high" },
          conditions: [{ field: "attributes.approvalGranted", operator: "eq", value: false }],
        },
      ],
    });
    const h = harness({ policyEngine });
    const denySearch = register(h, { policyId: denySet.id });
    const risky = register(h, {
      name: "publish_content",
      policyId: denySet.id,
      riskLevel: "high",
      kind: "write",
      sideEffect: "external_side_effect",
    });
    return { harness: h, policyEngine, denySearch, risky };
  }

  it("denies a named tool while leaving its siblings alone", async () => {
    const { harness: h, denySearch, risky } = policyHarness();
    const denied = await h.runtime.invoke(request(denySearch));
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") {
      expect(denied.reason).toBe("policy");
      expect(denied.message).toContain("search is off limits");
    }
    expect(h.audit.results[0]?.status).toBe("denied");
    // The same set does not deny a different tool: a resource-scoped rule is what keeps a policy
    // set from becoming a global kill switch nobody dares attach.
    const sibling = register(h, { name: "list_documents", kind: "read", riskLevel: "low" });
    expect((await h.runtime.invoke(request(sibling))).status).toBe("succeeded");
    expect(risky.name).toBe("publish_content");
  });

  it("denies through the descriptor's policy set", async () => {
    const policyEngine = new InMemoryPolicyEngine({ clock: () => AT });
    const denySet = policyEngine.registerPolicySet({
      name: "deny-all-tools",
      defaultOutcome: "deny",
      createdAt: AT,
      rules: [],
    });
    const h = harness({ policyEngine });
    const recorded = recordingHandler();
    const descriptor = register(h, { policyId: denySet.id }, recorded.handler);
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("policy");
      expect(result.message).toContain("no rule matched");
    }
    expect(recorded.invocations).toEqual([]);
    expect(h.audit.records[0]?.policyDecisionOutcome).toBe("deny");
  });

  it("requires approval when the policy does, and accepts a recorded approval", async () => {
    const { harness: h, risky } = policyHarness();
    const denied = await h.runtime.invoke(request(risky));
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") {
      expect(denied.reason).toBe("approval_required");
      expect(denied.message).toContain("risky tools need a human");
    }

    const approved = await h.runtime.invoke(
      request(risky, { approval: { approved: true, approver: "operator", approvedAt: AT } }),
    );
    expect(approved.status).toBe("succeeded");
  });

  it("evaluates the runtime defaults and the request's extra policy sets too", async () => {
    const policyEngine = new InMemoryPolicyEngine({ clock: () => AT });
    const defaultDeny = policyEngine.registerPolicySet({
      name: "default-deny",
      defaultOutcome: "deny",
      createdAt: AT,
      rules: [],
    });
    const registry = new InMemoryToolRegistry({ clock: () => AT });
    const audit = createCollectingAuditSink();
    const { tracer } = recordingTracer();
    const runtime = new InMemoryToolRuntime({
      registry,
      policyEngine,
      tracer,
      clock: () => AT_MS,
      audit,
      defaultPolicyIds: [defaultDeny.id],
    });
    const descriptor = registry.register(
      toolDescriptorInput({ registeredAt: AT }),
      valueHandler("ok"),
    );
    expect((await runtime.invoke(request(descriptor))).status).toBe("denied");

    // A per-request set can tighten further, and the most restrictive outcome wins.
    const permissive = policyEngine.registerPolicySet({
      name: "permissive",
      defaultOutcome: "allow",
      createdAt: AT,
      rules: [],
    });
    const openRuntime = new InMemoryToolRuntime({
      registry,
      policyEngine,
      tracer,
      clock: () => AT_MS,
      audit,
    });
    expect(
      (await openRuntime.invoke(request(descriptor, { policyIds: [permissive.id] }))).status,
    ).toBe("succeeded");
    expect(
      (
        await openRuntime.invoke(
          request(descriptor, { policyIds: [permissive.id, defaultDeny.id] }),
        )
      ).status,
    ).toBe("denied");
  });

  it("tightens the timeout with a policy duration constraint", async () => {
    const policyEngine = new InMemoryPolicyEngine({ clock: () => AT });
    const set = policyEngine.registerPolicySet({
      name: "short",
      defaultOutcome: "constrain",
      createdAt: AT,
      rules: [
        {
          id: "cap-duration",
          name: "Cap duration",
          description: "twenty milliseconds",
          outcome: "constrain",
          constraints: [{ kind: "max_duration_ms", value: 20, source: "cap-duration" }],
        },
      ],
    });
    const h = harness({ policyEngine });
    const descriptor = register(h, { policyId: set.id, timeoutMs: 5_000 }, slowHandler(500));
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.timedOut).toBe(true);
      expect(result.message).toContain("20ms");
    }
  });

  it("reports a misconfigured policy as a failure rather than crashing the execution", async () => {
    const policyEngine = new InMemoryPolicyEngine({ clock: () => AT });
    const h = harness({ policyEngine });
    const descriptor = register(h, {
      name: "orphan",
      policyId: "pol_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
    });
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("not_found");
      expect(result.message).toContain("tool runtime could not complete the invocation");
      expect(result.retryable).toBe(false);
    }
    expect(h.audit.records).toHaveLength(1);
  });

  it("skips the gate entirely when no policy applies", async () => {
    const h = harness();
    const descriptor = register(h);
    await h.runtime.invoke(request(descriptor));
    expect(h.audit.records[0]?.policyDecisionOutcome).toBe("not_evaluated");
  });
});

describe("timeouts", () => {
  it("stops waiting at the descriptor timeout", async () => {
    const h = harness();
    const descriptor = register(h, { timeoutMs: 20 }, slowHandler(500));
    const started = Date.now();
    const result = await h.runtime.invoke(request(descriptor));
    expect(Date.now() - started).toBeLessThan(400);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.timedOut).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.errorCode).toBe(TOOL_ERROR_CODES.timedOut);
      expect(result.message).toContain("20ms");
      // A timeout leaves the work in an unknown state, so retrying is only safe when repeating
      // the call cannot duplicate a side effect.
      expect(result.retryable).toBe(true);
    }
    expect(h.audit.records[0]?.timedOut).toBe(true);
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
  });

  it("refuses to retry a timed-out tool with a non-idempotent side effect", async () => {
    const h = harness();
    const descriptor = register(
      h,
      { name: "send_email", timeoutMs: 20, sideEffect: "non_idempotent_write", kind: "external" },
      slowHandler(500),
    );
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.timedOut).toBe(true);
      expect(result.retryable).toBe(false);
    }
  });

  it("honors a per-invocation timeout override", async () => {
    const h = harness();
    const descriptor = register(h, { timeoutMs: 5_000 }, slowHandler(500));
    const result = await h.runtime.invoke(request(descriptor, { timeoutMs: 20 }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.timedOut).toBe(true);
      expect(result.message).toContain("20ms");
    }
  });

  it("takes the tighter of the override and the descriptor, never the wider", async () => {
    const h = harness();
    const descriptor = register(h, { timeoutMs: 30 }, slowHandler(500));
    const result = await h.runtime.invoke(request(descriptor, { timeoutMs: 5_000 }));
    if (result.status === "failed") {
      expect(result.message).toContain("30ms");
    } else {
      expect.unreachable("the descriptor timeout should have stopped the call");
    }
  });

  it("is bounded by the execution deadline", async () => {
    const h = harness();
    const descriptor = register(h, { timeoutMs: 5_000 }, slowHandler(500));
    const bounded = createExecutionContext({ deadlineMs: 30 }, { clock: () => AT_MS });
    const result = await h.runtime.invoke(request(descriptor, { context: bounded }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.timedOut).toBe(true);
      expect(result.message).toContain("30ms");
    }
  });

  it("refuses to start when the deadline has already passed", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(h, {}, recorded.handler);
    // A context whose deadline passed before the runtime looked at it: the work is already late.
    const expired = createExecutionContext({ deadlineMs: 10 }, { clock: () => AT_MS - 50 });
    const result = await h.runtime.invoke(request(descriptor, { context: expired }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe(TOOL_ERROR_CODES.deadlineExceeded);
      expect(result.retryable).toBe(false);
    }
    expect(recorded.invocations).toEqual([]);
  });

  it("clears its timer, so a finished invocation leaves nothing pending", async () => {
    vi.useFakeTimers();
    const h = harness();
    const descriptor = register(h, { timeoutMs: 60_000 }, valueHandler("fast"));
    expect(vi.getTimerCount()).toBe(0);
    await h.runtime.invoke(request(descriptor));
    // The timeout timer is the only one the runtime creates, and it must be cleared in a
    // finally block: a pending timer per invocation keeps a process alive after its work is done.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the handler a remaining time that respects both bounds", async () => {
    const h = harness();
    let observed: number | null = null;
    const descriptor = register(h, { timeoutMs: 250 }, (invocation: ToolInvocation) => {
      observed = invocation.environment.remainingMs();
      return { ok: true, value: observed };
    });
    const bounded = createExecutionContext({ deadlineMs: 100 }, { clock: () => AT_MS });
    await h.runtime.invoke(request(descriptor, { context: bounded }));
    expect(observed).toBe(100);
  });
});

describe("cancellation", () => {
  it("refuses to start a cancelled execution", async () => {
    const h = harness();
    const recorded = recordingHandler();
    const descriptor = register(h, {}, recorded.handler);
    const source = createCancellationSource();
    source.cancel("operator stopped the run");
    const cancelled = createExecutionContext(
      { cancellation: source.token },
      { clock: () => AT_MS },
    );
    const result = await h.runtime.invoke(request(descriptor, { context: cancelled }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.cancelled).toBe(true);
      expect(result.errorCode).toBe(TOOL_ERROR_CODES.cancelled);
      expect(result.message).toBe("operator stopped the run");
      expect(result.retryable).toBe(false);
    }
    expect(recorded.invocations).toEqual([]);
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
  });

  it("stops waiting when cancellation arrives mid-invocation", async () => {
    const h = harness();
    const descriptor = register(h, { timeoutMs: 5_000 }, slowHandler(500));
    const source = createCancellationSource();
    const cancellable = createExecutionContext(
      { cancellation: source.token },
      { clock: () => AT_MS },
    );
    const pending = h.runtime.invoke(request(descriptor, { context: cancellable }));
    setTimeout(() => source.cancel("deadline approaching"), 20);
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.cancelled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.message).toBe("deadline approaching");
    }
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
  });

  it("lets a cooperative handler observe cancellation", async () => {
    const h = harness();
    const cooperative = cancellableHandler(5);
    const descriptor = register(h, { timeoutMs: 5_000 }, cooperative.handler);
    const source = createCancellationSource();
    const cancellable = createExecutionContext(
      { cancellation: source.token },
      { clock: () => AT_MS },
    );
    const pending = h.runtime.invoke(request(descriptor, { context: cancellable }));
    setTimeout(() => source.cancel("stop"), 15);
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.cancelled).toBe(true);
    }
    expect(cooperative.polls()).toBeGreaterThan(1);
  });

  it("unsubscribes from the token when the invocation finishes", async () => {
    const h = harness();
    const descriptor = register(h, { timeoutMs: 5_000 }, valueHandler("ok"));
    const source = createCancellationSource();
    const cancellable = createExecutionContext(
      { cancellation: source.token },
      { clock: () => AT_MS },
    );
    const result = await h.runtime.invoke(request(descriptor, { context: cancellable }));
    expect(result.status).toBe("succeeded");
    // Cancelling after the fact must not resolve a race nobody is waiting on.
    source.cancel("too late");
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
  });
});

describe("concurrency", () => {
  it("refuses an invocation that would exceed the tool's limit", async () => {
    const h = harness();
    const descriptor = register(h, { maxConcurrency: 1 }, slowHandler(120));
    const first = h.runtime.invoke(request(descriptor, { arguments: { query: "one" } }));
    // Let the first invocation take the slot.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.runtime.inFlight(descriptor.id)).toBe(1);
    const second = await h.runtime.invoke(request(descriptor, { arguments: { query: "two" } }));
    expect(second.status).toBe("denied");
    if (second.status === "denied") {
      expect(second.reason).toBe("concurrency");
      expect(second.message).toContain("1 of 1");
    }
    const firstResult = await first;
    expect(firstResult.status).toBe("succeeded");
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
  });

  it("allows concurrent invocations up to the limit", async () => {
    const h = harness();
    const descriptor = register(h, { maxConcurrency: 3 }, slowHandler(30));
    const results = await Promise.all([
      h.runtime.invoke(request(descriptor)),
      h.runtime.invoke(request(descriptor)),
      h.runtime.invoke(request(descriptor)),
    ]);
    expect(results.map((result) => result.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
  });

  it("releases the slot when the handler throws", async () => {
    const h = harness();
    const descriptor = register(h, { maxConcurrency: 1 }, throwingHandler(new Error("boom")));
    await h.runtime.invoke(request(descriptor));
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
    expect((await h.runtime.invoke(request(descriptor))).status).toBe("failed");
  });

  it("releases every slot on dispose", async () => {
    const h = harness();
    const descriptor = register(h, { maxConcurrency: 1 }, slowHandler(200));
    const pending = h.runtime.invoke(request(descriptor));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.runtime.inFlight(descriptor.id)).toBe(1);
    h.runtime.dispose();
    expect(h.runtime.inFlight(descriptor.id)).toBe(0);
    await pending;
  });
});

describe("failure normalization", () => {
  it("keeps a handler's own error code and message", async () => {
    const h = harness();
    const descriptor = register(
      h,
      {},
      errorResultHandler("no_index", "the index is unavailable", true),
    );
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("no_index");
      expect(result.message).toBe("the index is unavailable");
      expect(result.retryable).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.cancelled).toBe(false);
    }
  });

  it("refuses to mark a non-idempotent tool retryable", async () => {
    const h = harness();
    const descriptor = register(
      h,
      { name: "charge_card", kind: "external", sideEffect: "non_idempotent_write" },
      errorResultHandler("gateway_down", "gateway", true),
    );
    const result = await h.runtime.invoke(request(descriptor));
    if (result.status === "failed") {
      expect(result.retryable).toBe(false);
    } else {
      expect.unreachable("the handler reported a failure");
    }
  });

  it("allows a retry for an idempotent write", async () => {
    const h = harness();
    const descriptor = register(
      h,
      { name: "upsert_document", kind: "write", sideEffect: "idempotent_write" },
      errorResultHandler("conflict", "conflict", true),
    );
    const result = await h.runtime.invoke(request(descriptor));
    if (result.status === "failed") {
      expect(result.retryable).toBe(true);
    } else {
      expect.unreachable("the handler reported a failure");
    }
  });

  it("defaults a handler failure to non-retryable", async () => {
    const h = harness();
    const descriptor = register(h, {}, errorResultHandler("bad_input", "no retryable flag"));
    const result = await h.runtime.invoke(request(descriptor));
    if (result.status === "failed") {
      expect(result.retryable).toBe(false);
    } else {
      expect.unreachable("the handler reported a failure");
    }
  });

  it("classifies a thrown platform error by its code", async () => {
    const h = harness();
    const descriptor = register(
      h,
      {},
      throwingHandler(new ValidationError("arguments were rejected upstream")),
    );
    const result = await h.runtime.invoke(request(descriptor));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("validation_failed");
      expect(result.message).toContain("arguments were rejected upstream");
      expect(result.retryable).toBe(false);
    }
  });

  it("classifies a thrown unknown error as a handler error", async () => {
    const h = harness();
    const descriptor = register(h, {}, throwingHandler("a string, not an error"));
    const result = await h.runtime.invoke(request(descriptor));
    if (result.status === "failed") {
      expect(result.errorCode).toBe(TOOL_ERROR_CODES.handlerFailed);
      expect(result.message).toBe("a string, not an error");
      expect(result.retryable).toBe(false);
    } else {
      expect.unreachable("a thrown value becomes a failure");
    }
  });

  it("treats a rejected promise like a throw", async () => {
    const h = harness();
    const descriptor = register(h, {}, () => Promise.reject(new Error("async boom")));
    const result = await h.runtime.invoke(request(descriptor));
    if (result.status === "failed") {
      expect(result.errorCode).toBe(TOOL_ERROR_CODES.handlerFailed);
      expect(result.message).toBe("async boom");
    } else {
      expect.unreachable("a rejection becomes a failure");
    }
  });

  it("never lets a handler failure escape as a rejection", async () => {
    const h = harness();
    const descriptor = register(h, {}, throwingHandler(new Error("boom")));
    await expect(h.runtime.invoke(request(descriptor))).resolves.toBeDefined();
  });
});

describe("audit", () => {
  it("records every outcome, including refusals", async () => {
    const h = harness();
    const disabled = register(h, { name: "disabled_tool", status: "disabled" });
    const unpermitted = register(h, {
      name: "guarded_tool",
      permissions: [{ resource: "documents", action: "admin" }],
    });
    const broken = register(h, { name: "broken_tool" }, throwingHandler(new Error("boom")));
    const good = register(h, { name: "good_tool" });

    await h.runtime.invoke(request(disabled));
    await h.runtime.invoke(request(unpermitted));
    await h.runtime.invoke(request(broken));
    await h.runtime.invoke(request(good));

    expect(h.audit.records).toHaveLength(4);
    expect(h.audit.results.map((result) => result.status)).toEqual([
      "denied",
      "denied",
      "failed",
      "succeeded",
    ]);
    expect(h.audit.records.map((record) => record.toolName)).toEqual([
      "disabled_tool",
      "guarded_tool",
      "broken_tool",
      "good_tool",
    ]);
    expect(
      h.audit.records.every((record) => record.finishedAt !== null && record.durationMs !== null),
    ).toBe(true);
  });

  it("records argument keys and permission names, never argument values", async () => {
    const h = harness();
    const descriptor = register(h, { permissions: [{ resource: "documents", action: "read" }] });
    await h.runtime.invoke(
      request(descriptor, {
        arguments: { query: "the secret query text" },
        grantedPermissions: ["documents:read"],
      }),
    );
    const record = h.audit.records[0];
    expect(record?.argumentKeys).toEqual(["query"]);
    expect(record?.permissionsRequired).toEqual(["documents:read"]);
    expect(JSON.stringify(record)).not.toContain("the secret query text");
    expect(record?.executionId).toBeDefined();
    expect(record?.startedAt).toBe(AT);
    expect(record?.toolVersion).toBe("1.0.0");
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("records the attempt number and the policy outcome", async () => {
    const policyEngine = new InMemoryPolicyEngine({ clock: () => AT });
    const allowSet = policyEngine.registerPolicySet({
      name: "allow-all",
      defaultOutcome: "allow",
      createdAt: AT,
      rules: [],
    });
    const h = harness({ policyEngine });
    const descriptor = register(h, { policyId: allowSet.id });
    await h.runtime.invoke(request(descriptor, { attempt: 2 }));
    expect(h.audit.records[0]?.attempt).toBe(2);
    expect(h.audit.records[0]?.policyDecisionOutcome).toBe("allow");
  });

  it("works with the default no-op sink, which drops records rather than failing calls", async () => {
    const registry = new InMemoryToolRegistry({ clock: () => AT });
    const { tracer } = recordingTracer();
    const runtime = new InMemoryToolRuntime({ registry, tracer, clock: () => AT_MS });
    const descriptor = registry.register(
      toolDescriptorInput({ registeredAt: AT }),
      valueHandler("ok"),
    );
    const result = await runtime.invoke({
      tool: { kind: "id", toolId: descriptor.id },
      arguments: { query: "x" },
      context: context(),
    });
    expect(result.status).toBe("succeeded");
  });
});

describe("telemetry", () => {
  it("opens one span per invocation, parented to the execution's span", async () => {
    const h = harness();
    const descriptor = register(h, {}, valueHandler("ok"));
    const traced = createExecutionContext(
      { traceId: createTraceId(), parentSpanId: createSpanId() },
      { clock: () => AT_MS },
    );
    await h.runtime.invoke(request(descriptor, { context: traced }));
    expect(h.spans).toHaveLength(1);
    const span = h.spans[0];
    expect(span?.recordedName).toBe("tool.invoke search_documents");
    expect(span?.ended).toBe(true);
    expect(span?.parent?.spanId).toBe(traced.parentSpanId);
    expect(span?.recordedAttributes["omnis.ai.tool.name"]).toBe("search_documents");
    expect(span?.recordedAttributes["omnis.ai.tool.id"]).toBe(descriptor.id);
    expect(span?.recordedAttributes["omnis.ai.tool.version"]).toBe("1.0.0");
    expect(span?.recordedAttributes["omnis.ai.tool.kind"]).toBe("read");
    expect(span?.recordedAttributes["omnis.ai.tool.risk_level"]).toBe("low");
    expect(span?.recordedAttributes["omnis.ai.execution.id"]).toBe(traced.executionId);
    expect(span?.recordedAttributes["omnis.ai.attempt"]).toBe(1);
    expect(span?.recordedAttributes["omnis.ai.status"]).toBe("succeeded");
    expect(span?.recordedStatuses[0]?.status).toBe("ok");
  });

  it("marks a failed span as an error with the failure code, and a denial with its reason", async () => {
    const h = harness();
    const failing = register(
      h,
      { name: "failing_tool" },
      errorResultHandler("no_index", "unavailable"),
    );
    await h.runtime.invoke(request(failing));
    const failedSpan = h.spans[0];
    expect(failedSpan?.recordedAttributes["omnis.ai.status"]).toBe("failed");
    expect(failedSpan?.recordedAttributes["omnis.ai.failure.code"]).toBe("no_index");
    expect(failedSpan?.recordedStatuses[0]?.status).toBe("error");

    const disabled = register(h, { name: "off_tool", status: "disabled" });
    await h.runtime.invoke(request(disabled));
    const deniedSpan = h.spans[1];
    expect(deniedSpan?.recordedAttributes["omnis.ai.status"]).toBe("denied");
    expect(deniedSpan?.recordedAttributes["omnis.ai.outcome"]).toBe("disabled");
    expect(deniedSpan?.ended).toBe(true);
  });

  it("never puts argument values on a span", async () => {
    const h = harness();
    const descriptor = register(h);
    await h.runtime.invoke(request(descriptor, { arguments: { query: "a very secret query" } }));
    expect(JSON.stringify(h.spans[0]?.recordedAttributes)).not.toContain("secret");
  });

  it("ends the span even when a gate refuses the call", async () => {
    const h = harness();
    const descriptor = register(h, { permissions: [{ resource: "documents", action: "admin" }] });
    await h.runtime.invoke(request(descriptor));
    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]?.ended).toBe(true);
  });
});

describe("runtime surface", () => {
  it("lists the tools a model may be offered", async () => {
    const h = harness();
    register(h, { name: "aaa" });
    register(h, { name: "bbb_disabled", status: "disabled" });
    register(h, { name: "ccc_deprecated", status: "deprecated" });
    expect(h.runtime.invocableTools().map((descriptor) => descriptor.name)).toEqual([
      "aaa",
      "ccc_deprecated",
    ]);
    expect(h.runtime.registry).toBe(h.registry);
  });

  it("is deterministic for the same request", async () => {
    const h = harness();
    const descriptor = register(h, {}, valueHandler({ rows: [1] }));
    const first = await h.runtime.invoke(
      request(descriptor, { context: context({ executionId: createExecutionId() }) }),
    );
    const second = await h.runtime.invoke(
      request(descriptor, { context: context({ executionId: createExecutionId() }) }),
    );
    expect(second.status).toBe(first.status);
    if (first.status === "succeeded" && second.status === "succeeded") {
      expect(second.value).toEqual(first.value);
      expect(second.durationMs).toBe(first.durationMs);
    }
  });
});
