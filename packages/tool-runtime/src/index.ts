/**
 * `@omnis/tool-runtime` — the only place a tool handler is called.
 *
 * Public surface:
 * - {@link ToolRuntime} and {@link InMemoryToolRuntime}: gates, timeout, cancellation,
 *   normalization, telemetry and audit for one invocation.
 * - {@link ToolRegistry} and {@link InMemoryToolRegistry}: descriptors and handlers, stored side
 *   by side and handed out separately, because reading a registry must not confer the ability to
 *   run one.
 * - {@link validateToolArguments}: closed-schema argument validation, returning every problem
 *   rather than the first.
 * - {@link ConcurrencyGate}: per-tool in-flight accounting.
 * - {@link AuditSink} and its implementations: where audit records go.
 * - Validation schemas, published contracts and error factories.
 *
 * Not exported: the invocation-race internals and the normalization helpers, which are how the
 * runtime keeps its own guarantees.
 */

export { createToolRuntime, InMemoryToolRuntime, TOOL_ERROR_CODES } from "./ToolRuntime.js";
export type {
  ToolApproval,
  ToolInvocationRequest,
  ToolRuntime,
  ToolRuntimeOptions,
} from "./ToolRuntime.js";

export { createToolRegistry, InMemoryToolRegistry } from "./InMemoryToolRegistry.js";
export { isLegalToolStatusTransition, TOOL_STATUS_TRANSITIONS } from "./ToolRegistry.js";
export type { ToolRegistry, ToolRegistryOptions } from "./ToolRegistry.js";

export {
  argumentKeys,
  argumentsSatisfy,
  assertToolArguments,
  describeArgumentProblems,
  validateToolArguments,
} from "./ToolArguments.js";
export type { ArgumentProblem, ToolArguments } from "./ToolArguments.js";

export { createConcurrencyGate } from "./ToolConcurrency.js";
export type { ConcurrencyGate, ConcurrencySnapshot } from "./ToolConcurrency.js";

export {
  compositeAuditSink,
  createCollectingAuditSink,
  NOOP_AUDIT_SINK,
  toolAuditRecord,
} from "./ToolAudit.js";
export type { AuditSink, CollectingAuditSink, ToolAuditInput } from "./ToolAudit.js";

export {
  denialMessage,
  duplicateTool,
  invalidToolArguments,
  invalidToolDescriptor,
  invalidToolHandler,
  invalidToolStatusTransition,
  toolNotRegistered,
  toolRegistryCapacityExceeded,
} from "./errors.js";

export {
  isToolDenialReason,
  isToolRiskLevelValue,
  MAX_TOOL_CONCURRENCY,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_TIMEOUT_MS,
  TOOL_AUDIT_CONTRACT,
  toolAuditRecordSchema,
  TOOL_DESCRIPTOR_CONTRACT,
  toolDenialReasonSchema,
  toolDescriptorInputSchema,
  toolDescriptorSchema,
  toolExecutionEnvironmentSchema,
  toolHandlerResultSchema,
  toolInvocationSchema,
  toolKindSchema,
  toolNameSchema,
  toolParameterSchemaSchema,
  toolParameterSpecSchema,
  toolParameterTypeSchema,
  toolPermissionSchema,
  TOOL_RESULT_CONTRACT,
  toolResultSchema,
  toolRiskLevelSchema,
  toolSideEffectSchema,
  toolStatusSchema,
  toolVersionSchema,
} from "./toolValidation.js";
export type { ToolDescriptorInput } from "./toolValidation.js";
