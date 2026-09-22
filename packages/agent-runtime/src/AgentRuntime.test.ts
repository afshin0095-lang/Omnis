/**
 * The agent runtime end to end.
 *
 * The runtime's whole job is to be the only thing between a caller and the kernel: it
 * resolves an agent, turns its intentions into a plan, hands that plan to the kernel,
 * and reports what happened as an agent lifecycle. So these tests assert the boundaries
 * rather than the plumbing — that a run goes *through* the kernel and never around it,
 * that policy and budget are consulted before any expensive work, that a ceiling an
 * agent declares is a ceiling something enforces, and that a refusal is reported as the
 * refusal it was instead of as a failure nobody can act on.
 */

import { describe, expect, it } from "vitest";
import {
  createCorrelationId,
  createExecutionId,
  createModelId,
  createTenantId,
  createToolId,
} from "@omnis/types";
import {
  agentById,
  agentBySlug,
  createExecutionFailure,
  EMPTY_USAGE,
  modelById,
  toolById,
} from "@omnis/ai-core-types";
import type { AgentDescriptor } from "@omnis/ai-core-types";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import { createPolicyEngine } from "@omnis/policy-engine";
import {
  InMemoryExecutionKernel,
  failedOutcome,
  stepExecutor,
  succeededOutcome,
} from "@omnis/execution-kernel";
import {
  createAgentRuntime,
  DEFAULT_MAX_AGENT_INSTANCES,
  describeAgentRun,
  isApprovalRequiredFailure,
} from "./AgentRuntime.js";
import type { AgentRuntime } from "./AgentRuntime.js";
import { createAgentRegistry } from "./AgentRegistry.js";
import {
  agentFixture,
  agentRun,
  approvalPolicy,
  AT,
  denyAllPolicy,
  refusingKernel,
  registerAgent,
  runOptions,
  statesOf,
  testClock,
  tinyBudget,
} from "./testSupport.js";
import type { AgentFixture, AgentFixtureOptions } from "./testSupport.js";

/** A fixture whose agent can actually run: it declares the model its plan needs. */
function fixture(options: AgentFixtureOptions = {}): AgentFixture {
  return agentFixture({ agents: [{ defaultModel: modelById(createModelId()) }], ...options });
}

/** Two model steps, for tests that need a plan longer than one call. */
function twoModelSteps() {
  return [
    { id: "first", kind: "model" as const, model: modelById(createModelId()) },
    {
      id: "second",
      kind: "model" as const,
      dependsOn: ["first"],
      model: modelById(createModelId()),
    },
  ];
}

interface BlockingFixture {
  readonly runtime: AgentRuntime;
  readonly agent: AgentDescriptor;
  /** Lets the blocked step finish. */
  release(): void;
}

/**
 * A runtime whose single model step blocks until the test releases it.
 *
 * The only way to observe a *live* run — one that is inside the kernel right now — is to
 * make a step that has not finished yet.
 */
function blockingFixture(): BlockingFixture {
  const clock = testClock();
  const policyEngine = createPolicyEngine({ clock: () => AT });
  const budgetEngine = new InMemoryBudgetEngine({ clock: () => AT });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const kernel = new InMemoryExecutionKernel({
    clock: () => clock(),
    policyEngine,
    budgetEngine,
    executors: [
      stepExecutor("model", async () => {
        await gate;
        return succeededOutcome({ answered: true });
      }),
    ],
    defaultDeadlineMs: null,
    retryDelayMs: 0,
  });
  const registry = createAgentRegistry({ clock: () => clock() });
  const agent = registerAgent(registry, { defaultModel: modelById(createModelId()) });
  const runtime = createAgentRuntime({
    registry,
    kernel,
    policyEngine,
    clock: () => clock(),
    resolvers: {
      modelId: (reference) => (reference.kind === "id" ? reference.modelId : null),
      toolId: (reference) => (reference.kind === "id" ? reference.toolId : null),
    },
  });
  return { runtime, agent, release };
}

describe("running an agent", () => {
  it("runs an active agent by slug and returns what its step produced", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun("summarise the brief"),
    );

    expect(result.succeeded).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ answered: true });
    expect(result.failure).toBeNull();
    expect(result.instance.state).toBe("completed");
    expect(result.instance.agentId).toBe(subject.agent.id);
  });

  it("runs the same agent by identifier", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(agentById(subject.agent.id), agentRun());
    expect(result.succeeded).toBe(true);
  });

  it("hands the work to the kernel, which is what runs the step", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun());

    // The runtime owns no executor: the only way a step runs is that the kernel ran it.
    expect(subject.modelExecutor.executed).toHaveLength(1);
    expect(subject.modelExecutor.executed[0]?.step.kind).toBe("model");
    expect(subject.kernel.size).toBe(1);
    // The step's environment names an execution that exists: a step scope mints its own
    // identifier, and reporting that one would send a consumer after a record nobody wrote.
    const environment = subject.modelExecutor.executed[0]?.environment;
    expect(environment?.executionId).toBe(result.record.request.id);
    expect(subject.kernel.requireExecution(environment?.executionId as never).status).toBe(
      "succeeded",
    );
  });

  it("records the caller's execution identifier on the instance and the record", async () => {
    const subject = fixture();
    const executionId = createExecutionId();
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), { executionId });

    expect(result.record.request.id).toBe(executionId);
    expect(result.instance.executionId).toBe(executionId);
    expect(subject.runtime.requireInstance(executionId).state).toBe("completed");
  });

  it("carries the caller's tenant, mode, priority and deadline into the request", async () => {
    const subject = fixture();
    const tenantId = createTenantId();
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), {
      tenantId,
      mode: "batch",
      priority: "low",
      deadlineMs: 4_000,
    });

    expect(result.record.request.tenantId).toBe(tenantId);
    expect(result.record.request.mode).toBe("batch");
    expect(result.record.request.priority).toBe("low");
    expect(result.record.request.deadlineMs).toBe(4_000);
    expect(result.instance.metadata).toMatchObject({
      tenantId: String(tenantId),
      agentSlug: "assistant",
    });
  });

  it("keeps the run's goal and data in the request the kernel received", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun("summarise", { briefId: "brief_1" }),
    );
    expect(result.record.request.input).toMatchObject({ goal: "summarise", briefId: "brief_1" });
    // The plan is not duplicated into the request: two copies of a plan can disagree.
    expect(result.record.request.input).not.toHaveProperty("steps");
    expect(result.record.plan?.steps).toHaveLength(1);
  });

  it("accumulates the usage of every step into the result", async () => {
    const subject = fixture({
      modelOutcomes: [
        succeededOutcome(
          { first: true },
          { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5, totalTokens: 15, costMicro: 100 },
        ),
        succeededOutcome(
          { second: true },
          { ...EMPTY_USAGE, inputTokens: 20, outputTokens: 7, totalTokens: 27, costMicro: 250 },
        ),
      ],
    });
    const result = await subject.runtime.run(agentBySlug("assistant"), { steps: twoModelSteps() });

    expect(result.output).toEqual({ first: { first: true }, second: { second: true } });
    expect(result.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      costMicro: 350,
    });
  });

  it("reports a failed step as a failed run, with the failure the executor recorded", async () => {
    const subject = fixture({
      modelOutcomes: [
        failedOutcome(
          createExecutionFailure({
            class: "provider_failure",
            code: "provider_failure",
            message: "the provider refused",
            retryable: false,
          }),
        ),
      ],
    });
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());

    expect(result.succeeded).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
    expect(result.instance.state).toBe("failed");
    expect(result.failure?.message).toContain("the provider refused");
    expect(isApprovalRequiredFailure(result.failure)).toBe(false);
  });

  it("refuses a reference to an agent nobody registered, and creates no instance for it", async () => {
    const subject = fixture();
    await expect(subject.runtime.run(agentBySlug("ghost"), agentRun())).rejects.toThrow(
      NotFoundError,
    );
    expect(subject.runtime.size).toBe(0);
    expect(subject.modelExecutor.executed).toHaveLength(0);
  });

  it("refuses an agent that is still a draft, because registration defaults to not-runnable", async () => {
    const registry = createAgentRegistry();
    registerAgent(registry, {
      slug: "drafted",
      status: "draft",
      defaultModel: modelById(createModelId()),
    });
    const subject = fixture({ registry });

    let caught: unknown = null;
    try {
      await subject.runtime.run(agentBySlug("drafted"), agentRun());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).message).toContain("draft");
    expect(subject.runtime.size).toBe(0);
  });

  it("refuses a disabled or retired agent", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), status: "retired" }],
    });
    await expect(subject.runtime.run(agentBySlug("assistant"), agentRun())).rejects.toThrow(
      ConflictError,
    );
  });

  it("validates a run input before it creates anything", async () => {
    const subject = fixture();
    await expect(subject.runtime.run(agentBySlug("assistant"), { goal: "   " })).rejects.toThrow(
      ValidationError,
    );
    expect(subject.runtime.size).toBe(0);
  });

  it("refuses a plan it cannot build, and leaves the instance failed rather than running", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxSteps: 1 } }],
    });

    let caught: unknown = null;
    try {
      await subject.runtime.run(agentBySlug("assistant"), { steps: twoModelSteps() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(subject.modelExecutor.executed).toHaveLength(0);
    // The instance still tells the truth about what happened to it.
    expect(subject.runtime.instances()[0]?.state).toBe("failed");
    expect(subject.spans[0]?.recordedStatuses.at(-1)?.status).toBe("error");
  });

  it("reports a kernel that refuses the run instead of swallowing it", async () => {
    const subject = fixture({ kernel: refusingKernel("the kernel is unavailable") });

    await expect(subject.runtime.run(agentBySlug("assistant"), agentRun())).rejects.toThrow(
      "the kernel is unavailable",
    );
    expect(subject.runtime.instances()[0]?.state).toBe("failed");
  });

  it("keeps metadata that cannot be serialized out of the record, rather than storing a lie", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), {
      metadata: { handler: () => undefined, team: "growth" },
    });

    // A function has no serialized form, so it is stored as `null` under its own key: the
    // record says a value was supplied and could not be kept, which is more honest than
    // either silently storing something unserializable or pretending the key never existed.
    expect(result.record.request.metadata).toMatchObject({ team: "growth", handler: null });
    expect(typeof result.record.request.metadata?.handler).not.toBe("function");
    expect(JSON.parse(JSON.stringify(result.record.request.metadata))).toEqual(
      result.record.request.metadata,
    );
  });
});

describe("the lifecycle an operator can drive", () => {
  it("creates an idle instance without running anything", () => {
    const subject = fixture();
    const executionId = createExecutionId();
    const instance = subject.runtime.createInstance(agentBySlug("assistant"), { executionId });

    expect(instance.state).toBe("ready");
    expect(instance.executionId).toBe(executionId);
    expect(instance.descriptorVersion).toBe(subject.agent.version);
    expect(subject.modelExecutor.executed).toHaveLength(0);
    expect(statesOf(subject.recorded.stateChanges)).toEqual(["created", "ready"]);
  });

  it("refuses to create an instance of an agent that cannot run", () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), status: "disabled" }],
    });
    expect(() => subject.runtime.createInstance(agentBySlug("assistant"))).toThrow(ConflictError);
  });

  it("pauses and resumes an idle instance", () => {
    const subject = fixture();
    const executionId = createExecutionId();
    subject.runtime.createInstance(agentBySlug("assistant"), { executionId });

    expect(subject.runtime.pause(executionId, "an operator paused it").state).toBe("paused");
    // Resuming returns to `ready`, not to `running`: what happens next is the caller's
    // decision, and a runtime that guessed would re-run a plan nobody asked for again.
    expect(subject.runtime.resume(executionId).state).toBe("ready");
    expect(statesOf(subject.recorded.stateChanges)).toEqual([
      "created",
      "ready",
      "paused",
      "ready",
    ]);
  });

  it("cancels an idle instance", async () => {
    const subject = fixture();
    const executionId = createExecutionId();
    subject.runtime.createInstance(agentBySlug("assistant"), { executionId });
    const instance = await subject.runtime.cancel(executionId, "no longer needed");
    expect(instance.state).toBe("cancelled");
  });

  it("refuses to pause a run that is live, rather than reporting a pause it cannot honour", async () => {
    const blocking = blockingFixture();
    const executionId = createExecutionId();
    const pending = blocking.runtime.run(agentById(blocking.agent.id), agentRun(), { executionId });

    expect(blocking.runtime.requireInstance(executionId).state).toBe("running");
    expect(() => blocking.runtime.pause(executionId, "an operator paused it")).toThrow(
      ConflictError,
    );

    blocking.release();
    await pending;
  });

  it("asks the kernel to stop a live run, and the run ends cancelled", async () => {
    const blocking = blockingFixture();
    const executionId = createExecutionId();
    const pending = blocking.runtime.run(agentById(blocking.agent.id), agentRun(), { executionId });

    const instance = await blocking.runtime.cancel(executionId, "an operator stopped it");
    expect(instance.state).toBe("cancelled");

    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.succeeded).toBe(false);
    expect(result.failure?.class).toBe("cancelled");
    expect(result.failure?.message).toContain("an operator stopped it");
    blocking.release();
  });

  it("refuses an illegal move on a finished run", async () => {
    const subject = fixture();
    const executionId = createExecutionId();
    await subject.runtime.run(agentBySlug("assistant"), agentRun(), { executionId });

    expect(() => subject.runtime.transition(executionId, "running")).toThrow(ConflictError);
    expect(() => subject.runtime.pause(executionId, "too late")).toThrow(ConflictError);
  });

  it("refuses to address an execution it has never seen", () => {
    const subject = fixture();
    expect(subject.runtime.instance(createExecutionId())).toBeNull();
    expect(() => subject.runtime.requireInstance(createExecutionId())).toThrow(NotFoundError);
    expect(() => subject.runtime.pause(createExecutionId(), "nobody")).toThrow(NotFoundError);
  });

  it("lists instances, and filters them by agent", async () => {
    const subject = fixture({
      agents: [
        { slug: "assistant", defaultModel: modelById(createModelId()) },
        { slug: "researcher", defaultModel: modelById(createModelId()) },
      ],
    });
    const first = await subject.runtime.run(agentBySlug("assistant"), agentRun());
    subject.runtime.createInstance(agentBySlug("researcher"));

    expect(subject.runtime.instances()).toHaveLength(2);
    expect(subject.runtime.instances(first.instance.agentId)).toHaveLength(1);
    expect(subject.runtime.instances(first.instance.agentId)[0]?.executionId).toBe(
      first.record.request.id,
    );
    expect(subject.runtime.size).toBe(2);
  });

  it("stops tracking instances at its limit, rather than growing without bound", () => {
    const subject = fixture({ runtime: { maxInstances: 2 } });
    subject.runtime.createInstance(agentBySlug("assistant"));
    subject.runtime.createInstance(agentBySlug("assistant"));

    let caught: unknown = null;
    try {
      subject.runtime.createInstance(agentBySlug("assistant"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).message).toContain("2");
    expect(DEFAULT_MAX_AGENT_INSTANCES).toBeGreaterThan(2);
  });

  it("forgets every instance on disposal", async () => {
    const subject = fixture();
    await subject.runtime.run(agentBySlug("assistant"), agentRun());
    subject.runtime.createInstance(agentBySlug("assistant"));
    expect(subject.runtime.size).toBe(2);

    subject.runtime.dispose();
    expect(subject.runtime.size).toBe(0);
    expect(subject.runtime.instances()).toEqual([]);
  });

  it("cancels a live run on disposal instead of leaving it running", async () => {
    const blocking = blockingFixture();
    const executionId = createExecutionId();
    const pending = blocking.runtime.run(agentById(blocking.agent.id), agentRun(), { executionId });

    blocking.runtime.dispose();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(blocking.runtime.size).toBe(0);
    blocking.release();
  });
});

describe("policy and budget, consulted before the work", () => {
  it("stops a run a policy denies, before any step executes", async () => {
    const subject = fixture();
    const { policyId } = denyAllPolicy(subject.policyEngine);
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ policyIds: [policyId] }),
    );

    expect(result.succeeded).toBe(false);
    expect(result.instance.state).toBe("failed");
    expect(result.failure?.class).toBe("policy_blocked");
    expect(subject.modelExecutor.executed).toHaveLength(0);
  });

  it("stops a run a budget cannot cover, before the expensive step", async () => {
    const subject = fixture();
    const { budgetId } = tinyBudget(subject.budgetEngine);
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ budgetId }),
    );

    expect(result.succeeded).toBe(false);
    expect(result.failure?.class).toBe("budget_blocked");
    expect(subject.modelExecutor.executed).toHaveLength(0);
  });

  it("applies the descriptor's own policy set, not only the ones a run names", async () => {
    // One engine behind both registrations: a policy set the kernel has never seen would
    // fail the run closed, which is a different fact from the one under test.
    const policyEngine = createPolicyEngine({ clock: () => AT });
    const { policyId } = denyAllPolicy(policyEngine);
    const registry = createAgentRegistry();
    registerAgent(registry, {
      slug: "governed",
      status: "active",
      defaultModel: modelById(createModelId()),
      policyId,
    });
    const governed = fixture({ registry, policyEngine });

    const result = await governed.runtime.run(agentBySlug("governed"), agentRun(), runOptions());
    expect(result.failure?.class).toBe("policy_blocked");
    expect(governed.modelExecutor.executed).toHaveLength(0);
  });

  it("applies the runtime's default policy sets to every run", async () => {
    const policyEngine = createPolicyEngine({ clock: () => AT });
    const { policyId } = denyAllPolicy(policyEngine);
    const subject = fixture({ policyEngine, defaultPolicyIds: [policyId] });

    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());
    expect(result.failure?.class).toBe("policy_blocked");
  });

  it("turns an agent's ceilings into policy the kernel enforces", async () => {
    // `maxSteps` is a ceiling the kernel understands, so a plan that fits but a policy
    // set that does not is refused by the gate rather than by the planner.
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxSteps: 1 } }],
    });
    const result = await subject.runtime
      .run(agentBySlug("assistant"), { steps: twoModelSteps() })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ValidationError);
  });

  it("refuses a plan that asks for more model calls than the agent allows", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxModelCalls: 1 } }],
    });

    let message = "";
    try {
      await subject.runtime.run(agentBySlug("assistant"), { steps: twoModelSteps() });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("2 model call(s)");
    expect(message).toContain("allows 1");
    expect(subject.modelExecutor.executed).toHaveLength(0);
  });

  it("refuses a plan that asks for more tool calls than the agent allows", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxToolCalls: 1 } }],
    });

    let message = "";
    try {
      await subject.runtime.run(agentBySlug("assistant"), {
        steps: [
          { id: "one", kind: "tool", tool: toolById(createToolId()) },
          { id: "two", kind: "tool", tool: toolById(createToolId()) },
        ],
      });
    } catch (error) {
      message = (error as ValidationError).message;
    }
    expect(message).toContain("2 tool call(s)");
  });

  it("stops a live run that spends more than its cost ceiling, and says so", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxCostMicroUsd: 150 } }],
      modelOutcomes: [
        succeededOutcome(
          { first: true },
          { ...EMPTY_USAGE, inputTokens: 1, outputTokens: 1, totalTokens: 2, costMicro: 200 },
        ),
        succeededOutcome({ second: true }),
      ],
    });
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      { steps: twoModelSteps() },
      runOptions(),
    );

    expect(result.succeeded).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(result.failure?.message).toContain("150 micro-USD");
    // The second call never happened: the ceiling stopped the run, it did not merely report it.
    expect(subject.modelExecutor.executed).toHaveLength(1);
    expect(statesOf(subject.recorded.stateChanges).at(-1)).toBe("cancelled");
  });

  it("stops a live run that makes more model calls than its ceiling, counting retries as calls", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxModelCalls: 1 } }],
      modelOutcomes: [succeededOutcome({ first: true })],
    });
    // A plan of one step fits the ceiling, so the run starts; a second call would not.
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      { steps: twoModelSteps().slice(0, 1) },
      runOptions(),
    );
    expect(result.succeeded).toBe(true);
    expect(subject.modelExecutor.executed).toHaveLength(1);
    expect(result.ceilingBreach).toBeNull();
  });

  it("reports a ceiling the final call crossed, even though nothing was left to stop", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), constraints: { maxCostMicroUsd: 150 } }],
      modelOutcomes: [succeededOutcome({ only: true }, { ...EMPTY_USAGE, costMicro: 400 })],
    });
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());

    // The run succeeded and overspent: both facts belong in the report.
    expect(result.succeeded).toBe(true);
    expect(result.ceilingBreach).toContain("150 micro-USD");
    expect(describeAgentRun(result)).toContain("an agent ceiling was crossed");
  });
});

describe("approvals", () => {
  it("settles to waiting when policy requires an approval, rather than reporting a broken agent", async () => {
    const subject = fixture();
    const { policyId } = approvalPolicy(subject.policyEngine);
    const result = await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ policyIds: [policyId] }),
    );

    expect(result.succeeded).toBe(false);
    expect(result.instance.state).toBe("waiting");
    expect(result.instance.waitingOn).toBe("approval");
    expect(isApprovalRequiredFailure(result.failure)).toBe(true);
    expect(subject.modelExecutor.executed).toHaveLength(0);
  });

  it("clears what an instance was waiting on once it stops waiting", async () => {
    const subject = fixture();
    const { policyId } = approvalPolicy(subject.policyEngine);
    const executionId = createExecutionId();
    await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ policyIds: [policyId], executionId }),
    );
    expect(subject.runtime.requireInstance(executionId).waitingOn).toBe("approval");

    const approved = await subject.runtime.approve(
      executionId,
      { approved: true, approver: "ops", approvedAt: AT },
      runOptions({ policyIds: [policyId] }),
    );
    expect(approved.instance.waitingOn).toBeNull();
    expect(approved.instance.state).toBe("completed");
  });

  it("runs the approved work as a child of the run that waited, at the next attempt", async () => {
    const subject = fixture();
    const { policyId } = approvalPolicy(subject.policyEngine);
    const waitingId = createExecutionId();
    await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ policyIds: [policyId], executionId: waitingId }),
    );

    const approved = await subject.runtime.approve(
      waitingId,
      { approved: true, approver: "ops", approvedAt: AT },
      runOptions({ policyIds: [policyId] }),
    );

    expect(approved.succeeded).toBe(true);
    expect(approved.record.request.parentExecutionId).toBe(waitingId);
    expect(approved.instance.attempt).toBe(2);
    // The waiting execution is over: the kernel cannot reopen a finished record, so the
    // honest report is that it was superseded.
    expect(subject.runtime.requireInstance(waitingId).state).toBe("cancelled");
    expect(subject.modelExecutor.executed).toHaveLength(1);
  });

  it("keeps the correlation the caller chose across an approval, so the lineage reads as one decision", async () => {
    const subject = fixture();
    const { policyId } = approvalPolicy(subject.policyEngine);
    const options = runOptions({ policyIds: [policyId], correlationId: createCorrelationId() });
    const waitingId = createExecutionId();
    const waiting = await subject.runtime.run(agentBySlug("assistant"), agentRun(), {
      ...options,
      executionId: waitingId,
    });

    const approved = await subject.runtime.approve(
      waitingId,
      { approved: true, approver: "ops", approvedAt: AT },
      options,
    );
    expect(approved.record.request.correlationId).toBe(waiting.record.request.correlationId);
  });

  it("refuses an approval that was not granted", async () => {
    const subject = fixture();
    const { policyId } = approvalPolicy(subject.policyEngine);
    const waitingId = createExecutionId();
    await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ policyIds: [policyId], executionId: waitingId }),
    );

    const refused = await subject.runtime.approve(
      waitingId,
      { approved: false, approver: "ops", approvedAt: AT },
      runOptions({ policyIds: [policyId] }),
    );
    expect(refused.succeeded).toBe(false);
    expect(refused.instance.state).toBe("waiting");
    expect(subject.modelExecutor.executed).toHaveLength(0);
  });

  it("refuses to approve a run that is not waiting for an approval", async () => {
    const subject = fixture();
    const executionId = createExecutionId();
    await subject.runtime.run(agentBySlug("assistant"), agentRun(), { executionId });

    await expect(
      subject.runtime.approve(executionId, { approved: true, approver: "ops", approvedAt: AT }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("what the platform is told", () => {
  it("publishes every state the instance passed through, in order", async () => {
    const subject = fixture();
    await subject.runtime.run(agentBySlug("assistant"), agentRun());
    expect(statesOf(subject.recorded.stateChanges)).toEqual([
      "created",
      "ready",
      "planning",
      "running",
      "completed",
    ]);
  });

  it("publishes step outcomes as they happen", async () => {
    const subject = fixture();
    await subject.runtime.run(agentBySlug("assistant"), { steps: twoModelSteps() });
    expect(subject.recorded.stepEvents.map((event) => [event.kind, event.stepId])).toEqual([
      ["completed", "first"],
      ["completed", "second"],
    ]);
  });

  it("publishes a failed step as failed", async () => {
    const subject = fixture({
      modelOutcomes: [
        failedOutcome(
          createExecutionFailure({
            class: "tool_failure",
            code: "execution_failed",
            message: "no result",
            retryable: false,
          }),
        ),
      ],
    });
    await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());
    expect(subject.recorded.stepEvents.map((event) => event.kind)).toEqual(["failed"]);
  });

  it("publishes payloads a real bus accepts, so the events satisfy their contracts", async () => {
    const subject = fixture({ events: "bus" });
    await subject.runtime.run(agentBySlug("assistant"), { steps: twoModelSteps() }, runOptions());

    const types = subject.bus.published.map((event) => event.type);
    expect(types).toContain("ai.agent.state.changed");
    expect(types).toContain("ai.agent.step.completed");
    expect(subject.runtime.publishFailures()).toEqual([]);
  });

  it("keeps a secret out of the spans and the events a run produces", async () => {
    const subject = fixture({ events: "bus" });
    await subject.runtime.run(
      agentBySlug("assistant"),
      agentRun(),
      runOptions({ metadata: { apiKey: "sk-live-secret" } }), // omnis-secret-scan:allow a deliberate fake, used to prove this value is redacted
    );

    const serialized =
      JSON.stringify(subject.spans.map((span) => span.recordedAttributes)) +
      JSON.stringify(subject.bus.published);
    expect(serialized).not.toContain("sk-live-secret");
  });

  it("reports a run on a span that carries the agent's identity and the outcome", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());
    const span = subject.spans[0];

    expect(span?.recordedName).toContain("assistant");
    expect(span?.recordedAttributes).toMatchObject({
      "omnis.ai.agent.name": "assistant",
      "omnis.ai.execution.id": String(result.record.request.id),
      "omnis.ai.status": "completed",
    });
    expect(span?.recordedStatuses.at(-1)?.status).toBe("ok");
    expect(span?.ended).toBe(true);
  });

  it("nests the kernel's own span under the agent's, so one run reads as one trace", async () => {
    const subject = fixture();
    await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());

    const agentSpan = subject.spans[0];
    const kernelSpan = subject.spans.find((span) => span !== agentSpan);
    expect(agentSpan?.context.traceId).not.toBeNull();
    expect(kernelSpan?.context.traceId).toBe(agentSpan?.context.traceId);
    expect(kernelSpan?.context.parentSpanId).toBe(agentSpan?.context.spanId);
  });

  it("marks the span as an error when the run did not succeed", async () => {
    const subject = fixture({
      modelOutcomes: [
        failedOutcome(
          createExecutionFailure({
            class: "provider_failure",
            code: "provider_failure",
            message: "refused",
            retryable: false,
          }),
        ),
      ],
    });
    await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());
    expect(subject.spans[0]?.recordedStatuses.at(-1)?.status).toBe("error");
  });

  it("keeps running when the bus refuses an event, and reports the refusal separately", async () => {
    const broken = {
      stateChanged() {
        throw new Error("bus unavailable");
      },
      stepCompleted() {
        throw new Error("bus unavailable");
      },
      stepFailed() {
        throw new Error("bus unavailable");
      },
      publishFailures() {
        return Object.freeze([]);
      },
    };
    const subject = fixture({ events: broken });
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun());

    // A telemetry failure is not a run failure: the work happened, and saying otherwise
    // would make an outage of the bus look like an outage of the agent.
    expect(result.succeeded).toBe(true);
    expect(result.instance.state).toBe("completed");
    const failures = subject.runtime.publishFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]?.message).toContain("bus unavailable");
  });
});

describe("the result a caller reads", () => {
  it("renders a run in one line, including why it did not succeed", async () => {
    const subject = fixture({
      modelOutcomes: [
        failedOutcome(
          createExecutionFailure({
            class: "provider_failure",
            code: "provider_failure",
            message: "the provider refused",
            retryable: false,
          }),
        ),
      ],
    });
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun(), runOptions());
    const described = describeAgentRun(result);

    expect(described).toContain(String(result.record.request.id));
    expect(described).toContain("failed");
    expect(described).toContain("the provider refused");
  });

  it("renders a succeeded run without inventing a reason", async () => {
    const subject = fixture();
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun());
    expect(describeAgentRun(result)).toBe(
      `agent run ${String(result.record.request.id)} ended succeeded`,
    );
  });

  it("records the descriptor version the run used, so a result can be reproduced", async () => {
    const subject = fixture({
      agents: [{ defaultModel: modelById(createModelId()), version: "4.2.0" }],
    });
    const result = await subject.runtime.run(agentBySlug("assistant"), agentRun());
    expect(result.instance.descriptorVersion).toBe("4.2.0");
    expect(result.record.request.agentId).toBe(subject.agent.id);
  });
});
