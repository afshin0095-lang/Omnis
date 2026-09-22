/**
 * What a composition holds, as facts rather than as a promise that it is fine.
 *
 * A health snapshot exists to answer two questions an operator actually asks: "is anything
 * registered?" and "can this runtime do the thing I am about to ask it?". Counts alone
 * answer the first; the `can*` flags answer the second, and they are derived rather than
 * declared — a runtime with three models and no provider cannot call a model, and saying
 * otherwise would be the kind of green light that gets paged.
 *
 * Nothing here probes a provider. A composition root has no credentials and no network, and
 * a health check that invented one would report a vendor's outage as its own.
 */

import type { AiCoreRuntime } from "./AiCoreRuntime.js";

/** A JSON-safe snapshot of one composition. */
export interface AiCoreHealth {
  /** Registered models. */
  readonly models: number;
  /** Registered providers. */
  readonly providers: number;
  /** Registered tools. */
  readonly tools: number;
  /** Registered agents. */
  readonly agents: number;
  /** Registered policy sets. */
  readonly policySets: number;
  /** Registered budgets. */
  readonly budgets: number;
  /** Registered evaluation rule sets. */
  readonly ruleSets: number;
  /** Executions the kernel still holds records for. */
  readonly executions: number;
  /** Agent instances the agent runtime is tracking. */
  readonly agentInstances: number;
  /** Events that could not be published, and were contained rather than raised. */
  readonly publishFailures: number;
  /** True when a bus is wired, so lifecycle events go somewhere. */
  readonly publishing: boolean;
  /** True when at least one model has at least one provider that could serve it. */
  readonly canCallModels: boolean;
  /** True when at least one tool is registered and invocable. */
  readonly canInvokeTools: boolean;
  /** True when at least one agent is registered and in a runnable status. */
  readonly canRunAgents: boolean;
  readonly checkedAt: string;
}

/** Snapshots one composition. */
export function aiCoreHealth(
  runtime: AiCoreRuntime,
  checkedAt: string = new Date().toISOString(),
): AiCoreHealth {
  const tools = runtime.tools.list();
  return Object.freeze({
    models: runtime.models.size,
    providers: runtime.providers.size,
    tools: tools.length,
    agents: runtime.agents.size,
    policySets: runtime.policy.size,
    budgets: runtime.budgets.size,
    ruleSets: runtime.evaluation.listRuleSets().length,
    executions: runtime.listExecutions().length,
    agentInstances: runtime.agentRuntime.size,
    publishFailures: runtime.agentRuntime.publishFailures().length,
    publishing: runtime.events !== null,
    // A provider is only a candidate when it is selectable: a disabled provider or one with
    // no credentials would make "we have providers" true and a call impossible.
    canCallModels: runtime.models.size > 0 && runtime.providers.selectable().length > 0,
    canInvokeTools: runtime.toolRuntime.invocableTools().length > 0,
    canRunAgents: runtime.agents.list().some((descriptor) => descriptor.status === "active"),
    checkedAt,
  });
}

/** A one-line rendering of a composition, for a startup log or a studio status bar. */
export function describeAiCoreRuntime(runtime: AiCoreRuntime): string {
  const health = aiCoreHealth(runtime);
  return [
    `ai-core: ${String(health.models)} model(s), ${String(health.providers)} provider(s), ${String(health.tools)} tool(s), ${String(health.agents)} agent(s)`,
    `${String(health.policySets)} policy set(s), ${String(health.budgets)} budget(s), ${String(health.ruleSets)} rule set(s)`,
    health.publishing ? "publishing events" : "no event bus",
  ].join("; ");
}
