/**
 * What the AI Core looks like from an operator's screen.
 *
 * These are *view models*, not the platform's domain types, and the difference is the
 * point. A screen needs a label, a tone and a formatted number; the domain contract
 * offers branded identifiers, discriminated unions and integer micro-USD. Projecting one
 * into the other in the component that renders it means every screen invents its own
 * mapping, and the third screen formats money differently from the first.
 *
 * So the projection happens once, in the client, and everything downstream of it reads
 * plain strings, numbers and booleans that cannot be misinterpreted:
 *
 * - identifiers are strings, because a screen displays them and never constructs one;
 * - statuses are strings paired with a {@link ViewTone}, because "degraded" is a colour
 *   decision that should be made once rather than per component;
 * - money is an integer *and* its label, because `null` means "not priced" and that is a
 *   different fact from zero, which a formatted string alone would hide;
 * - failures are flattened to kind, code, message and retryability, because a screen
 *   offers "retry" or "contact an operator" and nothing in between.
 *
 * Nothing here imports React. The feature is data and pure functions, so it can be
 * rendered by any surface and tested without a DOM.
 */

import type { JsonValue } from "@omnis/types";

/**
 * The outcome of a client call.
 *
 * A union rather than a thrown error: a screen that has to wrap every read in `try` will
 * eventually not, and an unhandled rejection in a component is a blank panel with no
 * explanation. Every method returns either a value or a reason there is not one.
 */
export type AiCoreResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: AiCoreViewError };

/** Why a call did not produce a value, in terms a screen can act on. */
export type AiCoreViewErrorKind =
  | "not_found"
  | "validation"
  | "policy"
  | "budget"
  | "unauthorized"
  | "timeout"
  | "provider"
  | "unavailable"
  | "unknown";

export interface AiCoreViewError {
  readonly kind: AiCoreViewErrorKind;
  /** The platform's stable error code, when the failure carried one. */
  readonly code: string | null;
  /** A message safe to render. Redaction already happened on the way out of the platform. */
  readonly message: string;
  /** True when repeating the same call unchanged may succeed. */
  readonly retryable: boolean;
}

/** The visual weight of a status. One mapping, so two screens cannot disagree. */
export type ViewTone = "positive" | "caution" | "negative" | "neutral";

/** How far the platform is from being able to do the work an operator asks of it. */
export interface HealthView {
  readonly models: number;
  readonly providers: number;
  readonly tools: number;
  readonly agents: number;
  readonly policySets: number;
  readonly budgets: number;
  readonly ruleSets: number;
  readonly executions: number;
  readonly agentInstances: number;
  /** Events the platform could not publish. Non-zero is an operator-visible problem. */
  readonly publishFailures: number;
  readonly publishing: boolean;
  readonly canCallModels: boolean;
  readonly canInvokeTools: boolean;
  readonly canRunAgents: boolean;
  /**
   * True when the platform can do its job and is not losing its own audit trail.
   *
   * Derived rather than reported: a composition that can call models but cannot publish
   * events is not healthy, and no single counter says so.
   */
  readonly ready: boolean;
  readonly checkedAt: string;
}

export interface ModelView {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly kind: string;
  readonly capabilities: readonly string[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly priority: number;
  readonly latencyClass: string;
  /** False when no pricing is known, so a cost column shows "not priced" instead of $0. */
  readonly priced: boolean;
  readonly status: string;
  readonly tone: ViewTone;
  readonly registeredAt: string;
}

export interface ProviderHealthView {
  readonly state: string;
  readonly tone: ViewTone;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly averageLatencyMs: number | null;
  readonly lastFailureClass: string | null;
  readonly observedAt: string;
}

export interface ProviderView {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly transport: string;
  readonly status: string;
  readonly tone: ViewTone;
  readonly priority: number;
  readonly latencyClass: string;
  readonly region: string | null;
  /** Whether credentials exist, never what they are. */
  readonly credentialsConfigured: boolean;
  readonly operations: readonly string[];
  readonly modelCapabilities: readonly string[];
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly maxConcurrentRequests: number;
  readonly health: ProviderHealthView | null;
  readonly registeredAt: string;
}

/** One of an agent's ceilings, as a screen shows it. */
export interface AgentConstraintView {
  /** The constraint's kind, e.g. `max_model_calls`. */
  readonly kind: string;
  /** A human label, because `max_cost_micro_usd` is not one. */
  readonly label: string;
  readonly limit: number | null;
  /** The limit as it should be read aloud; money and durations are formatted here. */
  readonly limitLabel: string;
}

export interface AgentToolBindingView {
  readonly toolId: string;
  readonly required: boolean;
  readonly maxCallsPerExecution: number;
  readonly timeoutMsOverride: number | null;
}

export interface AgentView {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: string;
  readonly status: string;
  readonly tone: ViewTone;
  readonly version: string;
  readonly capabilities: readonly string[];
  /** How the agent names its default model, e.g. `capability:chat`. */
  readonly defaultModel: string | null;
  readonly tools: readonly AgentToolBindingView[];
  readonly constraints: readonly AgentConstraintView[];
  readonly policyId: string | null;
  readonly budgetId: string | null;
  readonly updatedAt: string;
}

export interface ToolView {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly kind: string;
  readonly riskLevel: string;
  readonly tone: ViewTone;
  readonly sideEffect: string;
  readonly requiresApproval: boolean;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly supportsCancellation: boolean;
  readonly status: string;
  readonly permissions: readonly string[];
  /** The names of the tool's parameters. Their values belong to a call, not to a list. */
  readonly parameterNames: readonly string[];
  readonly registeredAt: string;
}

export interface UsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly requests: number;
  readonly costMicroUsd: number | null;
  readonly costLabel: string;
}

export interface FailureView {
  /** The failure's class: `policy_blocked`, `budget_blocked`, `provider_failure`, ... */
  readonly kind: string;
  readonly tone: ViewTone;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly stepId: string | null;
  readonly occurredAt: string;
}

export interface EvaluationScoreView {
  readonly dimension: string;
  readonly score: number;
  readonly verdict: string;
  readonly tone: ViewTone;
  readonly weight: number;
  readonly findings: number;
}

export interface EvaluationView {
  readonly id: string;
  readonly verdict: string;
  readonly tone: ViewTone;
  readonly overallScore: number;
  readonly scores: readonly EvaluationScoreView[];
  readonly rulesApplied: readonly string[];
  /** Always true in OMNIS: no model judges another model's output. */
  readonly deterministic: boolean;
  readonly evaluatedAt: string;
}

export interface ExecutionAttemptView {
  readonly stepId: string;
  readonly kind: string;
  readonly attempt: number;
  readonly status: string;
  readonly tone: ViewTone;
  readonly durationMs: number | null;
  readonly modelId: string | null;
  readonly providerId: string | null;
  readonly toolId: string | null;
  readonly failure: FailureView | null;
  readonly usage: UsageView;
}

export interface ExecutionStepView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly dependsOn: readonly string[];
  readonly optional: boolean;
  readonly maxAttempts: number;
  readonly timeoutMs: number | null;
  readonly modelId: string | null;
  readonly toolId: string | null;
  /** The status of this step's last attempt, or `pending` when it never ran. */
  readonly status: string;
  readonly tone: ViewTone;
  readonly attempt: number;
  readonly durationMs: number | null;
  readonly failure: FailureView | null;
}

export interface ExecutionView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly tone: ViewTone;
  /** What the execution was about, as one readable string. */
  readonly subject: string;
  readonly tenantId: string | null;
  readonly correlationId: string;
  readonly parentExecutionId: string | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
  /** True once the execution cannot change again. */
  readonly terminal: boolean;
  readonly durationMs: number | null;
  readonly steps: readonly ExecutionStepView[];
  readonly attempts: readonly ExecutionAttemptView[];
  readonly usage: UsageView;
  readonly output: JsonValue | null;
  readonly failure: FailureView | null;
  readonly evaluation: EvaluationView | null;
  /** A ceiling the execution crossed, in the platform's own words. */
  readonly ceilingBreach: string | null;
}

/** What an operator gets back after asking an agent to do something. */
export interface AgentRunView {
  readonly succeeded: boolean;
  readonly status: string;
  readonly tone: ViewTone;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly state: string;
  readonly attempt: number;
  readonly waitingOn: string | null;
  readonly output: JsonValue | null;
  readonly usage: UsageView;
  readonly failure: FailureView | null;
  readonly ceilingBreach: string | null;
  readonly execution: ExecutionView;
}

/** What an operator asks for when running an agent. */
export interface RunAgentInput {
  readonly slug: string;
  readonly goal: string;
}

/** An approval decision, as an operator makes it. */
export interface ApprovalInput {
  readonly approved: boolean;
  readonly approver: string;
}

// ---------------------------------------------------------------------------
// Pure view helpers
// ---------------------------------------------------------------------------

/** Statuses that mean the work is done and nothing is wrong. */
const POSITIVE: readonly string[] = [
  "succeeded",
  "completed",
  "ready",
  "healthy",
  "allow",
  "committed",
  "active",
  "pass",
  "selectable",
  "invocable",
];

/** Statuses that mean something is waiting, degraded or deliberately off. */
const CAUTION: readonly string[] = [
  "waiting",
  "paused",
  "planning",
  "degraded",
  "constrain",
  "require_approval",
  "warn",
  "held",
  "disabled",
  "initializing",
  "registered",
  "medium",
];

/** Statuses that mean the work did not happen or was refused. */
const NEGATIVE: readonly string[] = [
  "failed",
  "cancelled",
  "timed_out",
  "unavailable",
  "deny",
  "denied",
  "expired",
  "released",
  "fail",
  "skipped",
  "high",
  "critical",
  "policy_blocked",
  "budget_blocked",
  "provider_failure",
  "non_retryable",
  "deadline_exceeded",
  "validation",
];

/**
 * The tone a status should be rendered with.
 *
 * Unknown statuses are neutral rather than negative: a status this surface has not seen
 * is a new one, and painting it red would tell an operator something broke when all that
 * happened is that the platform grew.
 */
export function statusTone(status: string): ViewTone {
  const normalized = status.trim().toLowerCase();
  if (POSITIVE.includes(normalized)) {
    return "positive";
  }
  if (NEGATIVE.includes(normalized)) {
    return "negative";
  }
  if (CAUTION.includes(normalized)) {
    return "caution";
  }
  return "neutral";
}

/**
 * Money as an operator reads it.
 *
 * `null` renders as "not priced" and never as "$0.000000": a cost the platform could not
 * determine and a cost of zero are different facts, and a screen that shows them the same
 * way is a screen somebody will reconcile against a bill and lose.
 *
 * Sub-dollar amounts keep all six decimals, because that is the range where a limit lives
 * and where rounding would misreport it: a ceiling of 25_000 micro-USD is two and a half
 * cents, and "$0.03" would tell an operator they had allowed twenty percent more.
 */
export function formatMicroUsd(costMicroUsd: number | null): string {
  if (costMicroUsd === null) {
    return "not priced";
  }
  const dollars = costMicroUsd / 1_000_000;
  return `$${dollars.toFixed(Math.abs(dollars) < 1 ? 6 : 2)}`;
}

/** A token count with thousands separators, in a fixed locale so it is testable. */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/** A duration an operator can read at a glance. */
export function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1_000).toFixed(2)} s`;
}

/** The empty usage view, for an execution that consumed nothing. */
export function emptyUsageView(): UsageView {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    costMicroUsd: null,
    costLabel: formatMicroUsd(null),
  };
}
