/**
 * A stand-in for the backend that runs the AI Core.
 *
 * The Studio has no backend yet, and a surface with nothing to talk to cannot be built or
 * reviewed. This module is what stands in for one: it implements the same
 * {@link AiCoreTransport} a real service would, answers with the same payload shapes, and
 * fails with the same error types — so the client, the view models and the screens above
 * them are exercised against something that behaves like the platform rather than against
 * a pile of literals in a component.
 *
 * What it is not, stated plainly because a mock that overclaims is worse than no mock:
 *
 * - it calls no provider and runs no model. A run is *simulated*: its output says so.
 * - it decides no policy and holds no budget. A denial here is a configured outcome, not a
 *   judgement, and it exists so a screen that has to render a refusal can be built.
 * - it is deterministic on purpose. Identifiers are derived from names, timestamps are
 *   fixed unless told otherwise, and two runs of the same operations produce equal
 *   payloads, so a snapshot of a screen means something.
 *
 * When the real backend arrives, this file is deleted and nothing above the client
 * changes. That is the test of whether the seam was drawn in the right place.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import type { JsonObject } from "@omnis/types";
import type { AiCoreOperation, AiCoreTransport } from "./client";

/** What the next agent run does. A mock declares its behaviour rather than improvising it. */
export type MockRunOutcome = "succeeded" | "policy_denied" | "requires_approval";

export interface MockAiCoreOptions {
  /** Defaults to a successful run. */
  readonly runOutcome?: MockRunOutcome;
  /** What a simulated run costs, in integer micro-USD. Defaults to 1_850. */
  readonly costMicroUsd?: number;
  /** Every timestamp the mock reports. Defaults to a fixed instant, so runs are equal. */
  readonly now?: string;
}

export interface MockAiCoreRuntime extends AiCoreTransport {
  /** The executions the mock has recorded, oldest first. */
  readonly executions: readonly JsonObject[];
  /** Forgets every recorded execution, keeping the catalog. */
  reset(): void;
}

/** The instant every mock timestamp defaults to. */
export const MOCK_NOW = "2026-01-15T09:30:00.000Z";

/** Crockford base32, the alphabet OMNIS identifiers use. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * An identifier that looks like the platform's and never changes.
 *
 * Random identifiers would make every assertion about a mock payload an assertion about
 * nothing, and every screenshot different. These are derived from a seed, so the same
 * model is the same model in every run of every test.
 */
function deterministicId(prefix: string, seed: string): string {
  let hash = 2_166_136_261;
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    hash = (hash ^ seed.charCodeAt(index % seed.length)) >>> 0;
    hash = (hash * 1_677_7619) >>> 0;
    body += ALPHABET[hash % ALPHABET.length];
  }
  return `${prefix}_${body}`;
}

/** The tenant every mock execution belongs to. */
const TENANT_ID = deterministicId("ten", "omnis-studio-mock");

const PROVIDERS: readonly JsonObject[] = [
  {
    id: deterministicId("prv", "aurora"),
    slug: "aurora",
    displayName: "Aurora Inference",
    transport: "http",
    status: "ready",
    capabilities: {
      operations: ["chat", "embed"],
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      modelCapabilities: ["chat", "reasoning", "vision"],
    },
    rateLimit: { requestsPerMinute: 600, tokensPerMinute: 240_000, maxConcurrentRequests: 8 },
    priority: 5,
    latencyClass: "low",
    region: "eu-west",
    policyId: null,
    budgetId: null,
    credentialsConfigured: true,
    metadata: {},
    registeredAt: MOCK_NOW,
    health: {
      providerId: deterministicId("prv", "aurora"),
      state: "healthy",
      consecutiveFailures: 0,
      consecutiveSuccesses: 12,
      lastSuccessAt: MOCK_NOW,
      lastFailureAt: null,
      lastFailureClass: null,
      averageLatencyMs: 420,
      observedAt: MOCK_NOW,
    },
  },
  {
    id: deterministicId("prv", "meridian"),
    slug: "meridian",
    displayName: "Meridian Compute",
    transport: "http",
    status: "degraded",
    capabilities: {
      operations: ["chat"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      modelCapabilities: ["chat"],
    },
    rateLimit: { requestsPerMinute: 120, tokensPerMinute: 60_000, maxConcurrentRequests: 4 },
    priority: 10,
    latencyClass: "medium",
    region: null,
    policyId: null,
    budgetId: null,
    credentialsConfigured: true,
    metadata: {},
    registeredAt: MOCK_NOW,
    health: {
      providerId: deterministicId("prv", "meridian"),
      state: "degraded",
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: MOCK_NOW,
      lastFailureClass: "provider_failure",
      averageLatencyMs: 1_900,
      observedAt: MOCK_NOW,
    },
  },
];

function providerBySlug(slug: string): JsonObject {
  const found = PROVIDERS.find((provider) => provider.slug === slug);
  if (found === undefined) {
    throw new NotFoundError("mock provider", slug);
  }
  return found;
}

/** A model descriptor in the shape the platform reports one. */
function model(
  slug: string,
  options: {
    readonly provider: string;
    readonly kind: string;
    readonly capabilities: readonly string[];
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
    readonly priority: number;
    readonly latencyClass: string;
    /** `null` for a model nobody has priced, which is a state a screen must render. */
    readonly inputPerThousandTokens: number | null;
    readonly outputPerThousandTokens: number | null;
    readonly modalities: readonly string[];
  },
): JsonObject {
  return {
    id: deterministicId("mdl", slug),
    slug,
    displayName: slug
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    providerId: String(providerBySlug(options.provider).id),
    kind: options.kind,
    capabilities: [...options.capabilities],
    modalities: { input: [...options.modalities], output: ["text"] },
    contextWindowTokens: options.contextWindowTokens,
    maxOutputTokens: options.maxOutputTokens,
    pricing:
      options.inputPerThousandTokens === null || options.outputPerThousandTokens === null
        ? null
        : {
            currency: "USD",
            unit: "micro",
            inputPerThousandTokens: options.inputPerThousandTokens,
            outputPerThousandTokens: options.outputPerThousandTokens,
            cachedInputPerThousandTokens: 0,
            perRequestMicro: 0,
          },
    priority: options.priority,
    latencyClass: options.latencyClass,
    status: "selectable",
    providerModelName: `${options.provider}-${slug}`,
    metadata: {},
    registeredAt: MOCK_NOW,
  };
}

const MODELS: readonly JsonObject[] = [
  model("aurora-class", {
    provider: "aurora",
    kind: "general",
    capabilities: ["chat", "reasoning"],
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    priority: 5,
    latencyClass: "low",
    inputPerThousandTokens: 120,
    outputPerThousandTokens: 360,
    modalities: ["text"],
  }),
  model("aurora-vision", {
    provider: "aurora",
    kind: "vision",
    capabilities: ["chat", "vision"],
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
    priority: 20,
    latencyClass: "medium",
    // Unpriced on purpose: a cost column that has never seen a null is a column that will
    // show $0.00 for something nobody has costed.
    inputPerThousandTokens: null,
    outputPerThousandTokens: null,
    modalities: ["text", "image"],
  }),
  model("meridian-class", {
    provider: "meridian",
    kind: "general",
    capabilities: ["chat"],
    contextWindowTokens: 32_000,
    maxOutputTokens: 1_024,
    priority: 10,
    latencyClass: "medium",
    inputPerThousandTokens: 60,
    outputPerThousandTokens: 180,
    modalities: ["text"],
  }),
];

const TOOLS: readonly JsonObject[] = [
  {
    id: deterministicId("tol", "web-search"),
    name: "web-search",
    displayName: "Web search",
    description: "Searches the public web and returns ranked excerpts with their sources.",
    version: "1.0.0",
    kind: "retrieval",
    riskLevel: "medium",
    sideEffect: "read",
    permissions: ["web:read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        maxResults: { type: "number", description: "How many excerpts to return." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    resultDescription: "A list of excerpts, each with a title, a source and a snippet.",
    timeoutMs: 8_000,
    supportsCancellation: true,
    maxConcurrency: 4,
    requiresApproval: false,
    policyId: null,
    budgetId: null,
    status: "invocable",
    metadata: {},
    registeredAt: MOCK_NOW,
  },
  {
    id: deterministicId("tol", "publish-post"),
    name: "publish-post",
    displayName: "Publish a post",
    description: "Publishes a finished post to a connected channel. This cannot be undone.",
    version: "1.0.0",
    kind: "action",
    // A critical, irreversible tool with no approval requirement would be a design bug in
    // the platform; the mock shows the pairing an operator screen has to render.
    riskLevel: "critical",
    sideEffect: "write",
    permissions: ["channel:publish"],
    parameters: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Where to publish." },
        postId: { type: "string", description: "What to publish." },
      },
      required: ["channelId", "postId"],
      additionalProperties: false,
    },
    resultDescription: "The published post's identifier and its channel URL.",
    timeoutMs: 15_000,
    supportsCancellation: false,
    maxConcurrency: 1,
    requiresApproval: true,
    policyId: null,
    budgetId: null,
    status: "invocable",
    metadata: {},
    registeredAt: MOCK_NOW,
  },
];

const AGENT: JsonObject = {
  id: deterministicId("agt", "researcher"),
  slug: "researcher",
  displayName: "Researcher",
  description: "Researches a topic, drafts a summary and cites what it used.",
  kind: "task",
  status: "ready",
  version: "1.0.0",
  capabilities: ["research", "summarize"],
  instructions: {
    system: "You research a topic and summarize it with citations.",
    style: null,
    examples: [],
  },
  defaultModel: { kind: "capability", value: "chat" },
  tools: [
    {
      toolId: String(TOOLS[0]?.id ?? ""),
      timeoutMsOverride: null,
      maxCallsPerExecution: 3,
      required: true,
    },
  ],
  memory: [],
  constraints: {
    maxSteps: 8,
    maxModelCalls: 4,
    maxToolCalls: 6,
    maxDurationMs: 120_000,
    maxCostMicroUsd: 25_000,
    maxRetriesPerStep: 1,
    allowedTools: [],
    deniedTools: [],
    approvalRequiredAtRisk: ["critical"],
    preferredModels: [{ kind: "slug", value: "aurora-class" }],
  },
  policyId: null,
  budgetId: null,
  metadata: {},
  createdAt: MOCK_NOW,
  updatedAt: MOCK_NOW,
};

/** A usage summary in the platform's shape. */
function usageOf(costMicro: number | null): JsonObject {
  return {
    inputTokens: 820,
    outputTokens: 240,
    totalTokens: 1_060,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    requests: 1,
    costMicro,
  };
}

/** A failure in the platform's shape. */
function failureOf(input: {
  readonly klass: string;
  readonly code: string;
  readonly message: string;
  readonly now: string;
  readonly executionId: string;
  readonly stepId?: string | null;
}): JsonObject {
  return {
    class: input.klass,
    code: input.code,
    message: input.message,
    retryable: false,
    retryAfterMs: null,
    attempt: 1,
    stepId: input.stepId ?? null,
    executionId: input.executionId,
    modelId: null,
    providerId: null,
    toolId: null,
    details: input.klass === "policy_blocked" ? { approvalRequired: false } : {},
    occurredAt: input.now,
  };
}

/**
 * Builds the mock.
 *
 * The catalog is fixed; the execution log grows as operations run, so a screen that lists
 * executions has something to list after a run, and one that runs before anything has been
 * run shows the empty state rather than a fiction.
 */
export function createMockAiCoreRuntime(options: MockAiCoreOptions = {}): MockAiCoreRuntime {
  const outcome: MockRunOutcome = options.runOutcome ?? "succeeded";
  const costMicroUsd = options.costMicroUsd ?? 1_850;
  const now = options.now ?? MOCK_NOW;
  const executions: JsonObject[] = [];
  let sequence = 0;

  function requireExecution(executionId: string): { index: number; record: JsonObject } {
    const index = executions.findIndex(
      (record) => String((record.request as JsonObject).id) === executionId,
    );
    if (index < 0) {
      throw new NotFoundError("execution", executionId);
    }
    const record = executions[index];
    if (record === undefined) {
      throw new NotFoundError("execution", executionId);
    }
    return { index, record };
  }

  /**
   * Records a simulated agent run, in the shape the platform records one.
   *
   * `override` exists for one caller: an approval that has been granted continues as a
   * successful run whatever the mock was configured to do first, because the configured
   * outcome describes the *initial* request and a human has since answered it.
   */
  function runAgent(goal: string, override: MockRunOutcome | null = null): JsonObject {
    const effectiveOutcome: MockRunOutcome = override ?? outcome;
    if (goal.trim().length === 0) {
      // The real runtime validates this before it plans; a mock that accepted an empty goal
      // would let a screen pass review and fail against the platform.
      throw new ValidationError("an agent run needs a goal");
    }
    sequence += 1;
    const executionId = deterministicId("exe", `mock-run-${sequence}`);
    const correlationId = deterministicId("cor", `mock-run-${sequence}`);
    const agentId = String(AGENT.id);
    const modelId = String(MODELS[0]?.id ?? "");
    const providerId = String(MODELS[0]?.providerId ?? "");
    const toolId = String(TOOLS[0]?.id ?? "");

    const request: JsonObject = {
      id: executionId,
      kind: "agent",
      correlationId,
      causationId: null,
      traceId: deterministicId("trc", `mock-run-${sequence}`),
      tenantId: TENANT_ID,
      parentExecutionId: null,
      agentId,
      model: null,
      tool: null,
      input: { goal },
      mode: "synchronous",
      priority: "normal",
      policyId: null,
      budgetId: null,
      deadlineMs: null,
      metadata: {},
      requestedAt: now,
    };

    const steps: readonly JsonObject[] = [
      {
        id: "research",
        name: "research",
        kind: "tool",
        dependsOn: [],
        timeoutMs: 8_000,
        maxAttempts: 1,
        optional: false,
        input: { query: goal },
        modelId: null,
        providerId: null,
        toolId,
        metadata: {},
      },
      {
        id: "draft",
        name: "draft",
        kind: "model",
        dependsOn: ["research"],
        timeoutMs: null,
        maxAttempts: 2,
        optional: false,
        input: { goal },
        modelId,
        providerId,
        toolId: null,
        metadata: {},
      },
    ];
    const plan: JsonObject = { steps };

    if (effectiveOutcome === "policy_denied") {
      const failure = failureOf({
        klass: "policy_blocked",
        code: "policy_violation",
        message: "the policy set bound to this agent denies the call",
        now,
        executionId,
      });
      return record({
        request,
        status: "failed",
        plan: null,
        attempts: [],
        result: {
          status: "failed",
          executionId,
          output: null,
          usage: usageOf(null),
          evaluation: null,
          failure,
          finishedAt: now,
          durationMs: 4,
          metadata: {},
        },
        governance: { policyOutcome: "deny", ceilingBreach: null },
        timeline: [],
        evaluation: null,
        createdAt: now,
        updatedAt: now,
        instance: { state: "failed", attempt: 1, waitingOn: null },
        run: {
          succeeded: false,
          output: null,
          usage: usageOf(null),
          failure,
          ceilingBreach: null,
        },
      });
    }

    if (effectiveOutcome === "requires_approval") {
      const failure = failureOf({
        klass: "policy_blocked",
        code: "policy_violation",
        message: "a policy requires an approval before this run may continue",
        now,
        executionId,
      });
      return record({
        request,
        status: "failed",
        plan,
        attempts: [],
        result: {
          status: "failed",
          executionId,
          output: null,
          usage: usageOf(null),
          evaluation: null,
          failure: { ...failure, details: { approvalRequired: true } },
          finishedAt: now,
          durationMs: 6,
          metadata: {},
        },
        governance: { policyOutcome: "require_approval", ceilingBreach: null },
        timeline: [],
        evaluation: null,
        createdAt: now,
        updatedAt: now,
        instance: { state: "waiting", attempt: 1, waitingOn: "approval" },
        run: {
          succeeded: false,
          output: null,
          usage: usageOf(null),
          failure: { ...failure, details: { approvalRequired: true } },
          ceilingBreach: null,
        },
      });
    }

    const succeededUsage = usageOf(costMicroUsd);
    const evaluation = {
      id: deterministicId("evl", `mock-run-${sequence}`),
      executionId,
      verdict: "pass",
      overallScore: 0.94,
      scores: [
        {
          dimension: "grounding",
          score: 0.96,
          verdict: "pass",
          weight: 0.5,
          findings: [],
        },
        {
          dimension: "format",
          score: 0.92,
          verdict: "pass",
          weight: 0.5,
          findings: [],
        },
      ],
      rulesApplied: ["citations-present", "length-within-bounds"],
      evaluatedAt: now,
      deterministic: true,
      metadata: {},
    };
    return record({
      request,
      status: "succeeded",
      plan,
      attempts: [
        {
          stepId: "research",
          kind: "tool",
          attempt: 1,
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
          durationMs: 62,
          failure: null,
          usage: usageOf(null),
          modelId: null,
          providerId: null,
          toolId,
          metadata: {},
        },
        {
          stepId: "draft",
          kind: "model",
          attempt: 1,
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
          durationMs: 480,
          failure: null,
          usage: succeededUsage,
          modelId,
          providerId,
          toolId: null,
          metadata: {},
        },
      ],
      result: {
        status: "succeeded",
        executionId,
        // The mock says what it is. A simulated answer that read like a real one would be
        // the one thing in this file capable of misleading somebody.
        output: { simulated: true, goal, stepsCompleted: 2 },
        usage: succeededUsage,
        evaluation,
        completedAt: now,
        durationMs: 542,
        metadata: {},
      },
      governance: { policyOutcome: "allow", ceilingBreach: null },
      timeline: [],
      evaluation,
      createdAt: now,
      updatedAt: now,
      instance: { state: "completed", attempt: 1, waitingOn: null },
      run: {
        succeeded: true,
        output: { simulated: true, goal, stepsCompleted: 2 },
        usage: succeededUsage,
        failure: null,
        ceilingBreach: null,
      },
    });
  }

  /**
   * Splits the mock's own bookkeeping from the payload a caller receives.
   *
   * `instance` and `run` describe the agent run around the execution record; the platform
   * reports them together, and the mock keeps them together for the same reason.
   */
  function record(entry: {
    readonly request: JsonObject;
    readonly status: string;
    readonly plan: JsonObject | null;
    readonly attempts: readonly JsonObject[];
    readonly result: JsonObject | null;
    readonly governance: JsonObject;
    readonly timeline: readonly JsonObject[];
    readonly evaluation: JsonObject | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly instance: {
      readonly state: string;
      readonly attempt: number;
      readonly waitingOn: string | null;
    };
    readonly run: {
      readonly succeeded: boolean;
      readonly output: JsonObject | null;
      readonly usage: JsonObject;
      readonly failure: JsonObject | null;
      readonly ceilingBreach: string | null;
    };
  }): JsonObject {
    const executionRecord: JsonObject = {
      request: entry.request,
      status: entry.status,
      plan: entry.plan,
      attempts: [...entry.attempts],
      result: entry.result,
      governance: entry.governance,
      timeline: [...entry.timeline],
      evaluation: entry.evaluation,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    executions.push(executionRecord);
    const executionId = String(entry.request.id);
    return {
      run: {
        instance: {
          agentId: String(AGENT.id),
          executionId,
          state: entry.instance.state,
          descriptorVersion: String(AGENT.version),
          attempt: entry.instance.attempt,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          waitingOn: entry.instance.waitingOn,
          metadata: {},
        },
        record: executionRecord,
        status: entry.status,
        succeeded: entry.run.succeeded,
        output: entry.run.output,
        usage: entry.run.usage,
        evaluation: entry.evaluation,
        failure: entry.run.failure,
        ceilingBreach: entry.run.ceilingBreach,
      },
      agent: AGENT,
    };
  }

  /** Approves a run that is waiting, and continues it. */
  function approve(executionId: string, approved: boolean, approver: string): JsonObject {
    const { index, record: stored } = requireExecution(executionId);
    const governance = stored.governance as JsonObject;
    if (governance.policyOutcome !== "require_approval") {
      throw new ConflictError(
        "execution_not_waiting",
        `execution "${executionId}" is not waiting for an approval`,
      );
    }
    if (!approved) {
      const failure = failureOf({
        klass: "policy_blocked",
        code: "policy_violation",
        message: `an operator refused the approval: ${approver}`,
        now,
        executionId,
      });
      const refused: JsonObject = {
        ...stored,
        status: "failed",
        result: { ...(stored.result as JsonObject), failure },
        updatedAt: now,
      };
      executions[index] = refused;
      return {
        run: {
          instance: {
            agentId: String(AGENT.id),
            executionId,
            state: "failed",
            descriptorVersion: String(AGENT.version),
            attempt: 1,
            createdAt: now,
            updatedAt: now,
            waitingOn: null,
            metadata: {},
          },
          record: refused,
          status: "failed",
          succeeded: false,
          output: null,
          usage: usageOf(null),
          evaluation: null,
          failure,
          ceilingBreach: null,
        },
        agent: AGENT,
      };
    }

    // The approved continuation is a second execution of the same decision, which is what
    // the platform does: the first record stays as the record of the refusal to proceed
    // without a human, and the second is the work.
    const approvedRun = runAgent(`approved by ${approver}`, "succeeded");
    const run = approvedRun.run as JsonObject;
    const instance = run.instance as JsonObject;
    return {
      run: {
        ...run,
        instance: { ...instance, attempt: 2, parentExecutionId: executionId },
      },
      agent: AGENT,
    };
  }

  /** Cancels an execution that can still be cancelled. */
  function cancel(executionId: string, reason: string): JsonObject {
    const { index, record: stored } = requireExecution(executionId);
    if (
      stored.status === "succeeded" ||
      stored.status === "failed" ||
      stored.status === "cancelled"
    ) {
      throw new ConflictError(
        "execution_terminal",
        `execution "${executionId}" already finished with status "${String(stored.status)}"`,
      );
    }
    const failure = failureOf({
      klass: "cancelled",
      code: "execution_failed",
      message: reason,
      now,
      executionId,
    });
    const cancelled: JsonObject = {
      ...stored,
      status: "cancelled",
      result: { ...(stored.result as JsonObject), status: "cancelled", failure },
      updatedAt: now,
    };
    executions[index] = cancelled;
    return cancelled;
  }

  const runtime: MockAiCoreRuntime = {
    get executions(): readonly JsonObject[] {
      return executions;
    },
    reset(): void {
      executions.length = 0;
      sequence = 0;
    },
    async request(operation: AiCoreOperation, input: Readonly<JsonObject>): Promise<unknown> {
      switch (operation) {
        case "health":
          return {
            models: MODELS.length,
            providers: PROVIDERS.length,
            tools: TOOLS.length,
            agents: 1,
            policySets: 1,
            budgets: 1,
            ruleSets: 1,
            executions: executions.length,
            agentInstances: executions.length,
            publishFailures: 0,
            publishing: true,
            canCallModels: true,
            canInvokeTools: true,
            canRunAgents: true,
            checkedAt: now,
          };
        case "models.list":
          return { models: MODELS };
        case "providers.list":
          return { providers: PROVIDERS };
        case "agents.list":
          return { agents: [AGENT] };
        case "tools.list":
          return { tools: TOOLS };
        case "executions.list":
          return { executions };
        case "executions.get":
          return { execution: requireExecution(String(input.executionId ?? "")).record };
        case "agents.run":
          return runAgent(String(input.goal ?? ""));
        case "executions.cancel":
          return { execution: cancel(String(input.executionId ?? ""), String(input.reason ?? "")) };
        case "executions.approve":
          return approve(
            String(input.executionId ?? ""),
            input.approved === true,
            String(input.approver ?? "an operator"),
          );
        default: {
          // Unreachable while the operation type holds, and the reason it is written
          // rather than assumed: a new operation added to the union without a handler here
          // must fail loudly in development rather than resolve with nothing.
          const exhausted: never = operation;
          throw new ValidationError(`the mock AI Core does not handle "${String(exhausted)}"`);
        }
      }
    },
  };
  return runtime;
}
