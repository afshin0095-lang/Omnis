/**
 * `@omnis/agent-runtime` — agent descriptors, the agent lifecycle and the hand-off
 * to the execution kernel.
 *
 * Public surface:
 * - {@link AgentRegistry} and {@link InMemoryAgentRegistry}: what an agent *is*,
 *   as an immutable, deep-frozen descriptor, with resolution by identifier or slug.
 * - {@link AGENT_STATE_TRANSITIONS} and the transition helpers: the legal
 *   lifecycle moves, as data rather than as a `setState` anybody can call.
 * - {@link AgentRuntime} and {@link InMemoryAgentRuntime}: instances, planning and
 *   execution through the kernel — never a direct call to a model or a tool.
 * - {@link planAgentRun} and {@link AgentPlanner}: how a run becomes steps.
 * - {@link agentConstraintPolicyInput} and {@link AgentConstraintPolicies}: how an
 *   agent's ceilings become policy the kernel enforces.
 * - {@link createAgentEventPublisher}: how a run becomes `ai.agent.*` events.
 * - Schemas, published contract names and typed error factories.
 *
 * Dependencies: `@omnis/ai-core-types`, `@omnis/contracts`, `@omnis/errors`,
 * `@omnis/events`, `@omnis/execution-context`, `@omnis/execution-kernel`,
 * `@omnis/policy-engine`, `@omnis/telemetry`, `@omnis/types`, `@omnis/validation`.
 * No provider client, no tool handler and no vendor SDK appears here: the runtime
 * plans and delegates, and the executors that do the calling are registered with
 * the kernel by whoever composes the platform.
 */

export {
  AGENT_STATE_FOR_EXECUTION_STATUS,
  createAgentRuntime,
  DEFAULT_MAX_AGENT_INSTANCES,
  describeAgentRun,
  InMemoryAgentRuntime,
  isApprovalRequiredFailure,
} from "./AgentRuntime.js";
export type {
  AgentRunOptions,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeOptions,
} from "./AgentRuntime.js";

export {
  AGENT_STATE_TRANSITIONS,
  AGENT_STATUS_TRANSITIONS,
  agentStateMachineIsConsistent,
  agentStatePath,
  assertAgentStateTransition,
  assertAgentStatusTransition,
  isLegalAgentStateTransition,
  isLegalAgentStatusTransition,
  legalAgentStatusTransitions,
  legalAgentTransitions,
} from "./AgentStateMachine.js";

export {
  agentBudgetId,
  agentPolicyId,
  createAgentRegistry,
  describeAgentResolution,
  InMemoryAgentRegistry,
  preferredModelOf,
} from "./AgentRegistry.js";
export type { AgentMatchedBy, AgentRegistry, AgentResolution } from "./AgentRegistry.js";

export { createAgentPlanner, MAX_AGENT_PLAN_STEPS, planAgentRun } from "./agentPlanning.js";
export type { AgentPlanContext, AgentPlanner, AgentPlanResolvers } from "./agentPlanning.js";

export {
  AGENT_CONSTRAINT_POLICY_NAME,
  agentApprovalRule,
  agentConstraintPolicyInput,
  agentConstraintSource,
  agentConstraintSpecs,
  AgentConstraintPolicies,
  createAgentConstraintPolicies,
  hasAgentConstraints,
} from "./AgentConstraints.js";

export {
  createAgentEventPublisher,
  guardAgentEventPublisher,
  NOOP_AGENT_EVENT_PUBLISHER,
} from "./agentEvents.js";
export type {
  AgentEventPublishFailure,
  AgentEventPublisher,
  AgentEventPublisherOptions,
  AgentStateChangeFact,
} from "./agentEvents.js";

export {
  AGENT_PLAN_STEP_CONTRACT,
  AGENT_REGISTRATION_CONTRACT,
  AGENT_RUN_INPUT_CONTRACT,
  agentConstraintsInputSchema,
  agentInstructionsInputSchema,
  agentMemoryReferenceSchema,
  agentPlanStepInputSchema,
  agentRegistrationInputSchema,
  agentRunInputSchema,
  agentToolBindingInputSchema,
  isAgentCapabilityValue,
  isAgentKindValue,
  isAgentMemoryKindValue,
  isAgentStatusValue,
} from "./agentValidation.js";
export type {
  AgentConstraintsInput,
  AgentInstructionsInput,
  AgentMemoryReferenceInput,
  AgentPlanStepInput,
  AgentRegistrationInput,
  AgentRunInput,
  AgentToolBindingInput,
} from "./agentValidation.js";

export {
  agentCannotPauseWhileRunning,
  agentInstanceCapacityExceeded,
  agentInstanceNotFound,
  agentNotFound,
  agentNotExecutable,
  agentPlanRejected,
  duplicateAgent,
  illegalAgentStateTransition,
  illegalAgentStatusTransition,
  invalidAgentRunInput,
} from "./errors.js";
