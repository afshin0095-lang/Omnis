/**
 * Test doubles for this package's suites.
 *
 * Executors are scripted: they return the outcome they were handed, in order, or fail a fixed
 * number of times before succeeding. A kernel test that called a real model would be testing the
 * model, and a retry test that depended on real latency would be flaky.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import {
  createCorrelationId,
  createExecutionId,
  createModelId,
  createSpanId,
  createTraceId,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonValue } from "@omnis/types";
import {
  createExecutionFailure,
  EMPTY_USAGE,
  initialExecutionMetadata,
  modelById,
} from "@omnis/ai-core-types";
import type {
  BudgetId,
  ExecutionAttempt,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionStep,
  PolicyId,
  UsageSummary,
} from "@omnis/ai-core-types";
import { InMemoryBudgetEngine } from "@omnis/budget-engine";
import type { BudgetEngine } from "@omnis/budget-engine";
import { InMemoryPolicyEngine } from "@omnis/policy-engine";
import type { PolicyEngine } from "@omnis/policy-engine";
import type {
  Span,
  SpanContext,
  StartSpanOptions,
  TelemetryAttributes,
  Tracer,
} from "@omnis/telemetry";
import { InMemoryExecutionKernel } from "./ExecutionKernel.js";
import type { ExecutionKernelOptions } from "./ExecutionKernel.js";
import { stepExecutor } from "./StepExecutor.js";
import type { StepEnvironment, StepExecutor, StepOutcome } from "./StepExecutor.js";

/** The instant fixtures happen at, in epoch milliseconds. */
export const AT_MS = 1_772_000_000_000;

/** The same instant as an ISO timestamp. */
export const AT = "2026-02-25T06:13:20.000Z";

/** A usage summary with a known cost. */
export function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return Object.freeze({
    ...EMPTY_USAGE,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    requests: 1,
    costMicro: 2_000,
    ...overrides,
  });
}

/** A valid execution request. */
export function executionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return Object.freeze({
    id: createExecutionId(),
    kind: "model",
    correlationId: createCorrelationId(),
    causationId: null,
    traceId: null,
    tenantId: null,
    parentExecutionId: null,
    agentId: null,
    model: modelById(createModelId()),
    tool: null,
    input: Object.freeze({ prompt: "summarize the report" }),
    mode: "interactive",
    priority: "normal",
    policyId: null,
    budgetId: null,
    deadlineMs: null,
    metadata: Object.freeze({}),
    requestedAt: AT,
    ...overrides,
  });
}

/** An executor that returns one outcome every time. */
export function constantExecutor(
  outcome: StepOutcome,
  kind: ExecutionStep["kind"] = "model",
): StepExecutor & { readonly calls: readonly StepEnvironment[] } {
  const calls: StepEnvironment[] = [];
  // Built as a literal rather than by extending `stepExecutor(...)`, whose result is frozen.
  return {
    kind,
    execute: (_step, environment) => {
      calls.push(environment);
      return outcome;
    },
    get calls(): readonly StepEnvironment[] {
      return calls;
    },
  };
}

/** An executor that returns a succeeded outcome carrying an output. */
export function okExecutor(
  output: JsonValue = { answer: 42 },
  consumed: UsageSummary = usage(),
  kind: ExecutionStep["kind"] = "model",
): StepExecutor {
  return stepExecutor(kind, () => ({
    status: "succeeded",
    output,
    usage: consumed,
    failure: null,
    modelId: null,
    providerId: null,
    toolId: null,
    metadata: {},
  }));
}

/** An executor that fails `failures` times and then succeeds. */
export function flakyExecutor(
  failures: number,
  options: {
    readonly retryable?: boolean;
    readonly delayMs?: number | null;
    readonly output?: JsonValue;
  } = {},
): StepExecutor & { readonly attempts: number } {
  let attempts = 0;
  const execute = () => {
    attempts += 1;
    if (attempts <= failures) {
      return {
        status: "failed" as const,
        output: null,
        usage: usage({ requests: 1 }),
        failure: createExecutionFailure({
          class: "retryable",
          code: "provider_failure",
          message: `attempt ${String(attempts)} failed`,
          retryable: options.retryable ?? true,
          retryAfterMs: options.delayMs ?? null,
          attempt: attempts,
          occurredAt: AT,
        }),
        modelId: null,
        providerId: null,
        toolId: null,
        metadata: {},
      };
    }
    return {
      status: "succeeded" as const,
      output: options.output ?? { answer: attempts },
      usage: usage(),
      failure: null,
      modelId: null,
      providerId: null,
      toolId: null,
      metadata: {},
    };
  };
  return {
    kind: "model",
    execute,
    get attempts(): number {
      return attempts;
    },
  };
}

/** An executor that resolves after `ms`. */
export function slowExecutor(
  ms: number,
  output: JsonValue = "late",
  kind: ExecutionStep["kind"] = "model",
): StepExecutor {
  return stepExecutor(
    kind,
    () =>
      new Promise<StepOutcome>((resolve) => {
        setTimeout(
          () =>
            resolve({
              status: "succeeded",
              output,
              usage: usage(),
              failure: null,
              modelId: null,
              providerId: null,
              toolId: null,
              metadata: {},
            }),
          ms,
        );
      }),
  );
}

/** An executor that throws. */
export function throwingExecutor(
  error: unknown,
  kind: ExecutionStep["kind"] = "model",
): StepExecutor {
  return stepExecutor(kind, () => {
    throw error;
  });
}

/** An executor that polls cancellation and stops when it is asked to. */
export function cancellableExecutor(
  pollMs = 5,
  kind: ExecutionStep["kind"] = "model",
): StepExecutor & { readonly pollCount: () => number } {
  let polls = 0;
  return {
    kind,
    execute: (_step: ExecutionStep, environment: StepEnvironment): Promise<StepOutcome> =>
      new Promise<StepOutcome>((resolve) => {
        const tick = (): void => {
          polls += 1;
          if (environment.isCancelled()) {
            resolve({
              status: "cancelled",
              output: null,
              usage: EMPTY_USAGE,
              failure: createExecutionFailure({
                class: "cancelled",
                code: "execution_failed",
                message: "executor observed cancellation",
                attempt: environment.attempt,
                occurredAt: AT,
              }),
              modelId: null,
              providerId: null,
              toolId: null,
              metadata: {},
            });
            return;
          }
          if (polls > 200) {
            resolve({
              status: "succeeded",
              output: "finished",
              usage: usage(),
              failure: null,
              modelId: null,
              providerId: null,
              toolId: null,
              metadata: {},
            });
            return;
          }
          setTimeout(tick, pollMs);
        };
        tick();
      }),
    pollCount: (): number => polls,
  };
}

/** A kernel on a fixed clock. */
export function kernel(options: ExecutionKernelOptions = {}): InMemoryExecutionKernel {
  return new InMemoryExecutionKernel({ clock: () => AT_MS, ...options });
}

/** A policy engine with one set that denies everything. */
export function denyAllPolicyEngine(): { engine: PolicyEngine; policyId: PolicyId } {
  const engine = new InMemoryPolicyEngine({ clock: () => AT });
  const set = engine.registerPolicySet({
    name: "deny-all",
    defaultOutcome: "deny",
    createdAt: AT,
    rules: [],
  });
  return { engine, policyId: set.id };
}

/** A policy engine with one set that allows everything. */
export function allowAllPolicyEngine(): { engine: PolicyEngine; policyId: PolicyId } {
  const engine = new InMemoryPolicyEngine({ clock: () => AT });
  const set = engine.registerPolicySet({
    name: "allow-all",
    defaultOutcome: "allow",
    createdAt: AT,
    rules: [],
  });
  return { engine, policyId: set.id };
}

/** A budget engine with one budget limited as given. */
export function budgetHarness(
  limits: {
    dimension: "tokens" | "requests" | "cost_micro_usd";
    window: "execution" | "total";
    limit: number;
  }[] = [{ dimension: "requests", window: "execution", limit: 10 }],
  // The budget engine's clock reads ISO strings; the kernel's reads epoch milliseconds.
  engine: BudgetEngine = new InMemoryBudgetEngine({ clock: () => AT }),
): { engine: BudgetEngine; budgetId: BudgetId } {
  const budget = engine.registerBudget({ name: "run-budget", limits, createdAt: AT });
  return { engine, budgetId: budget.id };
}

/** Holds in dimension order, so a comparison does not depend on the ledger's insertion order. */
export function byDimension(
  holds: readonly { readonly dimension: string }[],
): readonly { readonly dimension: string }[] {
  return [...holds].sort((left, right) => left.dimension.localeCompare(right.dimension));
}

/** A span as recorded by {@link recordingTracer}. */
export interface RecordedSpan extends Span {
  readonly recordedName: string;
  readonly recordedAttributes: Record<string, string | number | boolean>;
  readonly recordedStatuses: { readonly status: string; readonly message: string | undefined }[];
  readonly parent: SpanContext | undefined;
}

/** A tracer that records what the kernel asked it to record. */
export function recordingTracer(): { tracer: Tracer; spans: readonly RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    name: parseTrimmedString("test-tracer"),
    startSpan(name: string, options: StartSpanOptions = {}): Span {
      const attributes: Record<string, string | number | boolean> = {
        ...(options.attributes ?? {}),
      };
      const statuses: { status: string; message: string | undefined }[] = [];
      const contextValue: SpanContext = {
        traceId: options.parent?.traceId ?? createTraceId(),
        spanId: createSpanId(),
        parentSpanId: options.parent?.spanId ?? null,
        correlationId: options.parent?.correlationId ?? null,
        tenantId: options.parent?.tenantId ?? null,
      };
      let ended = false;
      const span: RecordedSpan = {
        name: parseTrimmedString(name),
        kind: options.kind ?? "internal",
        context: contextValue,
        get ended(): boolean {
          return ended;
        },
        setAttribute(key: string, value: JsonValue): void {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            attributes[key] = value;
          }
        },
        setAttributes(values: TelemetryAttributes): void {
          Object.assign(attributes, values);
        },
        setStatus(status: string, message?: string): void {
          statuses.push({ status, message });
        },
        recordException(): void {
          // The kernel records failures on the record, not as span exceptions.
        },
        addEvent(): void {
          // Not used by the kernel.
        },
        end(): void {
          ended = true;
        },
        recordedName: name,
        recordedAttributes: attributes,
        recordedStatuses: statuses,
        parent: options.parent,
      };
      spans.push(span);
      return span;
    },
  };
  return { tracer, spans };
}

/** One attempt row, for suites that need an attempt without running a kernel. */
export function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return Object.freeze({
    stepId: "step-1",
    kind: "model",
    attempt: 1,
    status: "succeeded",
    startedAt: AT,
    finishedAt: AT,
    durationMs: 0,
    failure: null,
    usage: EMPTY_USAGE,
    modelId: null,
    providerId: null,
    toolId: null,
    metadata: Object.freeze({}),
    ...overrides,
  });
}

/** A minimal, coherent execution record. */
export function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const request = overrides.request ?? executionRequest();
  return Object.freeze({
    request,
    status: "created",
    plan: null,
    attempts: Object.freeze([]),
    result: null,
    governance: initialExecutionMetadata(null),
    timeline: Object.freeze([{ at: AT, status: "created" as const, note: null, stepId: null }]),
    evaluation: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

/** A fixed execution identifier, for tests that need to refer to one before creating it. */
export const FIXTURE_EXECUTION_ID = createExecutionId();
