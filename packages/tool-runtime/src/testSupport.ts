/**
 * Test doubles for this package's suites.
 *
 * Handlers here are scripted: they return what they were told, sleep for a fixed interval, or
 * throw a chosen error. A tool runtime test that depended on a real external tool would be
 * testing that tool, and a timeout test that depended on real latency would be flaky.
 *
 * The recording tracer is the other half: spans are part of the runtime's contract, so they are
 * asserted rather than sent to a no-op.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import {
  createExecutionId,
  createSpanId,
  createToolId,
  createTraceId,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonValue, ToolId } from "@omnis/types";
import { toolById, toolByName, toolParameterSchema } from "@omnis/ai-core-types";
import type {
  ToolDescriptor,
  ToolHandlerResult,
  ToolInvocation,
  ToolParameterSpec,
} from "@omnis/ai-core-types";
import { createExecutionContext } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import type {
  Span,
  SpanContext,
  StartSpanOptions,
  TelemetryAttributes,
  Tracer,
} from "@omnis/telemetry";
import type { ToolDescriptorInput } from "./toolValidation.js";
import type { ToolInvocationRequest } from "./ToolRuntime.js";

/** The instant fixtures happen at, in epoch milliseconds. */
export const AT_MS = 1_772_000_000_000;

/** The same instant as an ISO timestamp. */
export const AT = "2026-02-25T06:13:20.000Z";

/** A string parameter declaration. */
export function stringParam(
  description = "A string parameter.",
  enumValues: readonly string[] = [],
  nullable = false,
): ToolParameterSpec {
  return { type: "string", description, enumValues, items: null, nullable };
}

/** An integer parameter declaration. */
export function integerParam(
  description = "An integer parameter.",
  nullable = false,
): ToolParameterSpec {
  return { type: "integer", description, enumValues: [], items: null, nullable };
}

/** An array-of-string parameter declaration. */
export function stringArrayParam(description = "An array of strings."): ToolParameterSpec {
  return {
    type: "array",
    description,
    enumValues: [],
    items: stringParam("An element."),
    nullable: false,
  };
}

/** A descriptor input for a low-risk read tool that takes one optional query string. */
export function toolDescriptorInput(
  overrides: Partial<ToolDescriptorInput> = {},
): ToolDescriptorInput {
  return {
    name: "search_documents",
    displayName: "Search documents",
    description: "Searches the document index and returns matching identifiers.",
    version: "1.0.0",
    kind: "read",
    riskLevel: "low",
    sideEffect: "none",
    permissions: [],
    parameters: toolParameterSchema(
      { query: stringParam("The query text."), limit: integerParam("Maximum results.") },
      ["query"],
    ),
    resultDescription: "A list of matching document identifiers.",
    timeoutMs: 1_000,
    supportsCancellation: true,
    maxConcurrency: 4,
    requiresApproval: false,
    policyId: null,
    budgetId: null,
    registeredAt: AT,
    ...overrides,
  };
}

/** A handler that returns one value. */
export function valueHandler(value: JsonValue): (invocation: ToolInvocation) => ToolHandlerResult {
  return () => ({ ok: true, value });
}

/** A handler that returns an error result. */
export function errorResultHandler(
  errorCode: string,
  message: string,
  retryable = false,
): (invocation: ToolInvocation) => ToolHandlerResult {
  return () => ({ ok: false, errorCode, message, retryable });
}

/** A handler that throws. */
export function throwingHandler(error: unknown): (invocation: ToolInvocation) => never {
  return () => {
    throw error;
  };
}

/** A handler that resolves after `ms`, or never when `ms` is larger than any test timeout. */
export function slowHandler(
  ms: number,
  value: JsonValue = "done",
): (invocation: ToolInvocation) => Promise<ToolHandlerResult> {
  return () =>
    new Promise<ToolHandlerResult>((resolve) => {
      setTimeout(() => resolve({ ok: true, value }), ms);
    });
}

/** A handler that polls cancellation and stops when it is asked to. */
export function cancellableHandler(pollMs = 5): {
  handler: (invocation: ToolInvocation) => Promise<ToolHandlerResult>;
  polls: () => number;
} {
  let polls = 0;
  const handler = (invocation: ToolInvocation): Promise<ToolHandlerResult> =>
    new Promise<ToolHandlerResult>((resolve) => {
      const tick = (): void => {
        polls += 1;
        if (invocation.environment.isCancelled()) {
          resolve({
            ok: false,
            errorCode: "cancelled_by_handler",
            message: "handler observed cancellation",
            retryable: false,
          });
          return;
        }
        if (polls > 200) {
          resolve({ ok: true, value: "finished" });
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  return { handler, polls: () => polls };
}

/** A handler that records every invocation it received. */
export function recordingHandler(result: ToolHandlerResult = { ok: true, value: "recorded" }): {
  handler: (invocation: ToolInvocation) => ToolHandlerResult;
  invocations: readonly ToolInvocation[];
} {
  const invocations: ToolInvocation[] = [];
  return {
    handler: (invocation: ToolInvocation): ToolHandlerResult => {
      invocations.push(invocation);
      return result;
    },
    get invocations(): readonly ToolInvocation[] {
      return invocations;
    },
  };
}

/** An execution context with a fixed start time and no deadline. */
export function context(
  overrides: Parameters<typeof createExecutionContext>[0] = {},
): ExecutionContext {
  return createExecutionContext(overrides, { clock: () => AT_MS });
}

/** An invocation request against a tool, with a fresh execution context. */
export function invocationRequest(
  tool: ToolDescriptor["id"] | string,
  overrides: Partial<ToolInvocationRequest> = {},
): ToolInvocationRequest {
  const reference =
    typeof tool === "string" && !tool.startsWith("tol_")
      ? toolByName(tool)
      : toolById(tool as ToolId);
  return {
    tool: reference,
    arguments: { query: "quarterly report" },
    context: context(),
    ...overrides,
  };
}

/** A span as recorded by {@link recordingTracer}. */
export interface RecordedSpan extends Span {
  readonly recordedName: string;
  readonly recordedAttributes: Record<string, string | number | boolean>;
  readonly recordedStatuses: { readonly status: string; readonly message: string | undefined }[];
  readonly recordedEvents: {
    readonly name: string;
    readonly attributes: TelemetryAttributes | undefined;
  }[];
  readonly recordedExceptions: unknown[];
  readonly parent: SpanContext | undefined;
}

/** A tracer that records what the runtime asked it to record. */
export function recordingTracer(): { tracer: Tracer; spans: readonly RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: Tracer = {
    name: parseTrimmedString("test-tracer"),
    startSpan(name: string, options: StartSpanOptions = {}): Span {
      const attributes: Record<string, string | number | boolean> = {
        ...(options.attributes ?? {}),
      };
      const statuses: { status: string; message: string | undefined }[] = [];
      const events: { name: string; attributes: TelemetryAttributes | undefined }[] = [];
      const exceptions: unknown[] = [];
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
        recordException(error: unknown): void {
          exceptions.push(error);
        },
        addEvent(eventName: string, eventAttributes?: TelemetryAttributes): void {
          events.push({ name: eventName, attributes: eventAttributes });
        },
        end(): void {
          ended = true;
        },
        recordedName: name,
        recordedAttributes: attributes,
        recordedStatuses: statuses,
        recordedEvents: events,
        recordedExceptions: exceptions,
        parent: options.parent,
      };
      spans.push(span);
      return span;
    },
  };

  return { tracer, spans };
}

/** Identifiers reused across suites. */
export const FIXTURE_IDS = {
  toolId: createToolId(),
  executionId: createExecutionId(),
} as const;
