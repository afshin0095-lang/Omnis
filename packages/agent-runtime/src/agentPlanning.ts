/**
 * Turning "run this agent" into a plan the kernel can execute.
 *
 * The agent runtime never calls a model or a tool. It produces a plan — a list of
 * steps with kinds, dependencies, timeouts and attempt ceilings — and hands it to
 * the execution kernel, which runs the steps through the executors registered for
 * those kinds. That separation is what keeps this package free of provider and
 * tool imports: a planner that also invoked would have to know how to invoke, and
 * then every agent would carry a second, untested execution path.
 *
 * WHERE A PLAN COMES FROM
 * -----------------------
 * Sprint 1 has no model that writes plans. A plan is therefore either supplied by
 * the caller, step by step, or derived from the descriptor: one `model` step
 * against the agent's preferred model. Deriving a multi-step plan from a goal
 * string is planning, and planning is a later sprint; pretending otherwise here
 * would mean hard-coding a pipeline and calling it an agent.
 *
 * WHAT THE PLANNER ENFORCES
 * -------------------------
 * The descriptor's ceilings are applied to the plan before the kernel sees it:
 * `maxSteps` bounds the plan's length, `maxRetriesPerStep` bounds each step's
 * attempts, and `allowedTools`/`deniedTools` refuse a step that names a tool the
 * agent may not call. Policy will gate the same things at run time — the planner
 * refusing early is not a second authority, it is the same ceiling applied where
 * the mistake is cheapest to report.
 */

import { executionPlan, MAX_PLAN_STEPS } from "@omnis/execution-kernel";
import type { ExecutionStepInput } from "@omnis/execution-kernel";
import { describeModelReference } from "@omnis/ai-core-types";
import type {
  AgentDescriptor,
  ExecutionKind,
  ExecutionRequest,
  ExecutionPlan,
  ModelId,
  ModelReference,
  ToolId,
  ToolReference,
} from "@omnis/ai-core-types";
import type { Clock } from "@omnis/execution-context";
import { systemClock } from "@omnis/execution-context";
import { agentPlanRejected } from "./errors.js";
import { preferredModelOf } from "./AgentRegistry.js";
import type { AgentPlanStepInput, AgentRunInput } from "./agentValidation.js";

/** The most steps one agent plan may contain. */
export const MAX_AGENT_PLAN_STEPS = MAX_PLAN_STEPS;

/** How a planner turns a reference into the identifier a step carries. */
export interface AgentPlanResolvers {
  /** Resolves a model reference, or returns `null` when no registry knows it. */
  readonly modelId?: ((reference: ModelReference) => ModelId | null) | null;
  /** Resolves a tool reference, or returns `null` when no registry knows it. */
  readonly toolId?: ((reference: ToolReference) => ToolId | null) | null;
}

/** Everything the planner is allowed to know. */
export interface AgentPlanContext {
  readonly descriptor: AgentDescriptor;
  readonly request: ExecutionRequest;
  readonly input: AgentRunInput;
  readonly resolvers?: AgentPlanResolvers | null;
}

/** A planner: one plan per run, or a typed refusal. */
export interface AgentPlanner {
  plan(context: AgentPlanContext): ExecutionPlan;
}

/** The identifier a step's model reference resolves to, or the reason it does not. */
function resolveModelId(
  reference: ModelReference,
  resolvers: AgentPlanResolvers,
  reasons: string[],
): ModelId | null {
  const resolve = resolvers.modelId;
  if (resolve === undefined || resolve === null) {
    reasons.push(
      `model ${describeModelReference(reference)} cannot be resolved: the runtime was given no model resolver`,
    );
    return null;
  }
  const modelId = resolve(reference);
  if (modelId === null) {
    reasons.push(`model ${describeModelReference(reference)} is not registered`);
  }
  return modelId;
}

/** A stable rendering of a tool reference, safe to log and to put in an error. */
function describeTool(reference: ToolReference): string {
  return reference.kind === "id" ? `id:${String(reference.toolId)}` : `name:${reference.name}`;
}

/** The identifier a step's tool reference resolves to, or the reason it does not. */
function resolveToolId(
  reference: ToolReference,
  resolvers: AgentPlanResolvers,
  reasons: string[],
): ToolId | null {
  const resolve = resolvers.toolId;
  if (resolve === undefined || resolve === null) {
    reasons.push(
      `tool ${describeTool(reference)} cannot be resolved: the runtime was given no tool resolver`,
    );
    return null;
  }
  const toolId = resolve(reference);
  if (toolId === null) {
    reasons.push(`tool ${describeTool(reference)} is not registered`);
  }
  return toolId;
}

/** The input every step inherits, so a step need not restate the task. */
function inheritedInput(input: AgentRunInput): Record<string, unknown> {
  return {
    ...(input.goal === undefined || input.goal === null ? {} : { goal: input.goal }),
    ...(input.data ?? {}),
  };
}

/**
 * The agent's instructions, for a step that will call a model.
 *
 * An agent's instructions are its behaviour contract. Leaving them out of the plan would
 * make them decoration: the model step would run without the system prompt the descriptor
 * declared, and nothing downstream could tell the difference. A tool step gets none — a
 * tool has no use for a system prompt, and sending it one would be noise in an audit row.
 */
function instructionsInput(
  descriptor: AgentDescriptor,
  kind: ExecutionKind,
): Record<string, unknown> {
  if (kind !== "model") {
    return {};
  }
  const { system, developer, prohibitions } = descriptor.instructions;
  // `system` is never null in a descriptor — an agent that declared none carries an empty
  // string — so "nothing declared" means empty, not absent.
  if (system.length === 0 && developer === null && prohibitions.length === 0) {
    return {};
  }
  return {
    instructions: {
      system,
      developer,
      prohibitions: [...prohibitions],
    },
  };
}

/**
 * Builds the steps a caller supplied, applying the descriptor's ceilings.
 *
 * Reasons accumulate rather than throwing on the first one: a caller fixing a plan
 * should see every problem with it at once, not discover them one rebuild at a time.
 */
function stepsFromInput(
  descriptor: AgentDescriptor,
  input: AgentRunInput,
  resolvers: AgentPlanResolvers,
): { steps: ExecutionStepInput[]; reasons: string[] } {
  const reasons: string[] = [];
  const supplied = input.steps ?? [];
  const constraints = descriptor.constraints;
  const seen = new Set<string>();

  const steps = supplied.map((step: AgentPlanStepInput, index: number): ExecutionStepInput => {
    if (seen.has(step.id)) {
      reasons.push(`step "${step.id}" is declared more than once`);
    }
    seen.add(step.id);

    if (step.kind === "tool" && step.tool !== undefined && step.tool !== null) {
      const toolId = resolveToolId(step.tool, resolvers, reasons);
      if (toolId !== null) {
        if (constraints.deniedTools.includes(toolId)) {
          reasons.push(`step "${step.id}" calls tool ${String(toolId)}, which the agent denies`);
        }
        if (constraints.allowedTools.length > 0 && !constraints.allowedTools.includes(toolId)) {
          reasons.push(
            `step "${step.id}" calls tool ${String(toolId)}, which is not in the agent's allowed tools`,
          );
        }
      }
    }

    // A ceiling expressed as "retries per step" bounds attempts, which include the first.
    const maxAttempts = capAttempts(step.maxAttempts ?? 1, constraints.maxRetriesPerStep);
    const timeoutMs = capTimeout(step.timeoutMs ?? null, constraints.maxDurationMs);

    /**
     * The model a step runs against.
     *
     * A step that names none inherits the agent's preferred model, which is the same rule
     * the derived plan follows: "the agent's default model" means every model step the
     * agent runs, not only the one the planner invented. Restating it on every step of
     * every plan would make the descriptor's default decorative, and a plan that forgot
     * would fail at the step rather than at planning, where the reason could still be
     * acted on.
     *
     * A step that names none *and* has no default to inherit is refused here, with the
     * step named, rather than being handed to an executor that would have to guess.
     */
    const named = step.model === undefined || step.model === null ? null : step.model;
    // Only a model step inherits: stamping a model onto a tool step would make an audit
    // row say the tool ran against a model, which it did not.
    const inherited = named ?? (step.kind === "model" ? preferredModelOf(descriptor) : null);
    if (step.kind === "model" && inherited === null) {
      reasons.push(
        `step "${step.id}" is a model step that names no model, and the agent declares no default`,
      );
    }

    return {
      id: step.id,
      name: step.name ?? `${step.kind} step ${String(index + 1)}`,
      kind: step.kind,
      dependsOn: [...(step.dependsOn ?? [])],
      timeoutMs,
      maxAttempts,
      optional: step.optional ?? false,
      input: {
        ...inheritedInput(input),
        ...instructionsInput(descriptor, step.kind),
        // A tool step's arguments ride inside its input under one reserved key, which is what
        // the composition's tool executor reads. Keeping them separate from the goal means a
        // tool is never handed the agent's instructions as though they were parameters.
        ...(step.arguments === undefined ? {} : { arguments: step.arguments }),
        ...(step.input ?? {}),
      },
      modelId: inherited === null ? null : resolveModelId(inherited, resolvers, reasons),
      toolId:
        step.kind === "tool" && step.tool !== undefined && step.tool !== null
          ? resolveToolId(step.tool, resolvers, reasons)
          : null,
      metadata: {},
    };
  });

  return { steps, reasons };
}

/** Attempts including the first, bounded by the agent's retries-per-step ceiling. */
function capAttempts(requested: number, maxRetriesPerStep: number | null): number {
  if (maxRetriesPerStep === null) {
    return requested;
  }
  return Math.max(1, Math.min(requested, maxRetriesPerStep + 1));
}

/** A step timeout that cannot outlive the agent's own duration ceiling. */
function capTimeout(requested: number | null, maxDurationMs: number | null): number | null {
  if (requested === null) {
    return maxDurationMs;
  }
  if (maxDurationMs === null) {
    return requested;
  }
  return Math.min(requested, maxDurationMs);
}

/**
 * The plan a descriptor implies when the caller supplied no steps.
 *
 * One `model` step against the agent's preferred model. An agent with no preferred
 * model and no supplied steps has nothing to run, and saying so is better than
 * inventing a step that would fail against a model nobody chose.
 */
function derivedSteps(
  descriptor: AgentDescriptor,
  input: AgentRunInput,
  resolvers: AgentPlanResolvers,
): { steps: ExecutionStepInput[]; reasons: string[] } {
  const reference = preferredModelOf(descriptor);
  if (reference === null) {
    return {
      steps: [],
      reasons: ["the agent declares no default model and the run supplied no steps"],
    };
  }
  const reasons: string[] = [];
  const modelId = resolveModelId(reference, resolvers, reasons);
  const constraints = descriptor.constraints;
  return {
    steps: [
      {
        id: `${descriptor.slug}-answer`,
        name: `${descriptor.displayName} answers`,
        kind: "model",
        dependsOn: [],
        timeoutMs: capTimeout(null, constraints.maxDurationMs),
        maxAttempts: capAttempts(1, constraints.maxRetriesPerStep),
        optional: false,
        input: { ...inheritedInput(input), ...instructionsInput(descriptor, "model") },
        modelId,
        providerId: null,
        toolId: null,
        metadata: {},
      },
    ],
    reasons,
  };
}

/**
 * Plans one agent run.
 *
 * @throws {ValidationError} as {@link agentPlanRejected}, listing every reason the
 *   plan cannot be built or accepted.
 */
export function planAgentRun(context: AgentPlanContext, clock: Clock = systemClock): ExecutionPlan {
  const { descriptor, request, input } = context;
  const resolvers = context.resolvers ?? {};
  const supplied = (input.steps ?? []).length > 0;
  const built = supplied
    ? stepsFromInput(descriptor, input, resolvers)
    : derivedSteps(descriptor, input, resolvers);
  const reasons = [...built.reasons];

  const maxSteps = descriptor.constraints.maxSteps;
  if (maxSteps !== null && built.steps.length > maxSteps) {
    reasons.push(
      `the plan has ${String(built.steps.length)} steps and the agent allows ${String(maxSteps)}`,
    );
  }
  // A plan that asks for more calls than the agent allows is refused here, before a
  // reservation is held for it. The runtime counts calls again while the run is live,
  // because a retry is another call and no plan can foresee how many it will need.
  const modelCalls = built.steps.filter((step) => step.kind === "model").length;
  const toolCalls = built.steps.filter((step) => step.kind === "tool").length;
  const maxModelCalls = descriptor.constraints.maxModelCalls;
  const maxToolCalls = descriptor.constraints.maxToolCalls;
  if (maxModelCalls !== null && modelCalls > maxModelCalls) {
    reasons.push(
      `the plan makes ${String(modelCalls)} model call(s) and the agent allows ${String(maxModelCalls)}`,
    );
  }
  if (maxToolCalls !== null && toolCalls > maxToolCalls) {
    reasons.push(
      `the plan makes ${String(toolCalls)} tool call(s) and the agent allows ${String(maxToolCalls)}`,
    );
  }
  if (built.steps.length > MAX_AGENT_PLAN_STEPS) {
    reasons.push(
      `the plan has ${String(built.steps.length)} steps and the platform allows ${String(MAX_AGENT_PLAN_STEPS)}`,
    );
  }
  if (built.steps.length === 0 && reasons.length === 0) {
    reasons.push("the plan has no steps");
  }
  if (reasons.length > 0) {
    throw agentPlanRejected(descriptor.id, reasons);
  }

  // `executionPlan` validates the structure — identifiers, dependencies, cycles —
  // and throws a typed error the kernel would have thrown anyway. Building it here
  // means a rejected plan is reported before a budget is reserved for it.
  return executionPlan({ executionId: request.id, steps: built.steps }, clock);
}

/** A planner that uses {@link planAgentRun}. */
export function createAgentPlanner(options: { readonly clock?: Clock } = {}): AgentPlanner {
  const clock = options.clock ?? systemClock;
  return Object.freeze({
    plan(context: AgentPlanContext): ExecutionPlan {
      return planAgentRun(context, clock);
    },
  });
}
