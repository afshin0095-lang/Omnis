/**
 * Execution contracts: status, mode, priority, requests and plans.
 *
 * An execution is the unit of accountability in OMNIS. Everything observable —
 * policy decisions, budget holds, model calls, tool calls, evaluations, events — is
 * attached to one, which is why the request carries the full identity triple and why
 * the status vocabulary is a closed union rather than a string.
 *
 * The plan lives here rather than in the kernel because a plan is *data*: the kernel
 * executes it, the orchestrator can propose one, an audit row stores it, and a test
 * can assert its shape without importing the kernel.
 */

import type { JsonObject } from "@omnis/types";
import { MAX_PLAN_STEPS, MAX_STEP_DEPENDENCIES, type AiCoreMetadata } from "./constants.js";
import { invalidPlanError } from "./failures.js";
import type {
  AgentId,
  BudgetId,
  CausationId,
  CorrelationId,
  ExecutionId,
  ModelId,
  PlanId,
  PolicyId,
  ProviderId,
  TenantId,
  ToolId,
  TraceId,
} from "./identifiers.js";
import type { ModelReference } from "./model.js";
import type { ToolReference } from "./tool.js";

/**
 * Execution lifecycle states.
 *
 * Ordered by the pipeline they describe: an execution is created, then validated,
 * then authorized by policy, then reserved against a budget, then planned, then run.
 * The governance states come *before* `running` on purpose — see
 * `isPreExecutionStatus`. Reaching `running` is proof that policy and budget already
 * said yes, and every consumer may rely on that.
 */
export const EXECUTION_STATUSES = [
  "created",
  "validated",
  "authorized",
  "reserved",
  "planned",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

/** One execution lifecycle state. */
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** States from which no further transition is possible. */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

/** States that must be reached before any privileged work happens. */
export const PRE_EXECUTION_STATUSES: readonly ExecutionStatus[] = Object.freeze([
  "created",
  "validated",
  "authorized",
  "reserved",
  "planned",
]);

/** True when the execution can no longer change state. */
export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status);
}

/** True when the execution has not yet begun privileged work. */
export function isPreExecutionStatus(status: ExecutionStatus): boolean {
  return (PRE_EXECUTION_STATUSES as readonly string[]).includes(status);
}

/** True when the execution succeeded, i.e. produced a usable result. */
export function isSuccessExecutionStatus(status: ExecutionStatus): boolean {
  return status === "succeeded";
}

/** How the caller intends to consume the execution. */
export const EXECUTION_MODES = ["interactive", "streaming", "batch", "background"] as const;

/** An execution mode. */
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** True when the mode requires incremental output. */
export function isStreamingMode(mode: ExecutionMode): boolean {
  return mode === "streaming" || mode === "interactive";
}

/** Scheduling preference. Never a security property: priority cannot outrank policy. */
export const EXECUTION_PRIORITIES = ["low", "normal", "high", "critical"] as const;

/** An execution priority. */
export type ExecutionPriority = (typeof EXECUTION_PRIORITIES)[number];

/** Numeric rank of a priority. Higher is more urgent. */
export const EXECUTION_PRIORITY_RANK: Readonly<Record<ExecutionPriority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

/** What kind of work an execution performs. */
export const EXECUTION_KINDS = ["agent", "model", "tool", "evaluation", "composite"] as const;

/** An execution kind. */
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** Governance and timing facts recorded alongside an execution. */
export interface ExecutionMetadata {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  /** Absolute deadline as an ISO timestamp, or `null` when the execution is unbounded. */
  readonly deadlineAt: string | null;
  /** Attempts consumed across all steps. */
  readonly attemptCount: number;
  /** Outcome of the policy evaluation that authorized (or refused) the execution. */
  readonly policyOutcome: string | null;
  /** Identifier of the policy set that was evaluated, when one was. */
  readonly policyId: PolicyId | null;
  /** State of the budget reservation at the time of recording. */
  readonly budgetStatus: string | null;
  readonly budgetId: BudgetId | null;
  /** Free-form, JSON-safe tags. Never credentials, never free text from a model. */
  readonly tags: AiCoreMetadata;
}

/** An {@link ExecutionMetadata} for an execution that has only just been created. */
export function initialExecutionMetadata(deadlineAt: string | null = null): ExecutionMetadata {
  return Object.freeze({
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    deadlineAt,
    attemptCount: 0,
    policyOutcome: null,
    policyId: null,
    budgetStatus: null,
    budgetId: null,
    tags: Object.freeze({}),
  });
}

/** A request to perform one unit of AI work. */
export interface ExecutionRequest {
  readonly id: ExecutionId;
  readonly kind: ExecutionKind;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
  readonly traceId: TraceId | null;
  readonly tenantId: TenantId | null;
  readonly parentExecutionId: ExecutionId | null;
  /** The agent to run, when the kind is `agent`. */
  readonly agentId: AgentId | null;
  /** The model to invoke, when the kind is `model`. */
  readonly model: ModelReference | null;
  /** The tool to invoke, when the kind is `tool`. */
  readonly tool: ToolReference | null;
  /** JSON-safe input payload. */
  readonly input: Readonly<JsonObject>;
  readonly mode: ExecutionMode;
  readonly priority: ExecutionPriority;
  /** Policy set to evaluate, or `null` for the runtime default. */
  readonly policyId: PolicyId | string | null;
  /** Budget to charge, or `null` for the runtime default. */
  readonly budgetId: BudgetId | null;
  /** Relative deadline in milliseconds, or `null` for the runtime default. */
  readonly deadlineMs: number | null;
  readonly metadata: AiCoreMetadata;
  readonly requestedAt: string;
}

/** One step of an execution plan. */
export interface ExecutionStep {
  /** Unique within the plan. Referenced by `dependsOn` and by audit records. */
  readonly id: string;
  readonly name: string;
  readonly kind: ExecutionKind;
  /** Steps that must have succeeded first. Empty means the step is a root. */
  readonly dependsOn: readonly string[];
  /** Step-level timeout; `null` inherits the execution deadline. */
  readonly timeoutMs: number | null;
  /** Attempts allowed for this step, including the first. Bounded by `MAX_RETRY_ATTEMPTS`. */
  readonly maxAttempts: number;
  /**
   * Whether the plan may continue when this step fails.
   *
   * Optional steps exist for enrichment (an evaluation, a secondary retrieval). A
   * non-optional step failing fails the execution — silently continuing past a
   * required step is how a system reports success for work it did not do.
   */
  readonly optional: boolean;
  readonly input: Readonly<JsonObject>;
  readonly modelId: ModelId | null;
  readonly providerId: ProviderId | null;
  readonly toolId: ToolId | null;
  readonly metadata: AiCoreMetadata;
}

/** An immutable execution plan. */
export interface ExecutionPlan {
  readonly id: PlanId;
  readonly executionId: ExecutionId;
  readonly steps: readonly ExecutionStep[];
  readonly createdAt: string;
}

/** A structural problem found in a plan. */
export interface PlanIssue {
  readonly code:
    | "duplicate_step_id"
    | "empty_step_id"
    | "unknown_dependency"
    | "self_dependency"
    | "cycle"
    | "too_many_steps"
    | "too_many_dependencies";
  readonly message: string;
  readonly stepId: string | null;
}

/**
 * Validates a plan structurally: identifiers, dependency references, fan-in limits and
 * acyclicity.
 *
 * Returns every issue rather than throwing on the first, because a plan is usually
 * built by a planner that needs to report all of its mistakes at once.
 */
export function validateExecutionPlan(plan: ExecutionPlan): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];

  if (plan.steps.length > MAX_PLAN_STEPS) {
    issues.push({
      code: "too_many_steps",
      message: `plan declares ${plan.steps.length} steps, the maximum is ${MAX_PLAN_STEPS}`,
      stepId: null,
    });
  }

  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (step.id.length === 0) {
      issues.push({
        code: "empty_step_id",
        message: "step identifier must not be empty",
        stepId: null,
      });
      continue;
    }
    if (seen.has(step.id)) {
      issues.push({
        code: "duplicate_step_id",
        message: `duplicate step identifier "${step.id}"`,
        stepId: step.id,
      });
    }
    seen.add(step.id);

    if (step.dependsOn.length > MAX_STEP_DEPENDENCIES) {
      issues.push({
        code: "too_many_dependencies",
        message: `step "${step.id}" declares ${step.dependsOn.length} dependencies, the maximum is ${MAX_STEP_DEPENDENCIES}`,
        stepId: step.id,
      });
    }
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) {
        issues.push({
          code: "self_dependency",
          message: `step "${step.id}" depends on itself`,
          stepId: step.id,
        });
      } else if (!seen.has(dependency) && !plan.steps.some((other) => other.id === dependency)) {
        issues.push({
          code: "unknown_dependency",
          message: `step "${step.id}" depends on unknown step "${dependency}"`,
          stepId: step.id,
        });
      }
    }
  }

  // Cycle detection runs on the whole graph, because a cycle can be formed by steps
  // that are individually well-formed.
  const cycle = findPlanCycle(plan.steps);
  if (cycle !== null) {
    issues.push({
      code: "cycle",
      message: `plan contains a dependency cycle: ${cycle.join(" -> ")}`,
      stepId: null,
    });
  }

  return Object.freeze(issues);
}

/** The identifiers forming one dependency cycle, or `null` when the graph is acyclic. */
export function findPlanCycle(steps: readonly ExecutionStep[]): readonly string[] | null {
  const state = new Map<string, "visiting" | "visited">();
  const byId = new Map<string, ExecutionStep>();
  for (const step of steps) {
    byId.set(step.id, step);
  }

  const walk = (stepId: string, trail: readonly string[]): readonly string[] | null => {
    const marker = state.get(stepId);
    if (marker === "visited") {
      return null;
    }
    if (marker === "visiting") {
      const start = trail.indexOf(stepId);
      return [...trail.slice(start >= 0 ? start : 0), stepId];
    }
    state.set(stepId, "visiting");
    const step = byId.get(stepId);
    if (step !== undefined) {
      for (const dependency of step.dependsOn) {
        const found = walk(dependency, [...trail, stepId]);
        if (found !== null) {
          return found;
        }
      }
    }
    state.set(stepId, "visited");
    return null;
  };

  for (const step of steps) {
    const found = walk(step.id, []);
    if (found !== null) {
      return Object.freeze(found);
    }
  }
  return null;
}

/**
 * Orders plan steps for sequential execution.
 *
 * Kahn's algorithm with a lexicographically-sorted ready set: dependencies are
 * respected, and among steps that *could* run next the alphabetically-first one runs.
 * That tie-break is the reason two runs of the same plan produce the same order —
 * without it, ordering would follow insertion order of a map, which is an
 * implementation detail nobody intended to depend on.
 *
 * Throws {@link invalidPlanError} when the plan is not structurally valid, because
 * ordering an invalid plan would silently drop or duplicate steps.
 */
export function topologicalStepOrder(plan: ExecutionPlan): readonly ExecutionStep[] {
  const issues = validateExecutionPlan(plan);
  if (issues.length > 0) {
    throw invalidPlanError(issues[0]?.message ?? "plan is invalid", {
      issueCount: issues.length,
      codes: issues.map((issue) => issue.code),
    });
  }

  const remaining = new Map<string, number>();
  const byId = new Map<string, ExecutionStep>();
  const dependents = new Map<string, string[]>();

  for (const step of plan.steps) {
    byId.set(step.id, step);
    remaining.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      const list = dependents.get(dependency);
      if (list === undefined) {
        dependents.set(dependency, [step.id]);
      } else {
        list.push(step.id);
      }
    }
  }

  const ready: string[] = [];
  for (const [stepId, count] of remaining) {
    if (count === 0) {
      ready.push(stepId);
    }
  }
  ready.sort();

  const ordered: ExecutionStep[] = [];
  while (ready.length > 0) {
    const stepId = ready.shift();
    if (stepId === undefined) {
      break;
    }
    const step = byId.get(stepId);
    if (step !== undefined) {
      ordered.push(step);
    }
    for (const dependent of dependents.get(stepId) ?? []) {
      const count = (remaining.get(dependent) ?? 1) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  return Object.freeze(ordered);
}

/** The step identifiers of a plan, in declared order. */
export function planStepIds(plan: ExecutionPlan): readonly string[] {
  return Object.freeze(plan.steps.map((step) => step.id));
}

/**
 * An approval recorded for work a policy said needs a human.
 *
 * Defined here rather than in the kernel because an approval is not a kernel concept: the
 * model orchestrator and the tool runtime each gate on one too, and an execution that was
 * approved has to be able to hand that approval to the calls it authorizes. Without a shared
 * shape, an approved execution would fail at its first gated call — the approval would exist,
 * and nothing downstream could see it.
 */
export interface ExecutionApproval {
  /** Whether the approval was granted. A refusal is `{ approved: false }`, never an absent approval. */
  readonly approved: boolean;
  /** Who approved, e.g. `"operator"` or a role name. `null` when the caller did not record one. */
  readonly approver: string | null;
  readonly approvedAt: string | null;
}

/** True when an approval is one a gate can accept. */
export function isGrantedApproval(
  approval: ExecutionApproval | null | undefined,
): approval is ExecutionApproval {
  return approval !== null && approval !== undefined && approval.approved === true;
}
