/**
 * The Studio's AI Core feature.
 *
 * Three things, in the order a reader meets them:
 *
 * - `types.ts` — what the AI Core looks like on a screen, as plain data and pure
 *   formatting helpers. No React, no domain imports, nothing to render.
 * - `client.ts` — the seam to whatever runs the AI Core: one method per operation, a
 *   checked mapping from the platform's payloads to those view models, and every failure
 *   returned as a value instead of thrown.
 * - `mockRuntime.ts` — a deterministic stand-in for that backend, so the surface can be
 *   built and tested before one exists, and deleted without touching anything above the
 *   client when the real service arrives.
 *
 * Exports are listed rather than re-exported wholesale, so adding an internal helper does
 * not quietly widen what the rest of the app may reach for.
 */

export {
  emptyUsageView,
  formatDurationMs,
  formatMicroUsd,
  formatTokens,
  statusTone,
} from "./types";
export type {
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
  ViewTone,
} from "./types";

export { createAiCoreClient, viewErrorOf } from "./client";
export type { AiCoreClient, AiCoreOperation, AiCoreTransport } from "./client";

export { createMockAiCoreRuntime, MOCK_NOW } from "./mockRuntime";
export type { MockAiCoreOptions, MockAiCoreRuntime, MockRunOutcome } from "./mockRuntime";
