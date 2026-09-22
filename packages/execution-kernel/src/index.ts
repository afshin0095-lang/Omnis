/**
 * `@omnis/execution-kernel` — the lifecycle every unit of AI work passes through.
 *
 * Public surface:
 * - {@link ExecutionKernel} and {@link InMemoryExecutionKernel}: validate, authorize, reserve,
 *   plan, run, settle, evaluate, record.
 * - {@link StepExecutor}, {@link StepEnvironment} and the outcome builders: how the layers that do
 *   know about models and tools plug into a kernel that does not.
 * - {@link EXECUTION_STATUS_TRANSITIONS} and the transition helpers: the legal lifecycle moves.
 * - Plan construction and validation.
 * - Hooks, including a composing wrapper and a collecting implementation.
 * - Schemas, published contracts and error factories.
 *
 * Not exported: the record-assembly helpers, which are how the kernel keeps a record coherent
 * while it is still being written.
 */

export {
  createExecutionKernel,
  DEFAULT_MAX_EXECUTIONS,
  DEFAULT_RETRY_DELAY_MS,
  InMemoryExecutionKernel,
  MAX_RETRY_DELAY_MS,
} from "./ExecutionKernel.js";
export type {
  ExecutionApproval,
  ExecutionKernel,
  ExecutionKernelOptions,
  ExecutionRunOptions,
} from "./ExecutionKernel.js";

export {
  assertExecutionStatusTransition,
  EXECUTION_GATE_SEQUENCE,
  EXECUTION_STATUS_TRANSITIONS,
  gatesCleared,
  isLegalExecutionStatusTransition,
  legalExecutionTransitions,
} from "./ExecutionStateMachine.js";

export {
  cancelledOutcome,
  failedOutcome,
  isSuccessfulOutcome,
  retryDelayMs,
  shouldRetry,
  skippedOutcome,
  stepEnvironment,
  stepExecutor,
  stepOutcome,
  succeededOutcome,
} from "./StepExecutor.js";
export type {
  StepEnvironment,
  StepEnvironmentIdentity,
  StepExecutor,
  StepOutcome,
  StepOutcomeInput,
} from "./StepExecutor.js";
export { outcomeFromError } from "./StepExecutor.js";

export { collectingHooks, compositeHooks, NOOP_HOOKS, planIdOf } from "./ExecutionHooks.js";
export type {
  CollectingHooks,
  ExecutionHooks,
  HookPoint,
  RetryDecision,
  StatusChange,
} from "./ExecutionHooks.js";

export {
  assertValidPlan,
  describeStepName,
  executionPlan,
  executionStep,
  MAX_PLAN_STEPS,
  MAX_RETRY_ATTEMPTS,
  MAX_STEP_DEPENDENCIES,
  planIssues,
  runOrder,
  singleStepPlan,
  stepInputFromRequest,
} from "./plans.js";
export type { ExecutionPlanInput, ExecutionStepInput } from "./plans.js";

export {
  describePlanIssues,
  duplicateExecution,
  executionAlreadyTerminal,
  executionNotFound,
  invalidExecutionRequest,
  invalidExecutor,
  kernelCapacityExceeded,
  noStepExecutor,
  planRejected,
} from "./errors.js";

export {
  EXECUTION_ATTEMPT_CONTRACT,
  EXECUTION_PLAN_CONTRACT,
  EXECUTION_REQUEST_CONTRACT,
  EXECUTION_STEP_CONTRACT,
  EXECUTION_TIMELINE_CONTRACT,
  executionAttemptSchema,
  executionFailureSchema,
  executionPlanSchema,
  executionRequestSchema,
  executionStepSchema,
  executionTimelineEntrySchema,
  isExecutionKindValue,
  isExecutionModeValue,
  isExecutionPriorityValue,
  isExecutionStatusValue,
  modelReferenceSchema,
  toolReferenceSchema,
  usageSummarySchema,
} from "./kernelValidation.js";
