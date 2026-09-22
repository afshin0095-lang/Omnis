/**
 * The bridge between a step and the runtimes that govern it.
 *
 * Two things are worth testing here beyond the obvious mapping. The first is what a step's
 * input becomes: an agent's instructions have to reach the model as messages, and a tool has
 * to receive the arguments the plan declared rather than the agent's prose. The second is
 * what the bridge refuses to do — pick a model nobody named, forge an approval, or reach past
 * the orchestrator and the tool runtime to whatever they are wrapping.
 */

import { describe, expect, it } from "vitest";
import { createExecutionId, createModelId, createProviderId, createToolId } from "@omnis/types";
import {
  createExecutionFailure,
  EMPTY_USAGE,
  messageText,
  modelById,
  toolById,
} from "@omnis/ai-core-types";
import type {
  ExecutionFailure,
  Message,
  ModelResponse,
  ToolId,
  ToolResult,
  UsageSummary,
} from "@omnis/ai-core-types";
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelOrchestrator,
} from "@omnis/model-orchestrator";
import type { ToolInvocationRequest, ToolRuntime } from "@omnis/tool-runtime";
import type { ToolDescriptor, ToolReference } from "@omnis/ai-core-types";
import {
  argumentsForStep,
  MAX_STEP_MESSAGE_TEXT,
  messagesForStep,
  modelStepExecutor,
  modelStepOutput,
  toolStepExecutor,
} from "./stepExecutors.js";
import {
  AT,
  completedResponse,
  step,
  stepEnvironment,
  toolResult,
  usageOf,
} from "./testSupport.js";

/** A message by position, failing loudly rather than handing a test `undefined`. */
function nth(messages: readonly Message[], index: number): Message {
  const message = messages[index];
  if (message === undefined) {
    throw new Error(
      `the step produced ${messages.length} messages; there is none at index ${index}`,
    );
  }
  return message;
}

/** An orchestrator that records what it was asked to do and answers with one result. */
function stubOrchestrator(result: ModelCallResult): {
  orchestrator: ModelOrchestrator;
  calls: ModelCallRequest[];
} {
  const calls: ModelCallRequest[] = [];
  const orchestrator: ModelOrchestrator = {
    async call(request: ModelCallRequest): Promise<ModelCallResult> {
      calls.push(request);
      return result;
    },
    stream(): never {
      throw new Error("a step executor has no business streaming");
    },
    candidatesFor: () => Object.freeze([]),
  };
  return { orchestrator, calls };
}

/**
 * A tool runtime that records invocations and answers with one result.
 *
 * `toolId` of `null` means "nothing is registered", which is how a step that names an
 * unknown tool is tested without inventing a registry.
 */
function stubToolRuntime(
  result: ToolResult,
  toolId: ToolId | null,
): { runtime: ToolRuntime; calls: ToolInvocationRequest[] } {
  const calls: ToolInvocationRequest[] = [];
  const descriptor = { id: toolId ?? createToolId(), name: "search_documents" } as ToolDescriptor;
  const runtime = {
    registry: {
      resolve(reference: ToolReference): ToolDescriptor | null {
        if (toolId === null) {
          return null;
        }
        if (reference.kind === "id") {
          return String(reference.toolId) === String(toolId) ? descriptor : null;
        }
        return reference.name === descriptor.name ? descriptor : null;
      },
    },
    async invoke(request: ToolInvocationRequest): Promise<ToolResult> {
      calls.push(request);
      return result;
    },
    inFlight: () => 0,
    invocableTools: () => Object.freeze([descriptor]),
    dispose: (): void => {},
  } as unknown as ToolRuntime;
  return { runtime, calls };
}

/** A succeeded model call, carrying the facts a step reports upwards. */
function succeededCall(usage: UsageSummary = usageOf()): ModelCallResult {
  const response: ModelResponse = completedResponse("the answer", usage, 21);
  return {
    status: "succeeded",
    executionId: createExecutionId(),
    modelId: createModelId(),
    providerId: createProviderId(),
    response,
    usage,
    latencyMs: 21,
    attempts: Object.freeze([]),
    fallbacks: 0,
    policyOutcome: "allow",
    policyId: null,
    budgetId: null,
    budgetStatus: null,
    startedAt: AT,
    completedAt: AT,
  };
}

/** A failed model call. */
function failedCall(failure: ExecutionFailure): ModelCallResult {
  return {
    status: "failed",
    executionId: createExecutionId(),
    modelId: null,
    providerId: null,
    failure,
    usage: EMPTY_USAGE,
    latencyMs: 4,
    attempts: Object.freeze([]),
    fallbacks: 0,
    policyOutcome: "deny",
    policyId: null,
    budgetId: null,
    budgetStatus: null,
    startedAt: AT,
    completedAt: AT,
  };
}

describe("what a model step's input becomes", () => {
  it("sends the agent's instructions as a system message, and its prohibitions as one too", () => {
    const messages = messagesForStep(
      step({
        input: {
          goal: "summarise the brief",
          briefId: "brief_1",
          instructions: {
            system: "Answer briefly.",
            developer: "Cite sources.",
            prohibitions: ["never invent a citation"],
          },
        },
      }),
    );

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "developer",
      "system",
      "user",
    ]);
    expect(messageText(nth(messages, 0))).toBe("Answer briefly.");
    expect(messageText(nth(messages, 1))).toBe("Cite sources.");
    expect(messageText(nth(messages, 2))).toContain("never invent a citation");
    // The task and its data reach the model together, so a step need not restate either.
    expect(messageText(nth(messages, 3))).toContain("summarise the brief");
    expect(messageText(nth(messages, 3))).toContain("brief_1");
  });

  it("prefers a conversation the plan carried over one it would have to invent", () => {
    const messages = messagesForStep(
      step({
        input: {
          messages: [
            { role: "user", content: [{ type: "text", text: "hello" }], name: null, metadata: {} },
          ],
          goal: "ignored",
          instructions: { system: "ignored", developer: null, prohibitions: [] },
        },
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messageText(nth(messages, 0))).toBe("hello");
  });

  it("asks for something when a step carries nothing, rather than sending an empty conversation", () => {
    const messages = messagesForStep(step({ name: "Fetch the brief", input: {} }));
    expect(messages).toHaveLength(1);
    expect(messageText(nth(messages, 0))).toContain("Fetch the brief");
  });

  it("leaves governance bookkeeping out of the prompt", () => {
    const messages = messagesForStep(
      step({
        input: {
          goal: "answer",
          policyIds: ["tenant-default"],
          arguments: { secret: "not for a provider" }, // omnis-secret-scan:allow fixture
        },
      }),
    );
    const prompt = messageText(nth(messages, 0));
    expect(prompt).toContain("answer");
    expect(prompt).not.toContain("tenant-default");
    expect(prompt).not.toContain("not for a provider");
  });

  it("bounds the prompt, so one step cannot carry an unbounded payload to a provider", () => {
    const messages = messagesForStep(
      step({ input: { goal: "a".repeat(MAX_STEP_MESSAGE_TEXT + 500) } }),
    );
    expect(messageText(nth(messages, 0)).length).toBe(MAX_STEP_MESSAGE_TEXT);
  });
});

describe("what a model step reports", () => {
  it("renders a response as facts the next step can read", () => {
    const output = modelStepOutput(completedResponse("the answer"));

    expect(output).toMatchObject({ text: "the answer", stopReason: "stop", streamed: false });
    expect(typeof output["modelId"]).toBe("string");
    expect(output["toolCalls"]).toEqual([]);
  });
});

describe("the model step executor", () => {
  it("calls the orchestrator with the step's model, identity and bounds", async () => {
    const { orchestrator, calls } = stubOrchestrator(succeededCall());
    const executor = modelStepExecutor({ orchestrator });
    const modelId = createModelId();
    const environment = stepEnvironment();

    const outcome = await executor.execute(step({ modelId, timeoutMs: 3_000 }), environment);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toEqual(modelById(modelId));
    expect(calls[0]?.executionId).toBe(environment.executionId);
    expect(calls[0]?.correlationId).toBe(environment.correlationId);
    expect(calls[0]?.tenantId).toBe(environment.tenantId);
    expect(calls[0]?.timeoutMs).toBe(3_000);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.usage.totalTokens).toBe(46);
    expect(outcome.metadata).toMatchObject({ latencyMs: 21, fallbacks: 0 });
  });

  it("refuses to choose a model for a step that named none", async () => {
    const { orchestrator, calls } = stubOrchestrator(succeededCall());
    const executor = modelStepExecutor({ orchestrator });

    const outcome = await executor.execute(step({ modelId: null }), stepEnvironment());

    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.class).toBe("validation");
    expect(outcome.failure?.message).toContain("names no model");
    // The point of the refusal: nothing was called, so no unrequested work was billed.
    expect(calls).toHaveLength(0);
  });

  it("passes a failed call through with the failure the orchestrator recorded", async () => {
    const failure = createExecutionFailure({
      class: "policy_blocked",
      code: "policy_violation",
      message: "policy denied the call",
      retryable: false,
    });
    const { orchestrator } = stubOrchestrator(failedCall(failure));
    const executor = modelStepExecutor({ orchestrator });

    const outcome = await executor.execute(step(), stepEnvironment());
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.message).toBe("policy denied the call");
    expect(outcome.failure?.class).toBe("policy_blocked");
    expect(outcome.usage).toEqual(EMPTY_USAGE);
  });

  it("adds the composition's default policy sets to the ones a step declared", async () => {
    const { orchestrator, calls } = stubOrchestrator(succeededCall());
    const executor = modelStepExecutor({ orchestrator, defaultPolicyIds: ["tenant-default"] });

    await executor.execute(
      step({ input: { goal: "answer", policyIds: ["step-policy"] } }),
      stepEnvironment(),
    );
    expect(calls[0]?.policyIds).toEqual(["tenant-default", "step-policy"]);
  });

  it("carries an approval the execution was granted into the call it authorizes", async () => {
    const { orchestrator, calls } = stubOrchestrator(succeededCall());
    const executor = modelStepExecutor({ orchestrator });
    const approval = { approved: true, approver: "ops", approvedAt: AT };

    await executor.execute(step(), stepEnvironment({ approval }));
    expect(calls[0]?.approval).toEqual(approval);

    // A refusal is not an approval, and the call is told so rather than told nothing.
    await executor.execute(
      step(),
      stepEnvironment({ approval: { approved: false, approver: "ops", approvedAt: AT } }),
    );
    expect(calls[1]?.approval).toBeNull();
  });
});

describe("what a tool step's input becomes", () => {
  it("uses the arguments the plan declared", () => {
    expect(
      argumentsForStep(
        step({ kind: "tool", input: { goal: "look it up", arguments: { query: "q3" } } }),
      ),
    ).toEqual({ query: "q3" });
  });

  it("falls back to the rest of the input, minus the plan's own bookkeeping", () => {
    const args = argumentsForStep(
      step({
        kind: "tool",
        input: {
          goal: "look it up",
          instructions: { system: "be brief" },
          tool: "search_documents",
          query: "q3",
        },
      }),
    );
    expect(args).toEqual({ query: "q3" });
  });
});

describe("the tool step executor", () => {
  it("invokes the tool runtime with the step's tool, arguments and attempt", async () => {
    const toolId = createToolId();
    const { runtime, calls } = stubToolRuntime(
      toolResult("succeeded", toolId, { documents: ["doc_1"] }),
      toolId,
    );
    const executor = toolStepExecutor({ runtime });

    const outcome = await executor.execute(
      step({ kind: "tool", modelId: null, toolId, input: { arguments: { query: "q3" } } }),
      stepEnvironment({ attempt: 2 }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toEqual(toolById(toolId));
    expect(calls[0]?.arguments).toEqual({ query: "q3" });
    expect(calls[0]?.attempt).toBe(2);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.output).toEqual({ documents: ["doc_1"] });
    expect(outcome.metadata).toMatchObject({ durationMs: 14 });
  });

  it("resolves a tool the plan named only by name", async () => {
    const toolId = createToolId();
    const { runtime, calls } = stubToolRuntime(toolResult("succeeded", toolId, "ok"), toolId);
    const executor = toolStepExecutor({ runtime });

    const outcome = await executor.execute(
      step({ kind: "tool", modelId: null, toolId: null, input: { tool: "search_documents" } }),
      stepEnvironment(),
    );
    expect(outcome.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
  });

  it("refuses a step that names no registered tool, without invoking anything", async () => {
    const { runtime, calls } = stubToolRuntime(toolResult("succeeded", createToolId(), "ok"), null);
    const executor = toolStepExecutor({ runtime });

    const outcome = await executor.execute(
      step({ kind: "tool", modelId: null, toolId: null, input: {} }),
      stepEnvironment(),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.class).toBe("validation");
    expect(outcome.failure?.message).toContain("names no registered tool");
    expect(calls).toHaveLength(0);
  });

  it("reports a denial as the denial it was, with the reason a caller can act on", async () => {
    const toolId = createToolId();
    const { runtime } = stubToolRuntime(
      toolResult("denied", toolId, "approval_required", "the tool requires an approval"),
      toolId,
    );
    const executor = toolStepExecutor({ runtime });

    const outcome = await executor.execute(
      step({ kind: "tool", modelId: null, toolId, input: {} }),
      stepEnvironment(),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.class).toBe("policy_blocked");
    expect(outcome.failure?.message).toContain("the tool requires an approval");
    // The tool's own vocabulary stays readable, without being mistaken for a platform code.
    expect(outcome.failure?.details).toMatchObject({ denial: "approval_required" });
  });

  it("classifies a tool failure by what actually happened to it", async () => {
    const toolId = createToolId();
    const timedOut = toolResult("failed", toolId, {
      errorCode: "tool_timeout",
      message: "the tool did not answer in time",
      retryable: true,
      timedOut: true,
    });
    const { runtime } = stubToolRuntime(timedOut, toolId);
    const executor = toolStepExecutor({ runtime });

    const outcome = await executor.execute(
      step({ kind: "tool", modelId: null, toolId, input: {} }),
      stepEnvironment(),
    );
    expect(outcome.failure?.class).toBe("deadline_exceeded");
    expect(outcome.failure?.code).toBe("timeout");
    expect(outcome.failure?.retryable).toBe(true);
    expect(outcome.failure?.details).toMatchObject({ toolErrorCode: "tool_timeout" });
  });

  it("classifies a cancelled tool as a cancellation rather than a crash", async () => {
    const toolId = createToolId();
    const { runtime } = stubToolRuntime(
      toolResult("failed", toolId, {
        errorCode: "tool_cancelled",
        cancelled: true,
        message: "the invocation was cancelled",
      }),
      toolId,
    );
    const executor = toolStepExecutor({ runtime });

    const outcome = await executor.execute(
      step({ kind: "tool", modelId: null, toolId, input: {} }),
      stepEnvironment(),
    );
    expect(outcome.failure?.class).toBe("cancelled");
  });

  it("forwards an approval, but only one that names who approved", async () => {
    const toolId = createToolId();
    const { runtime, calls } = stubToolRuntime(toolResult("succeeded", toolId, "ok"), toolId);
    const executor = toolStepExecutor({ runtime });
    const toolStep = step({ kind: "tool", modelId: null, toolId, input: {} });

    await executor.execute(
      toolStep,
      stepEnvironment({ approval: { approved: true, approver: "ops", approvedAt: AT } }),
    );
    expect(calls[0]?.approval).toEqual({ approved: true, approver: "ops", approvedAt: AT });

    await executor.execute(
      toolStep,
      stepEnvironment({ approval: { approved: true, approver: null, approvedAt: AT } }),
    );
    // An approval naming nobody is not forwarded: the audit row would credit an invention.
    expect(calls[1]?.approval).toBeNull();
  });

  it("hands the tool runtime the deadline the step was given", async () => {
    const toolId = createToolId();
    const { runtime, calls } = stubToolRuntime(toolResult("succeeded", toolId, "ok"), toolId);
    const executor = toolStepExecutor({ runtime });

    await executor.execute(
      step({ kind: "tool", modelId: null, toolId, timeoutMs: 900, input: {} }),
      stepEnvironment(),
    );
    expect(calls[0]?.timeoutMs).toBe(900);
  });
});

describe("what the bridge is not", () => {
  it("exposes nothing but the step kind it serves and the work it does", () => {
    // The executors are constructed from an orchestrator and a tool runtime and nothing else,
    // which is a compile-time fact; this asserts the runtime one. There is no handle here on
    // an adapter, a handler, a policy engine or a budget: a step's work arrives as a governed
    // call, and the only objects the bridge holds are the two that gate it.
    const { orchestrator } = stubOrchestrator(succeededCall());
    expect(Object.keys(modelStepExecutor({ orchestrator }))).toEqual(["kind", "execute"]);
    const { runtime } = stubToolRuntime(
      toolResult("succeeded", createToolId(), "ok"),
      createToolId(),
    );
    expect(Object.keys(toolStepExecutor({ runtime }))).toEqual(["kind", "execute"]);
  });

  it("reports the kind it was built for, so the kernel cannot hand it the wrong work", () => {
    const { orchestrator } = stubOrchestrator(succeededCall());
    expect(modelStepExecutor({ orchestrator }).kind).toBe("model");
    const { runtime } = stubToolRuntime(
      toolResult("succeeded", createToolId(), "ok"),
      createToolId(),
    );
    expect(toolStepExecutor({ runtime }).kind).toBe("tool");
  });
});
