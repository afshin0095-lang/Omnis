/**
 * `@omnis/execution-context` — identity, time and cancellation for one execution.
 *
 * Public surface, deliberately narrow:
 * - {@link ExecutionContext}: the immutable value every AI Core operation receives.
 * - {@link ExecutionScope}: an owned execution, and the only holder of `cancel()`.
 * - {@link createExecutionContextFactory}: where defaults (clock, deadline, mode,
 *   priority, base metadata) are declared once for a composition root.
 * - {@link Deadline} and {@link CancellationToken}: the two ambient facts an execution
 *   is bounded by, both injectable so nothing here depends on wall-clock time.
 *
 * Not exported: `composeContext` and `ComposedContextInput`, which exist so the factory
 * and the scope build identical contexts. They are package-internal shape assembly, not
 * API — exporting them would invite callers to build contexts that skip sanitization.
 */

export { fixedClock, manualClock, systemClock, toIso } from "./Clock.js";
export type { Clock, ManualClock } from "./Clock.js";

export {
  alreadyCancelled,
  createCancellationSource,
  linkTokens,
  NEVER_CANCELLED,
} from "./Cancellation.js";
export type { CancellationToken, CancellationSource, Unsubscribe } from "./Cancellation.js";

export {
  assertDeadlineDuration,
  boundDeadline,
  createDeadline,
  deadlineAt,
  deadlineIso,
  earliestDeadline,
  expiresWithin,
  isExpired,
  remainingMs,
  remainingMsAt,
} from "./Deadline.js";
export type { Deadline } from "./Deadline.js";

export {
  causationFromCommand,
  causationFromEvent,
  childIdentity,
  hasCausation,
  identityOf,
  inheritCorrelation,
  isRootContext,
  lineageOf,
  newCorrelationId,
} from "./Correlation.js";
export type { LineageRecord } from "./Correlation.js";

export {
  mergeMetadata,
  metadataEquals,
  metadataPath,
  metadataValue,
  sanitizeMetadata,
  withoutMetadataKeys,
} from "./ExecutionMetadata.js";

export {
  actorFor,
  isSameRun,
  remainingContractMs,
  scopeOptionsFromContract,
  toContractContext,
} from "./ContractContext.js";
export type { ContractProjection } from "./ContractContext.js";

export {
  childDeadline,
  contextRemainingMs,
  contextTelemetryAttributes,
  spanParentOf,
  describeContext,
  isContextExpired,
  isContextUnusable,
} from "./ExecutionContext.js";
export type { ExecutionContext, SpanParent } from "./ExecutionContext.js";

export { DEFAULT_SCOPE_MODE, DEFAULT_SCOPE_PRIORITY, ExecutionScope } from "./ExecutionScope.js";
export type { ScopeDependencies, ScopeOptions } from "./ExecutionScope.js";

export {
  createExecutionContext,
  createExecutionContextFactory,
  startedAtIso,
} from "./ExecutionContextFactory.js";
export type {
  CreateContextOptions,
  ExecutionContextFactory,
  ExecutionContextFactoryOptions,
} from "./ExecutionContextFactory.js";
