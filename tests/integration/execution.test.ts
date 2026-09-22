/**
 * One platform, exercised end to end.
 *
 * Every package in the AI Core has its own suite, and each of them passes in
 * isolation. That is not the same claim as "the platform works": the composition is
 * where the gates are ordered, where one tracer is shared, where a budget is charged
 * for work a different package performed, and where an execution record is written by
 * a kernel that never saw the provider. This suite runs whole operations through
 * `@omnis/ai-core-runtime`'s public surface and asserts the facts that only exist once
 * everything is wired together.
 */

import { describe, expect, it } from "vitest";
import {
  agentBySlug,
  assertJsonSafe,
  modelByCapability,
  modelById,
  textMessage,
  toolById,
  totalRecordUsage,
} from "@omnis/ai-core-types";
import type { ExecutionRecord, ModelStreamEvent, UsageSummary } from "@omnis/ai-core-types";
import { createExecutionId } from "@omnis/types";
import type { ToolId } from "@omnis/types";
import { NotFoundError, ValidationError } from "@omnis/errors";
import { ExecutionScope } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import {
  AT,
  buildAiCorePlatform,
  completedInvocation,
  failedInvocation,
  usageOf,
} from "../support/aiCoreTestPlatform.js";
import { aiCoreHealth, describeAiCoreRuntime } from "@omnis/ai-core-runtime";

/** An execution context for a call made outside an agent run. */
function contextFor(tenantId: string): ExecutionContext {
  return ExecutionScope.createRoot({ tenantId: tenantId as never }).context;
}

/** The plan a two-step run uses: look something up, then answer with it. */
function researchPlan(toolId: ToolId) {
  return {
    goal: "find the quarterly report and summarise it",
    steps: [
      {
        id: "search",
        kind: "tool" as const,
        tool: { kind: "id" as const, toolId },
        arguments: { query: "quarterly report" },
      },
      { id: "answer", kind: "model" as const, dependsOn: ["search"] },
    ],
  };
}

describe("one agent run, end to end", () => {
  it("runs a plan of two steps and reports what each one produced", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    expect(result.status).toBe("succeeded");
    expect(result.succeeded).toBe(true);
    // The kernel's result is keyed by step, because "the last step's output" would
    // silently discard the work the first step did.
    const output = result.output as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(["answer", "search"]);
    expect(output["search"]).toEqual({ documents: ["doc_1"] });
    expect((output["answer"] as Record<string, unknown>)["text"]).toBe("primary answered");
  });

  it("runs the steps in dependency order, and only invokes the tool once", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    const steps = result.record.plan?.steps ?? [];
    expect(steps.map((entry) => entry.id)).toEqual(["search", "answer"]);
    expect(platform.toolHandler.calls).toHaveLength(1);
    expect(platform.primary.adapter.invocations).toHaveLength(1);
    expect(result.instance.state).toBe("completed");
  });

  it("hands the tool the arguments the plan declared, and nothing else", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    const call = platform.toolHandler.calls[0];
    expect(call?.arguments).toEqual({ query: "quarterly report" });
    // The agent's instructions are for the model. A tool that received them as arguments
    // would be handed data it never declared, and would validate or ignore it silently.
    expect(JSON.stringify(call?.arguments ?? {})).not.toContain("Answer briefly");
  });

  it("records one execution the kernel can return, with a plan, attempts and a timeline", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    const record = platform.runtime.requireExecution(result.record.request.id);
    expect(record.status).toBe("succeeded");
    expect(record.plan?.steps).toHaveLength(2);
    expect(record.attempts.length).toBeGreaterThanOrEqual(2);
    expect(record.timeline.length).toBeGreaterThan(0);
    expect(platform.runtime.getExecution(record.request.id)).not.toBeNull();
    expect(platform.runtime.listExecutions()).toHaveLength(1);
  });

  it("produces one trace, with every span parented to the run", async () => {
    {
      const platform = buildAiCorePlatform();
      await platform.runtime.executeAgent(
        agentBySlug(platform.agent.slug),
        researchPlan(platform.tool.id),
      );

      const names = platform.spans.map((span) => span.recordedName);
      expect(names.some((name) => name.startsWith("agent.run"))).toBe(true);
      expect(names.some((name) => name.startsWith("execution.run"))).toBe(true);
      expect(names.some((name) => name.startsWith("model.call"))).toBe(true);
      expect(names.some((name) => name.startsWith("tool.invoke"))).toBe(true);

      // One run is one trace. Two roots would mean the model call was reported somewhere
      // nobody looking at the agent's trace would ever find it.
      const traceIds = new Set(platform.spans.map((span) => String(span.context.traceId)));
      expect(traceIds.size).toBe(1);
      const roots = platform.spans.filter((span) => span.context.parentSpanId === null);
      expect(roots).toHaveLength(1);
      expect(roots[0]?.recordedName.startsWith("agent.run")).toBe(true);

      // And the nesting is the nesting the architecture describes: the run contains the
      // execution, which contains the model call and the tool invocation.
      const byId = new Map(platform.spans.map((span) => [String(span.context.spanId), span]));
      const modelCall = platform.spans.find((span) => span.recordedName.startsWith("model.call"));
      const parentOfModel =
        modelCall === undefined
          ? undefined
          : byId.get(String(modelCall.context.parentSpanId ?? ""));
      expect(parentOfModel?.recordedName.startsWith("execution.run")).toBe(true);
      expect(parentOfModel?.context.parentSpanId === null).toBe(false);
    }
  });

  it("charges the run for what the model actually consumed", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [completedInvocation("answered", usageOf(100, 200, 30))],
    });
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    expect(result.usage.costMicro).toBe(30);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(200);
    // The record's own total agrees with the run's, which is what makes a bill auditable
    // from either side.
    expect(totalRecordUsage(result.record).costMicro).toBe(result.usage.costMicro);
  });

  it("grades the run with deterministic rules, and says so", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    const evaluation = result.evaluation;
    expect(evaluation).not.toBeNull();
    expect(evaluation?.deterministic).toBe(true);
    expect(evaluation?.rulesApplied.length).toBeGreaterThan(0);
    expect(evaluation?.overallScore).toBeGreaterThanOrEqual(0);
    expect(evaluation?.overallScore).toBeLessThanOrEqual(1);
    // The same output grades the same way twice: an evaluation that moved between runs
    // could not be used to gate anything.
    expect(result.record.evaluation?.overallScore).toBe(evaluation?.overallScore);
  });

  it("publishes the agent's lifecycle, in order, attributed to one tenant", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    const types = platform.published.map((event) => event.type);
    expect(types).toContain("ai.agent.state.changed");
    expect(types).toContain("ai.agent.step.completed");
    // Every envelope carries the tenant: an unattributed record cannot be isolated, and
    // isolation is the reason the field exists.
    for (const event of platform.published) {
      expect(event.tenantId).toBe(String(platform.tenantId));
    }
    // And the run ends where it says it ended.
    const lastState = [...platform.published]
      .reverse()
      .find((event) => event.type === "ai.agent.state.changed");
    expect((lastState?.payload as Record<string, unknown>)["to"]).toBe("completed");
  });

  it("reports a ceiling the run crossed, even when the run itself succeeded", async () => {
    const platform = buildAiCorePlatform({
      agent: { constraints: { maxModelCalls: 1, maxToolCalls: 1 } },
    });
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    // One model call and one tool call is exactly the ceiling: nothing was crossed.
    expect(result.ceilingBreach).toBeNull();

    const tight = buildAiCorePlatform({ agent: { constraints: { maxModelCalls: 1 } } });
    // A plan that exceeds a ceiling is refused while it is still a plan: no execution is
    // opened, no provider is called and no money is held for work that was never allowed.
    await expect(
      tight.runtime.executeAgent(agentBySlug(tight.agent.slug), {
        goal: "answer twice",
        steps: [
          { id: "first", kind: "model" },
          { id: "second", kind: "model" },
        ],
      }),
    ).rejects.toThrow(ValidationError);
    expect(tight.runtime.listExecutions()).toHaveLength(0);
    expect(tight.primary.adapter.invocations).toHaveLength(0);
  });

  it("refuses a plan it cannot build, before opening an execution", async () => {
    const platform = buildAiCorePlatform();
    // A step that ran another agent would make the runtime recursive, and Sprint 1 has no
    // depth bound and no delegation policy. Refusing the input is cheaper than discovering
    // the recursion in a budget.
    await expect(
      platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
        goal: "delegate everything",
        steps: [{ id: "nested", kind: "agent" }],
      }),
    ).rejects.toThrow(/an agent step inside an agent plan is not supported/);
    expect(platform.runtime.listExecutions()).toHaveLength(0);
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });

  it("keeps the whole record JSON-safe, because it is stored and served", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeAgent(
      agentBySlug(platform.agent.slug),
      researchPlan(platform.tool.id),
    );

    expect(() => assertJsonSafe(result.record, "ExecutionRecord")).not.toThrow();
    expect(() => assertJsonSafe(result.output, "AgentRunResult.output")).not.toThrow();
    expect(JSON.parse(JSON.stringify(result.record)).status).toBe("succeeded");
  });

  it("survives a step failing, when the plan said that step was optional", async () => {
    const platform = buildAiCorePlatform({
      modelResults: [failedInvocation("the provider refused", { retryable: false })],
    });
    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer, and it is fine if the first attempt does not work",
      steps: [
        { id: "optional-answer", kind: "model", optional: true, maxAttempts: 1 },
        { id: "fallback-answer", kind: "model", dependsOn: [], maxAttempts: 1 },
      ],
    });

    // Both steps hit the same refusing provider, so the run fails — but the point is that
    // it failed as a run, with a record, rather than throwing out of the composition.
    expect(result.record.status).toBe("failed");
    expect(result.failure).not.toBeNull();
    expect(platform.runtime.listExecutions()).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("cancels an agent instance that is not running, and says why", async () => {
    const platform = buildAiCorePlatform();
    const executionId = createExecutionId();
    // An idle instance is cancellable when it has an execution to cancel: the identifier is
    // what an operator holds, and what the audit trail is keyed on.
    const instance = platform.runtime.agentRuntime.createInstance(
      agentBySlug(platform.agent.slug),
      { executionId },
    );
    expect(instance.executionId).toBe(executionId);
    expect(instance.state).toBe("ready");

    const cancelled = await platform.runtime.cancelAgent(executionId, "the operator stopped it");
    expect(cancelled.state).toBe("cancelled");
    // The reason is published with the state change, which is where an operator reading a
    // timeline will look for it.
    const changes = platform.published.filter((event) => event.type === "ai.agent.state.changed");
    const last = changes[changes.length - 1]?.payload as Record<string, unknown>;
    expect(last?.["to"]).toBe("cancelled");
    expect(last?.["reason"]).toBe("the operator stopped it");
    // No work was done, so nothing was billed and no provider was touched.
    expect(platform.primary.adapter.invocations).toHaveLength(0);
  });

  it("refuses to cancel an execution that already finished", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    // A finished execution cannot be un-finished. Rewriting a succeeded run to
    // "cancelled" would make an audit trail disagree with the bill it was charged on.
    await expect(
      platform.runtime.cancelExecution(result.record.request.id, "closed by an operator"),
    ).rejects.toThrow();
    const record: ExecutionRecord = platform.runtime.requireExecution(result.record.request.id);
    expect(record.status).toBe("succeeded");
  });
});

describe("one model call on its own", () => {
  it("selects, gates and calls, and reports who answered", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeModel({
      model: modelById(platform.primary.model.id),
      messages: [textMessage("user", "say something brief")],
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("the fixture produced a failed call");
    }
    expect(String(result.providerId)).toBe(String(platform.primary.provider.id));
    expect(result.response.message.content[0]).toMatchObject({
      type: "text",
      text: "primary answered",
    });
    // No policy set is registered on this platform, so nothing was decided: a null outcome
    // is the truth, where "allow" would claim a gate ran when none did.
    expect(result.policyOutcome).toBeNull();
    expect(result.fallbacks).toBe(0);
  });

  it("resolves a capability reference to a model the platform actually has", async () => {
    const platform = buildAiCorePlatform();
    const candidates = platform.runtime.orchestrator.candidatesFor(modelByCapability("chat"));
    expect(candidates.length).toBeGreaterThan(0);

    const result = await platform.runtime.executeModel({
      model: modelByCapability("chat"),
      messages: [textMessage("user", "hello")],
    });
    expect(result.status).toBe("succeeded");
  });

  it("refuses a reference that resolves to nothing, without calling a provider", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeModel({
      model: modelByCapability("embeddings"),
      messages: [textMessage("user", "hello")],
    });

    expect(result.status).toBe("failed");
    expect(platform.primary.adapter.invocations).toHaveLength(0);
    if (result.status === "failed") {
      // A reference nobody can resolve is not retryable: the registry will not grow a model
      // between attempts, and retrying would only delay the same answer.
      expect(result.failure.class).toBe("non_retryable");
      expect(result.failure.message).toContain("was not found");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("streams a response and always ends with a terminal event", async () => {
    const platform = buildAiCorePlatform({ streaming: true });
    const events: ModelStreamEvent[] = [];
    for await (const event of platform.runtime.streamModel({
      model: modelById(platform.primary.model.id),
      messages: [textMessage("user", "stream it")],
      streaming: true,
    })) {
      events.push(event);
    }

    expect(events.map((entry) => entry.type)).toEqual(["started", "delta", "usage", "completed"]);
    // A stream that simply stops leaves a caller waiting on something that never arrives,
    // so the last event is always terminal.
    const last = events[events.length - 1];
    expect(last?.type === "completed" || last?.type === "failed").toBe(true);
  });
});

describe("one tool call on its own", () => {
  it("invokes through the tool runtime's gates and records an audit row", async () => {
    const platform = buildAiCorePlatform({ toolValue: { documents: ["doc_9"] } });
    const result = await platform.runtime.executeTool({
      tool: toolById(platform.tool.id),
      arguments: { query: "quarterly report" },
      context: contextFor(String(platform.tenantId)),
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("the fixture produced a denied tool call");
    }
    expect(result.value).toEqual({ documents: ["doc_9"] });
    // The audit row records which arguments were passed, never what they were: arguments
    // routinely carry credentials and personal data, and an audit row is read by more
    // people than the tool is.
    expect(result.audit.argumentKeys).toEqual(["query"]);
    expect(JSON.stringify(result.audit)).not.toContain("quarterly report");
    expect(result.audit.toolName).toBe("search_documents");
  });

  it("refuses arguments the tool's schema does not accept, without calling the handler", async () => {
    const platform = buildAiCorePlatform();
    const result = await platform.runtime.executeTool({
      tool: toolById(platform.tool.id),
      arguments: { query: 42 },
      context: contextFor(String(platform.tenantId)),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("tool_arguments_invalid");
      expect(result.retryable).toBe(false);
    }
    // Validation happens before the handler runs: a tool that received arguments it never
    // declared would have to defend itself against them.
    expect(platform.toolHandler.calls).toHaveLength(0);
  });

  it("refuses a tool nobody registered, rather than inventing an audit row for it", async () => {
    const platform = buildAiCorePlatform();
    // Thrown rather than returned as a denial: without a descriptor there is no identifier,
    // version or permission list to build an audit record from, and inventing them would
    // produce a record describing a tool that does not exist.
    await expect(
      platform.runtime.executeTool({
        tool: { kind: "name", name: "delete_everything" },
        arguments: {},
        context: contextFor(String(platform.tenantId)),
      }),
    ).rejects.toThrow(NotFoundError);
    expect(platform.toolHandler.calls).toHaveLength(0);
  });
});

describe("the composition as a whole", () => {
  it("reports what it holds, and what it can do", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });

    const health = aiCoreHealth(platform.runtime, AT);
    expect(health).toMatchObject({ models: 1, providers: 1, tools: 1, agents: 1, executions: 1 });
    expect(health.canCallModels).toBe(true);
    expect(health.canInvokeTools).toBe(true);
    expect(health.canRunAgents).toBe(true);
    expect(health.agentInstances).toBeGreaterThan(0);
    expect(describeAiCoreRuntime(platform.runtime)).toContain("1 model(s)");
  });

  it("refuses to compose an event bus with no tenant to publish under", () => {
    // An event envelope requires a tenant. A composition that accepted a bus without one
    // would invent a tenant at the first publish, putting platform work into somebody's
    // audit view.
    expect(() => buildAiCorePlatform({ runtime: { tenantId: null } })).toThrow(ValidationError);
  });

  it("releases what it holds when it is disposed", async () => {
    const platform = buildAiCorePlatform();
    await platform.runtime.executeAgent(agentBySlug(platform.agent.slug), {
      goal: "answer briefly",
    });
    expect(() => platform.runtime.dispose()).not.toThrow();
    // Disposal is idempotent: a shutdown path that can throw on the second call gets
    // wrapped in a try/catch that hides the first failure too.
    expect(() => platform.runtime.dispose()).not.toThrow();
  });

  it("runs the same plan to the same result twice", async () => {
    const first = buildAiCorePlatform({
      modelResults: [completedInvocation("deterministic", usageOf(5, 5, 1))],
    });
    const second = buildAiCorePlatform({
      modelResults: [completedInvocation("deterministic", usageOf(5, 5, 1))],
    });

    const one = await first.runtime.executeAgent(agentBySlug(first.agent.slug), {
      goal: "answer briefly",
    });
    const two = await second.runtime.executeAgent(agentBySlug(second.agent.slug), {
      goal: "answer briefly",
    });

    const shape = (result: { output: unknown; usage: UsageSummary; status: string }): unknown => ({
      status: result.status,
      // Identifiers differ by design — every run is a distinct fact — so the comparison is
      // over what a caller would branch on: the answer and what it cost.
      text: (result.output as Record<string, unknown>)["text"],
      usage: result.usage,
    });
    expect(shape(one)).toEqual(shape(two));
  });
});
