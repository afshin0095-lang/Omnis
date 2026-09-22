/**
 * The Studio's client for the AI Core.
 *
 * The surface does not run the AI Core and never will: a browser has no provider
 * credentials, no policy engine and no ledger, and a runtime that lived in the browser
 * would be a runtime an operator's extensions could rewrite. So the Studio talks to
 * something that does run it, through a transport it does not have to know the details of.
 *
 * That gives this module two jobs, and both are real work rather than plumbing:
 *
 * 1. **Map** what the platform reports into the view models in `types.ts`, checking the
 *    shape as it goes. A backend that renames a field must produce a visible failure here
 *    rather than a column of blanks on a screen; `asString` and friends are what make the
 *    difference between "the model has no name" and "the payload had no name field".
 * 2. **Normalize** every failure into an {@link AiCoreViewError}. Nothing in this module
 *    throws, because a screen that has to guard every read with `try` eventually does not,
 *    and an unhandled rejection renders as an empty panel with no explanation.
 *
 * The transport is an injected function-shaped interface so the same client runs against
 * a real HTTP backend and against `mockRuntime.ts` in development and tests. Swapping one
 * for the other changes nothing above this file.
 */

import { isOmnisError, ValidationError } from "@omnis/errors";
import type { JsonObject, JsonValue } from "@omnis/types";
import { emptyUsageView, formatMicroUsd, statusTone } from "./types";
import type {
  AgentConstraintView,
  AgentRunView,
  AgentToolBindingView,
  AgentView,
  AiCoreResult,
  AiCoreViewError,
  AiCoreViewErrorKind,
  ApprovalInput,
  EvaluationScoreView,
  EvaluationView,
  ExecutionAttemptView,
  ExecutionStepView,
  ExecutionView,
  FailureView,
  HealthView,
  ModelView,
  ProviderHealthView,
  ProviderView,
  RunAgentInput,
  ToolView,
  UsageView,
} from "./types";

/**
 * One thing the Studio can ask the AI Core to do.
 *
 * Named as `resource.operation` rather than as a URL, so the transport decides how to
 * carry it: HTTP today, a worker message or a local composition in tests tomorrow.
 */
export type AiCoreOperation =
  | "health"
  | "models.list"
  | "providers.list"
  | "agents.list"
  | "tools.list"
  | "executions.list"
  | "executions.get"
  | "agents.run"
  | "executions.cancel"
  | "executions.approve";

/** The seam between this client and whatever runs the AI Core. */
export interface AiCoreTransport {
  /**
   * Performs one operation and resolves with the platform's own JSON.
   *
   * Rejecting is allowed and expected: this client turns a rejection into a value.
   */
  request(operation: AiCoreOperation, input: Readonly<JsonObject>): Promise<unknown>;
}

/** What the Studio can do with the AI Core. Every method resolves; none throws. */
export interface AiCoreClient {
  health(): Promise<AiCoreResult<HealthView>>;
  listModels(): Promise<AiCoreResult<readonly ModelView[]>>;
  listProviders(): Promise<AiCoreResult<readonly ProviderView[]>>;
  listAgents(): Promise<AiCoreResult<readonly AgentView[]>>;
  listTools(): Promise<AiCoreResult<readonly ToolView[]>>;
  listExecutions(): Promise<AiCoreResult<readonly ExecutionView[]>>;
  getExecution(executionId: string): Promise<AiCoreResult<ExecutionView>>;
  runAgent(input: RunAgentInput): Promise<AiCoreResult<AgentRunView>>;
  cancelExecution(executionId: string, reason: string): Promise<AiCoreResult<ExecutionView>>;
  approveExecution(executionId: string, input: ApprovalInput): Promise<AiCoreResult<AgentRunView>>;
}

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

/** Raised when a payload does not have the shape its mapper needs. */
function malformed(path: string, expected: string, found: unknown): ValidationError {
  return new ValidationError(`the AI Core payload at "${path}" is not ${expected}`, {
    issues: [
      {
        path,
        code: "invalid_type",
        message: `expected ${expected}, received ${describe(found)}`,
        // Only a primitive is echoed back. A rejected object could be a whole payload, and
        // a payload is exactly where a credential would be if one ever leaked this far.
        received:
          typeof found === "string" || typeof found === "number" || typeof found === "boolean"
            ? found
            : null,
      },
    ],
  });
}

/** A short, safe description of an unexpected value. */
function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `an array of ${value.length}`;
  }
  return typeof value;
}

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(path, "an object", value);
  }
  return value as JsonObject;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw malformed(path, "an array", value);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw malformed(path, "a string", value);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformed(path, "a finite number", value);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw malformed(path, "a boolean", value);
  }
  return value;
}

/**
 * Reads a field that may legitimately be absent or null.
 *
 * Absent and null are treated the same on purpose: over a JSON transport an optional field
 * is usually dropped rather than sent as null, and a mapper that distinguished them would
 * fail depending on how a serializer was configured.
 */
function nullable<TValue>(
  record: JsonObject,
  key: string,
  path: string,
  parse: (value: unknown, at: string) => TValue,
): TValue | null {
  const value = record[key];
  return value === null || value === undefined ? null : parse(value, `${path}.${key}`);
}

function stringOf(record: JsonObject, key: string, path: string): string {
  return asString(record[key], `${path}.${key}`);
}

/**
 * Reads a counter that may be absent, with a stated default.
 *
 * Usage fields grow as the platform learns to report more of them; a mapper that threw on
 * an absent counter would make every new field a breaking change for the surface. A money
 * or identifier field is read with {@link asNumber} instead, because guessing those is how
 * a screen comes to show a number nobody reported.
 */
function numberOr(record: JsonObject, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringListOf(record: JsonObject, key: string, path: string): readonly string[] {
  const value = record[key];
  if (value === null || value === undefined) {
    return [];
  }
  return asArray(value, `${path}.${key}`).map((entry, index) =>
    asString(entry, `${path}.${key}[${index}]`),
  );
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toHealthView(payload: unknown): HealthView {
  const record = asObject(payload, "health");
  const canCallModels = asBoolean(record.canCallModels, "health.canCallModels");
  const canRunAgents = asBoolean(record.canRunAgents, "health.canRunAgents");
  const publishFailures = asNumber(record.publishFailures, "health.publishFailures");
  return {
    models: asNumber(record.models, "health.models"),
    providers: asNumber(record.providers, "health.providers"),
    tools: asNumber(record.tools, "health.tools"),
    agents: asNumber(record.agents, "health.agents"),
    policySets: asNumber(record.policySets, "health.policySets"),
    budgets: asNumber(record.budgets, "health.budgets"),
    ruleSets: asNumber(record.ruleSets, "health.ruleSets"),
    executions: asNumber(record.executions, "health.executions"),
    agentInstances: asNumber(record.agentInstances, "health.agentInstances"),
    publishFailures,
    publishing: asBoolean(record.publishing, "health.publishing"),
    canCallModels,
    canInvokeTools: asBoolean(record.canInvokeTools, "health.canInvokeTools"),
    canRunAgents,
    ready: canCallModels && canRunAgents && publishFailures === 0,
    checkedAt: stringOf(record, "checkedAt", "health"),
  };
}

function toModelView(payload: unknown, path: string): ModelView {
  const record = asObject(payload, path);
  const status = stringOf(record, "status", path);
  return {
    id: stringOf(record, "id", path),
    slug: stringOf(record, "slug", path),
    displayName: stringOf(record, "displayName", path),
    providerId: stringOf(record, "providerId", path),
    kind: stringOf(record, "kind", path),
    capabilities: stringListOf(record, "capabilities", path),
    contextWindowTokens: asNumber(record.contextWindowTokens, `${path}.contextWindowTokens`),
    maxOutputTokens: asNumber(record.maxOutputTokens, `${path}.maxOutputTokens`),
    priority: asNumber(record.priority, `${path}.priority`),
    latencyClass: stringOf(record, "latencyClass", path),
    priced: record.pricing !== null && record.pricing !== undefined,
    status,
    tone: statusTone(status),
    registeredAt: stringOf(record, "registeredAt", path),
  };
}

function toProviderHealthView(payload: unknown, path: string): ProviderHealthView | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  const record = asObject(payload, path);
  const state = stringOf(record, "state", path);
  return {
    state,
    tone: statusTone(state),
    consecutiveFailures: asNumber(record.consecutiveFailures, `${path}.consecutiveFailures`),
    consecutiveSuccesses: asNumber(record.consecutiveSuccesses, `${path}.consecutiveSuccesses`),
    averageLatencyMs: nullable(record, "averageLatencyMs", path, asNumber),
    lastFailureClass: nullable(record, "lastFailureClass", path, asString),
    observedAt: stringOf(record, "observedAt", path),
  };
}

function toProviderView(payload: unknown, path: string): ProviderView {
  const record = asObject(payload, path);
  const capabilities = asObject(record.capabilities, `${path}.capabilities`);
  const rateLimit = asObject(record.rateLimit, `${path}.rateLimit`);
  const status = stringOf(record, "status", path);
  return {
    id: stringOf(record, "id", path),
    slug: stringOf(record, "slug", path),
    displayName: stringOf(record, "displayName", path),
    transport: stringOf(record, "transport", path),
    status,
    tone: statusTone(status),
    priority: asNumber(record.priority, `${path}.priority`),
    latencyClass: stringOf(record, "latencyClass", path),
    region: nullable(record, "region", path, asString),
    credentialsConfigured: asBoolean(record.credentialsConfigured, `${path}.credentialsConfigured`),
    operations: stringListOf(capabilities, "operations", `${path}.capabilities`),
    modelCapabilities: stringListOf(capabilities, "modelCapabilities", `${path}.capabilities`),
    requestsPerMinute: asNumber(rateLimit.requestsPerMinute, `${path}.rateLimit.requestsPerMinute`),
    tokensPerMinute: asNumber(rateLimit.tokensPerMinute, `${path}.rateLimit.tokensPerMinute`),
    maxConcurrentRequests: asNumber(
      rateLimit.maxConcurrentRequests,
      `${path}.rateLimit.maxConcurrentRequests`,
    ),
    health: toProviderHealthView(record.health, `${path}.health`),
    registeredAt: stringOf(record, "registeredAt", path),
  };
}

/**
 * The ceilings an agent descriptor can carry, as rows a screen can show.
 *
 * Two names per ceiling, because there are two vocabularies and neither is wrong: the
 * descriptor spells its fields in camelCase (`maxCostMicroUsd`), while the policy engine
 * the descriptor is compiled into names the same ceiling in snake_case
 * (`max_cost_micro_usd`). A screen that showed only one of them would not be grep-able
 * against the policy record an auditor reads, and a screen that showed the other would not
 * match the descriptor an operator edits.
 */
const CONSTRAINT_FIELDS: readonly {
  readonly field: string;
  readonly kind: string;
  readonly label: string;
}[] = [
  { field: "maxSteps", kind: "max_steps", label: "Steps per run" },
  { field: "maxModelCalls", kind: "max_model_calls", label: "Model calls per run" },
  { field: "maxToolCalls", kind: "max_tool_calls", label: "Tool calls per run" },
  { field: "maxDurationMs", kind: "max_duration_ms", label: "Run time limit" },
  { field: "maxCostMicroUsd", kind: "max_cost_micro_usd", label: "Spend limit" },
  { field: "maxRetriesPerStep", kind: "max_retries_per_step", label: "Retries per step" },
];

function toConstraintViews(constraints: JsonObject, path: string): readonly AgentConstraintView[] {
  const views: AgentConstraintView[] = [];
  for (const { field, kind, label } of CONSTRAINT_FIELDS) {
    const limit = nullable(constraints, field, path, asNumber);
    if (limit === null) {
      // An unlimited ceiling is not a row: showing "no limit" six times buries the two
      // ceilings an operator actually set.
      continue;
    }
    views.push({
      kind,
      label,
      limit,
      limitLabel:
        kind === "max_cost_micro_usd"
          ? formatMicroUsd(limit)
          : kind.endsWith("_ms")
            ? `${limit} ms`
            : String(limit),
    });
  }
  return views;
}

/** A model reference as an operator reads it: `capability:chat`, `slug:gpt-class`, `id:...`. */
function toReferenceLabel(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asObject(value, path);
  const kind = stringOf(record, "kind", path);
  return `${kind}:${stringOf(record, "value", path)}`;
}

function toAgentView(payload: unknown, path: string): AgentView {
  const record = asObject(payload, path);
  const constraints = asObject(record.constraints, `${path}.constraints`);
  const status = stringOf(record, "status", path);
  const tools = asArray(record.tools, `${path}.tools`).map((entry, index): AgentToolBindingView => {
    const binding = asObject(entry, `${path}.tools[${index}]`);
    return {
      toolId: stringOf(binding, "toolId", `${path}.tools[${index}]`),
      required: asBoolean(binding.required, `${path}.tools[${index}].required`),
      maxCallsPerExecution: numberOr(binding, "maxCallsPerExecution", 1),
      timeoutMsOverride: nullable(
        binding,
        "timeoutMsOverride",
        `${path}.tools[${index}]`,
        asNumber,
      ),
    };
  });
  return {
    id: stringOf(record, "id", path),
    slug: stringOf(record, "slug", path),
    displayName: stringOf(record, "displayName", path),
    description: stringOf(record, "description", path),
    kind: stringOf(record, "kind", path),
    status,
    tone: statusTone(status),
    version: stringOf(record, "version", path),
    capabilities: stringListOf(record, "capabilities", path),
    defaultModel: toReferenceLabel(record.defaultModel, `${path}.defaultModel`),
    tools,
    constraints: toConstraintViews(constraints, `${path}.constraints`),
    policyId: nullable(record, "policyId", path, asString),
    budgetId: nullable(record, "budgetId", path, asString),
    updatedAt: stringOf(record, "updatedAt", path),
  };
}

function toToolView(payload: unknown, path: string): ToolView {
  const record = asObject(payload, path);
  const riskLevel = stringOf(record, "riskLevel", path);
  const parameters = asObject(record.parameters, `${path}.parameters`);
  const properties = parameters.properties;
  return {
    id: stringOf(record, "id", path),
    name: stringOf(record, "name", path),
    displayName: stringOf(record, "displayName", path),
    description: stringOf(record, "description", path),
    version: stringOf(record, "version", path),
    kind: stringOf(record, "kind", path),
    riskLevel,
    // Risk is a tone rather than a colour choice per screen: a critical tool is red
    // everywhere or it is red nowhere.
    tone: statusTone(riskLevel),
    sideEffect: stringOf(record, "sideEffect", path),
    requiresApproval: asBoolean(record.requiresApproval, `${path}.requiresApproval`),
    timeoutMs: asNumber(record.timeoutMs, `${path}.timeoutMs`),
    maxConcurrency: asNumber(record.maxConcurrency, `${path}.maxConcurrency`),
    supportsCancellation: asBoolean(record.supportsCancellation, `${path}.supportsCancellation`),
    status: stringOf(record, "status", path),
    permissions: stringListOf(record, "permissions", path),
    parameterNames:
      properties === null || properties === undefined
        ? []
        : Object.keys(asObject(properties, `${path}.parameters.properties`)),
    registeredAt: stringOf(record, "registeredAt", path),
  };
}

function toUsageView(payload: unknown, path: string): UsageView {
  if (payload === null || payload === undefined) {
    return emptyUsageView();
  }
  const record = asObject(payload, path);
  const costMicroUsd = nullable(record, "costMicro", path, asNumber);
  return {
    inputTokens: numberOr(record, "inputTokens", 0),
    outputTokens: numberOr(record, "outputTokens", 0),
    totalTokens: numberOr(record, "totalTokens", 0),
    cachedInputTokens: numberOr(record, "cachedInputTokens", 0),
    reasoningTokens: numberOr(record, "reasoningTokens", 0),
    requests: numberOr(record, "requests", 0),
    costMicroUsd,
    costLabel: formatMicroUsd(costMicroUsd),
  };
}

function toFailureView(payload: unknown, path: string): FailureView | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  const record = asObject(payload, path);
  const kind = stringOf(record, "class", path);
  return {
    kind,
    tone: statusTone(kind),
    code: stringOf(record, "code", path),
    message: stringOf(record, "message", path),
    retryable: asBoolean(record.retryable, `${path}.retryable`),
    stepId: nullable(record, "stepId", path, asString),
    occurredAt: stringOf(record, "occurredAt", path),
  };
}

function toEvaluationView(payload: unknown, path: string): EvaluationView | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  const record = asObject(payload, path);
  const verdict = stringOf(record, "verdict", path);
  const scores = asArray(record.scores, `${path}.scores`).map(
    (entry, index): EvaluationScoreView => {
      const score = asObject(entry, `${path}.scores[${index}]`);
      const scoreVerdict = stringOf(score, "verdict", `${path}.scores[${index}]`);
      const findings = asArray(score.findings ?? [], `${path}.scores[${index}].findings`);
      return {
        dimension: stringOf(score, "dimension", `${path}.scores[${index}]`),
        score: asNumber(score.score, `${path}.scores[${index}].score`),
        verdict: scoreVerdict,
        tone: statusTone(scoreVerdict),
        weight: numberOr(score, "weight", 1),
        findings: findings.length,
      };
    },
  );
  return {
    id: stringOf(record, "id", path),
    verdict,
    tone: statusTone(verdict),
    overallScore: asNumber(record.overallScore, `${path}.overallScore`),
    scores,
    rulesApplied: stringListOf(record, "rulesApplied", path),
    deterministic: asBoolean(record.deterministic, `${path}.deterministic`),
    evaluatedAt: stringOf(record, "evaluatedAt", path),
  };
}

function toAttemptView(payload: unknown, path: string): ExecutionAttemptView {
  const record = asObject(payload, path);
  const status = stringOf(record, "status", path);
  return {
    stepId: stringOf(record, "stepId", path),
    kind: stringOf(record, "kind", path),
    attempt: asNumber(record.attempt, `${path}.attempt`),
    status,
    tone: statusTone(status),
    durationMs: nullable(record, "durationMs", path, asNumber),
    modelId: nullable(record, "modelId", path, asString),
    providerId: nullable(record, "providerId", path, asString),
    toolId: nullable(record, "toolId", path, asString),
    failure: toFailureView(record.failure, `${path}.failure`),
    usage: toUsageView(record.usage, `${path}.usage`),
  };
}

/** The last attempt recorded for one step, which is the one that decides its status. */
function lastAttemptFor(
  attempts: readonly ExecutionAttemptView[],
  stepId: string,
): ExecutionAttemptView | null {
  let last: ExecutionAttemptView | null = null;
  for (const attempt of attempts) {
    if (attempt.stepId === stepId && (last === null || attempt.attempt >= last.attempt)) {
      last = attempt;
    }
  }
  return last;
}

function toStepViews(
  plan: JsonObject | null,
  attempts: readonly ExecutionAttemptView[],
  path: string,
): readonly ExecutionStepView[] {
  if (plan === null) {
    return [];
  }
  return asArray(plan.steps, `${path}.steps`).map((entry, index) => {
    const step = asObject(entry, `${path}.steps[${index}]`);
    const stepId = stringOf(step, "id", `${path}.steps[${index}]`);
    const last = lastAttemptFor(attempts, stepId);
    // A step with no attempt never ran: "pending" says so, where a blank cell would leave
    // an operator guessing whether it was skipped, lost or still to come.
    const status = last === null ? "pending" : last.status;
    return {
      id: stepId,
      name: stringOf(step, "name", `${path}.steps[${index}]`),
      kind: stringOf(step, "kind", `${path}.steps[${index}]`),
      dependsOn: stringListOf(step, "dependsOn", `${path}.steps[${index}]`),
      optional: asBoolean(step.optional, `${path}.steps[${index}].optional`),
      maxAttempts: numberOr(step, "maxAttempts", 1),
      timeoutMs: nullable(step, "timeoutMs", `${path}.steps[${index}]`, asNumber),
      modelId: nullable(step, "modelId", `${path}.steps[${index}]`, asString),
      toolId: nullable(step, "toolId", `${path}.steps[${index}]`, asString),
      status,
      tone: statusTone(status),
      attempt: last?.attempt ?? 0,
      durationMs: last?.durationMs ?? null,
      failure: last?.failure ?? null,
    };
  });
}

/** One readable line saying what an execution was about. */
function toSubject(request: JsonObject, path: string): string {
  const kind = stringOf(request, "kind", path);
  const agentId = nullable(request, "agentId", path, asString);
  if (agentId !== null) {
    return `${kind} · agent ${agentId}`;
  }
  const model = nullable(request, "model", path, (value, at) => toReferenceLabel(value, at));
  if (model !== null) {
    return `${kind} · model ${model}`;
  }
  const tool = nullable(request, "tool", path, (value, at) => toReferenceLabel(value, at));
  if (tool !== null) {
    return `${kind} · tool ${tool}`;
  }
  return kind;
}

/** Statuses after which an execution cannot change again. */
const TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled", "timed_out"];

function toExecutionView(payload: unknown, path: string): ExecutionView {
  const record = asObject(payload, path);
  const request = asObject(record.request, `${path}.request`);
  const status = stringOf(record, "status", path);
  const attempts = asArray(record.attempts, `${path}.attempts`).map((entry, index) =>
    toAttemptView(entry, `${path}.attempts[${index}]`),
  );
  const result =
    record.result === null || record.result === undefined
      ? null
      : asObject(record.result, `${path}.result`);
  const durationMs =
    result === null ? null : nullable(result, "durationMs", `${path}.result`, asNumber);
  const governance = asObject(record.governance ?? {}, `${path}.governance`);
  return {
    id: stringOf(request, "id", `${path}.request`),
    kind: stringOf(request, "kind", `${path}.request`),
    status,
    tone: statusTone(status),
    subject: toSubject(request, `${path}.request`),
    tenantId: nullable(request, "tenantId", `${path}.request`, asString),
    correlationId: stringOf(request, "correlationId", `${path}.request`),
    parentExecutionId: nullable(request, "parentExecutionId", `${path}.request`, asString),
    requestedAt: stringOf(request, "requestedAt", `${path}.request`),
    updatedAt: stringOf(record, "updatedAt", path),
    terminal: TERMINAL_STATUSES.includes(status),
    durationMs,
    steps: toStepViews(
      record.plan === null || record.plan === undefined
        ? null
        : asObject(record.plan, `${path}.plan`),
      attempts,
      `${path}.plan`,
    ),
    attempts,
    usage: toUsageView(result?.usage ?? null, `${path}.result.usage`),
    output: (result?.output ?? null) as JsonValue | null,
    failure: toFailureView(result?.failure ?? null, `${path}.result.failure`),
    evaluation: toEvaluationView(record.evaluation, `${path}.evaluation`),
    // The ceiling breach is the platform's own sentence about its own limit; rewording it
    // here would make the screen disagree with the record an auditor reads.
    ceilingBreach: nullable(governance, "ceilingBreach", `${path}.governance`, asString),
  };
}

/**
 * Maps a run response.
 *
 * The response carries the run *and* the agent it ran, because a screen shows the agent's
 * slug next to the outcome and the run result itself only carries an identifier. That is
 * the backend's response shape rather than a domain type: an API is allowed to answer with
 * what its caller needs in one round trip.
 */
function toRunView(payload: unknown): AgentRunView {
  const response = asObject(payload, "agents.run");
  const record = asObject(response.run, "agents.run.run");
  const instance = asObject(record.instance, "agents.run.run.instance");
  const descriptor = asObject(response.agent, "agents.run.agent");
  const status = stringOf(record, "status", "agents.run.run");
  const state = stringOf(instance, "state", "agents.run.run.instance");
  return {
    succeeded: asBoolean(record.succeeded, "agents.run.run.succeeded"),
    status,
    tone: statusTone(status),
    agentId: stringOf(instance, "agentId", "agents.run.run.instance"),
    agentSlug: stringOf(descriptor, "slug", "agents.run.agent"),
    state,
    attempt: asNumber(instance.attempt, "agents.run.run.instance.attempt"),
    waitingOn: nullable(instance, "waitingOn", "agents.run.run.instance", asString),
    output: (record.output ?? null) as JsonValue | null,
    usage: toUsageView(record.usage, "agents.run.run.usage"),
    failure: toFailureView(record.failure, "agents.run.run.failure"),
    ceilingBreach: nullable(record, "ceilingBreach", "agents.run.run", asString),
    execution: toExecutionView(record.record, "agents.run.run.record"),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The platform's error codes, grouped by what a screen should do about them. */
const ERROR_KINDS: Readonly<Record<string, AiCoreViewErrorKind>> = {
  not_found: "not_found",
  validation_failed: "validation",
  configuration_invalid: "validation",
  contract_violation: "validation",
  conflict: "validation",
  policy_violation: "policy",
  authorization_failed: "unauthorized",
  authentication_failed: "unauthorized",
  timeout: "timeout",
  provider_failure: "provider",
  infrastructure_failure: "unavailable",
  execution_failed: "unavailable",
  not_implemented: "unavailable",
};

/**
 * Whatever went wrong, as a value a screen can render.
 *
 * An {@link isOmnisError} check first, because the platform's own errors carry a code and
 * a retryability that a screen can act on; anything else is reported as unknown rather
 * than guessed at, and its text is included because "something went wrong" is not a
 * message an operator can do anything with.
 */
export function viewErrorOf(error: unknown): AiCoreViewError {
  if (isOmnisError(error)) {
    return {
      kind: ERROR_KINDS[error.code] ?? "unknown",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error) {
    return { kind: "unknown", code: null, message: error.message, retryable: false };
  }
  return { kind: "unknown", code: null, message: String(error), retryable: false };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * Builds the Studio's AI Core client over a transport.
 *
 * Every method performs one operation, maps the payload and catches everything: a
 * rejection becomes an error value, and a payload that does not have the shape its mapper
 * expects becomes a `validation` error naming the field. A screen therefore never sees an
 * exception from this module, and a backend that changes its contract fails loudly in the
 * error text rather than quietly as empty columns.
 */
export function createAiCoreClient(transport: AiCoreTransport): AiCoreClient {
  async function call<TValue>(
    operation: AiCoreOperation,
    input: Readonly<JsonObject>,
    map: (payload: unknown) => TValue,
  ): Promise<AiCoreResult<TValue>> {
    try {
      return { ok: true, value: map(await transport.request(operation, input)) };
    } catch (error: unknown) {
      return { ok: false, error: viewErrorOf(error) };
    }
  }

  function list(key: string, map: (payload: unknown, path: string) => unknown) {
    return (payload: unknown): readonly unknown[] => {
      const record = asObject(payload, key);
      return asArray(record[key], key).map((entry, index) => map(entry, `${key}[${index}]`));
    };
  }

  return {
    health: () => call("health", {}, toHealthView),
    listModels: () =>
      call("models.list", {}, list("models", toModelView)) as Promise<
        AiCoreResult<readonly ModelView[]>
      >,
    listProviders: () =>
      call("providers.list", {}, list("providers", toProviderView)) as Promise<
        AiCoreResult<readonly ProviderView[]>
      >,
    listAgents: () =>
      call("agents.list", {}, list("agents", toAgentView)) as Promise<
        AiCoreResult<readonly AgentView[]>
      >,
    listTools: () =>
      call("tools.list", {}, list("tools", toToolView)) as Promise<
        AiCoreResult<readonly ToolView[]>
      >,
    listExecutions: () =>
      call("executions.list", {}, list("executions", toExecutionView)) as Promise<
        AiCoreResult<readonly ExecutionView[]>
      >,
    getExecution: (executionId) =>
      call("executions.get", { executionId }, (payload) => toExecutionView(payload, "execution")),
    runAgent: (input) => call("agents.run", { slug: input.slug, goal: input.goal }, toRunView),
    cancelExecution: (executionId, reason) =>
      call("executions.cancel", { executionId, reason }, (payload) =>
        toExecutionView(payload, "execution"),
      ),
    approveExecution: (executionId, input) =>
      call(
        "executions.approve",
        { executionId, approved: input.approved, approver: input.approver },
        toRunView,
      ),
  };
}
