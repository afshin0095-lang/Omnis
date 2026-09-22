/**
 * `@omnis/ai-core-runtime` — the AI Core's composition root.
 *
 * Public surface:
 * - {@link createAiCoreRuntime} and {@link AiCoreRuntime}: one call that wires the
 *   registries, the policy and budget engines, the evaluation engine, the model
 *   orchestrator, the tool runtime, the execution kernel and the agent runtime into a
 *   single injectable object with a small stable API.
 * - {@link createAiCoreEventBus}: an in-memory bus carrying every platform event
 *   definition, for a composition that has no external bus yet.
 * - {@link modelStepExecutor} and {@link toolStepExecutor}: the only bridge between a
 *   kernel step and the governed runtimes. Exported so a caller composing their own
 *   kernel gets the same bridge instead of writing a second, ungoverned one.
 * - {@link aiCoreHealth} and {@link describeAiCoreRuntime}: what a composition holds and
 *   what it can do, as facts.
 *
 * Dependencies: every AI Core package. This is the one place that is allowed to depend on
 * all of them, and it is thin: it holds no execution logic, because a composition root
 * that also decided things would be a second kernel. No vendor SDK appears here either —
 * providers arrive as {@link ProviderAdapter} implementations from outside the AI Core.
 */

export {
  AI_CORE_RUNTIME_CONTRACT,
  compositionFailure,
  createAiCoreEventBus,
  createAiCoreRuntime,
  describeRuntime,
} from "./AiCoreRuntime.js";
export type { AiCoreRuntime, AiCoreRuntimeOptions } from "./AiCoreRuntime.js";

export { aiCoreHealth, describeAiCoreRuntime } from "./runtimeHealth.js";
export type { AiCoreHealth } from "./runtimeHealth.js";

export {
  argumentsForStep,
  MAX_STEP_MESSAGE_TEXT,
  messagesForStep,
  modelStepExecutor,
  modelStepOutput,
  toolStepExecutor,
} from "./stepExecutors.js";
export type { ModelStepExecutorOptions, ToolStepExecutorOptions } from "./stepExecutors.js";
