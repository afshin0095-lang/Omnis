/**
 * The tool runtime: the only place a tool handler is called.
 *
 * Order of operations, and why it is that order:
 *
 * 1. **Resolve** the tool. A name no registry knows is an error, not a result — there is no
 *    identifier to build an audit record around.
 * 2. **Status.** A disabled tool never reaches argument validation, so its handler cannot be
 *    provoked into running by a well-formed call.
 * 3. **Arguments.** Validated against the closed declared schema before anything else reads
 *    them, so no gate ever reasons about a shape the tool will not actually receive.
 * 4. **Permissions**, then 5. **policy**, then 6. **approval**. Governance runs before the
 *    concurrency slot is taken and before a millisecond of handler time is spent.
 * 7. **Concurrency**, 8. **cancellation**, 9. the **handler**, bounded by a timeout.
 *
 * A refusal at any of steps 2, 4, 5, 6 or 7 is returned as a `denied` result rather than thrown,
 * so an agent sees the refusal in the same shape as any other outcome and can react to it. A
 * handler that fails, times out or is cancelled is returned as a `failed` result. Only a
 * misconfigured runtime — an unresolvable tool — throws.
 *
 * Nothing here retries. Retry is a policy decision that belongs to the kernel, which knows the
 * step, the attempt count and the deadline; a runtime that retried on its own would multiply
 * every attempt the caller makes.
 */

import { parseTrimmedString } from "@omnis/types";
import { NOOP_TRACER } from "@omnis/telemetry";
import type { Span, Tracer } from "@omnis/telemetry";
import { aiSpanAttributes } from "@omnis/telemetry";
import type { TelemetryAttributes } from "@omnis/telemetry";
import {
  contextRemainingMs,
  contextTelemetryAttributes,
  sanitizeMetadata,
  systemClock,
  toIso,
  spanParentOf,
} from "@omnis/execution-context";
import type { Clock, ExecutionContext, Unsubscribe } from "@omnis/execution-context";
import {
  classifyError,
  formatPermission,
  isInvocableToolStatus,
  isRetryableSideEffect,
  numericConstraint,
} from "@omnis/ai-core-types";
import type {
  PolicyId,
  ToolAuditRecord,
  ToolDenialReason,
  ToolDescriptor,
  ToolExecutionEnvironment,
  ToolHandlerResult,
  ToolId,
  ToolInvocation,
  ToolReference,
  ToolResult,
} from "@omnis/ai-core-types";
import type { PolicyEngine, PolicyGateResult } from "@omnis/policy-engine";
import { isOmnisError } from "@omnis/errors";
import type { AuditSink } from "./ToolAudit.js";
import { NOOP_AUDIT_SINK, toolAuditRecord } from "./ToolAudit.js";
import { createConcurrencyGate } from "./ToolConcurrency.js";
import type { ConcurrencyGate } from "./ToolConcurrency.js";
import type { ToolRegistry } from "./ToolRegistry.js";
import { argumentKeys, describeArgumentProblems, validateToolArguments } from "./ToolArguments.js";
import type { ToolArguments } from "./ToolArguments.js";
import { toolNotRegistered } from "./errors.js";
import { denialMessage } from "./errors.js";

/** An approval recorded for one invocation. */
export interface ToolApproval {
  readonly approved: boolean;
  /** Who approved, e.g. `"operator"` or a role name. Recorded in the policy input. */
  readonly approver: string;
  readonly approvedAt: string | null;
}

/** One tool invocation request. */
export interface ToolInvocationRequest {
  /** The tool, by identifier or by the name a model called. */
  readonly tool: ToolReference;
  /** Arguments, validated against the tool's closed parameter schema. */
  readonly arguments?: ToolArguments;
  /** Identity, deadline, cancellation and metadata for this invocation. */
  readonly context: ExecutionContext;
  /** 1-based attempt number. Defaults to 1; the runtime never increments it. */
  readonly attempt?: number;
  /** Per-invocation timeout override. Tightened, never widened, by policy and the deadline. */
  readonly timeoutMs?: number | null;
  /** Permissions the caller holds, as `resource:action` strings. */
  readonly grantedPermissions?: readonly string[];
  /** Approval, when the tool or a policy requires one. */
  readonly approval?: ToolApproval | null;
  /** Extra policy sets to evaluate, beyond the descriptor's and the runtime defaults. */
  readonly policyIds?: readonly PolicyId[];
  /** Metadata passed to the handler. Sanitized before it is stored or forwarded. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** How a runtime is configured. */
export interface ToolRuntimeOptions {
  /** Where tools and handlers come from. Required: a runtime with no registry cannot run. */
  readonly registry: ToolRegistry;
  /** Policy gate. When absent, only descriptor-level approval and permissions are enforced. */
  readonly policyEngine?: PolicyEngine | null;
  /** Tracer for invocation spans. Defaults to the no-op tracer. */
  readonly tracer?: Tracer;
  /** Monotonic-ish clock in epoch milliseconds. Injectable so timestamps are exact in tests. */
  readonly clock?: Clock;
  /** Where audit records go. Defaults to a sink that keeps nothing. */
  readonly audit?: AuditSink;
  /** Resolves granted permissions when the request does not carry them. */
  readonly resolveGrants?: (
    context: ExecutionContext,
    descriptor: ToolDescriptor,
  ) => readonly string[];
  /** Policy sets evaluated for every invocation, e.g. a tenant-wide set. */
  readonly defaultPolicyIds?: readonly PolicyId[];
  /** Concurrency gate. Injectable so a composition root can share one across runtimes. */
  readonly concurrency?: ConcurrencyGate;
}

/** The runtime's public surface. */
export interface ToolRuntime {
  /** The registry this runtime invokes tools from. */
  readonly registry: ToolRegistry;

  /** Runs one invocation through every gate and returns a normalized result. */
  invoke(request: ToolInvocationRequest): Promise<ToolResult>;

  /** Invocations of one tool currently in flight. */
  inFlight(toolId: ToolId): number;

  /** The descriptors a model may be offered: everything invocable, by name. */
  invocableTools(): readonly ToolDescriptor[];

  /** Releases every concurrency slot. Called when a runtime is torn down mid-flight. */
  dispose(): void;
}

/** What the race between handler, timeout and cancellation produced. */
type HandlerOutcome =
  | { readonly kind: "completed"; readonly result: ToolHandlerResult }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled"; readonly reason: string };

/** Error codes the runtime itself produces. */
export const TOOL_ERROR_CODES = Object.freeze({
  argumentsInvalid: "tool_arguments_invalid",
  timedOut: "tool_timeout",
  cancelled: "tool_cancelled",
  handlerFailed: "tool_handler_error",
  deadlineExceeded: "deadline_exceeded",
  runtimeError: "tool_runtime_error",
} as const);

/** The in-memory tool runtime. */
export class InMemoryToolRuntime implements ToolRuntime {
  readonly registry: ToolRegistry;
  private readonly policyEngine: PolicyEngine | null;
  private readonly tracer: Tracer;
  private readonly clock: Clock;
  private readonly audit: AuditSink;
  private readonly resolveGrants:
    ((context: ExecutionContext, descriptor: ToolDescriptor) => readonly string[]) | null;
  private readonly defaultPolicyIds: readonly PolicyId[];
  private readonly concurrency: ConcurrencyGate;

  constructor(options: ToolRuntimeOptions) {
    this.registry = options.registry;
    this.policyEngine = options.policyEngine ?? null;
    this.tracer = options.tracer ?? NOOP_TRACER;
    this.clock = options.clock ?? systemClock;
    this.audit = options.audit ?? NOOP_AUDIT_SINK;
    this.resolveGrants = options.resolveGrants ?? null;
    this.defaultPolicyIds = Object.freeze([...(options.defaultPolicyIds ?? [])]);
    this.concurrency = options.concurrency ?? createConcurrencyGate();
  }

  inFlight(toolId: ToolId): number {
    return this.concurrency.inFlight(toolId);
  }

  invocableTools(): readonly ToolDescriptor[] {
    return this.registry.list().filter((descriptor) => isInvocableToolStatus(descriptor.status));
  }

  dispose(): void {
    this.concurrency.releaseAll();
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolResult> {
    const descriptor = this.registry.resolve(request.tool);
    if (descriptor === null) {
      // Thrown rather than returned: without a descriptor there is no identifier, version or
      // permission list to build an audit record from, and inventing them would produce a record
      // that describes a tool that does not exist.
      throw toolNotRegistered(request.tool);
    }

    const startedAtMs = this.clock();
    const startedAt = toIso(startedAtMs);
    const args: ToolArguments = request.arguments ?? {};
    const attempt = request.attempt ?? 1;
    const requiredPermissions = descriptor.permissions.map(formatPermission);
    let policyOutcome = "not_evaluated";
    const span = this.startSpan(descriptor, request.context, attempt);

    const finish = (result: ToolResult): ToolResult => {
      this.endSpan(span, descriptor, result, policyOutcome);
      this.audit.record(result.audit, result);
      return result;
    };

    const audit = (input: {
      finishedAtMs: number | null;
      timedOut?: boolean;
      cancelled?: boolean;
    }): ToolAuditRecord => {
      const finishedAtMs = input.finishedAtMs;
      return toolAuditRecord({
        executionId: request.context.executionId,
        correlationId: request.context.correlationId,
        toolId: descriptor.id,
        toolName: descriptor.name,
        toolVersion: descriptor.version,
        attempt,
        permissionsRequired: requiredPermissions,
        policyDecisionOutcome: policyOutcome,
        startedAt,
        finishedAt: finishedAtMs === null ? null : toIso(finishedAtMs),
        durationMs: finishedAtMs === null ? null : Math.max(0, finishedAtMs - startedAtMs),
        timedOut: input.timedOut ?? false,
        cancelled: input.cancelled ?? false,
        argumentKeys: argumentKeys(args),
      });
    };

    const denied = (reason: ToolDenialReason, detail: string): ToolResult =>
      Object.freeze({
        status: "denied",
        toolId: descriptor.id,
        reason,
        message: denialMessage(reason, descriptor.name, detail),
        audit: audit({ finishedAtMs: this.clock() }),
      });

    const failed = (input: {
      errorCode: string;
      message: string;
      retryable: boolean;
      timedOut?: boolean;
      cancelled?: boolean;
      finishedAtMs?: number;
    }): ToolResult =>
      Object.freeze({
        status: "failed",
        toolId: descriptor.id,
        errorCode: input.errorCode,
        message: input.message,
        // A retry is only safe when repeating the call cannot duplicate a side effect. The
        // handler's opinion is taken into account but never allowed to override that.
        retryable: input.retryable && isRetryableSideEffect(descriptor.sideEffect),
        timedOut: input.timedOut ?? false,
        cancelled: input.cancelled ?? false,
        durationMs: Math.max(0, (input.finishedAtMs ?? this.clock()) - startedAtMs),
        audit: audit({
          finishedAtMs: input.finishedAtMs ?? this.clock(),
          timedOut: input.timedOut ?? false,
          cancelled: input.cancelled ?? false,
        }),
      });

    try {
      if (!isInvocableToolStatus(descriptor.status)) {
        return finish(denied("disabled", descriptor.status));
      }

      const problems = validateToolArguments(descriptor.parameters, args);
      if (problems.length > 0) {
        // Returned as a failure rather than a denial: a model that called the tool wrongly can
        // correct itself on the next turn, which it cannot do if the invocation never reports.
        return finish(
          failed({
            errorCode: TOOL_ERROR_CODES.argumentsInvalid,
            message: describeArgumentProblems(problems),
            retryable: false,
          }),
        );
      }

      const granted = this.grantedPermissions(request, descriptor);
      const missing = requiredPermissions.filter((permission) => !granted.includes(permission));
      if (missing.length > 0) {
        return finish(denied("permission", missing.join(", ")));
      }

      const gate = this.evaluatePolicy(descriptor, request, args);
      policyOutcome = gate === null ? "not_evaluated" : gate.outcome;
      if (gate !== null && gate.outcome === "deny") {
        return finish(denied("policy", gate.reason ?? "policy denied the invocation"));
      }

      const approvalRequired = descriptor.requiresApproval || gate?.outcome === "require_approval";
      if (approvalRequired && request.approval?.approved !== true) {
        return finish(
          denied(
            "approval_required",
            gate !== null && gate.reason !== null
              ? gate.reason
              : "no approval was recorded for this invocation",
          ),
        );
      }

      const remaining = contextRemainingMs(request.context, startedAtMs);
      if (remaining !== null && remaining <= 0) {
        return finish(
          failed({
            errorCode: TOOL_ERROR_CODES.deadlineExceeded,
            message: `execution deadline passed before tool "${descriptor.name}" started`,
            retryable: false,
          }),
        );
      }
      const timeoutMs = this.effectiveTimeoutMs(descriptor, request, gate, remaining);

      if (!this.concurrency.tryAcquire(descriptor.id, descriptor.maxConcurrency)) {
        return finish(
          denied(
            "concurrency",
            `${String(this.concurrency.inFlight(descriptor.id))} of ${String(descriptor.maxConcurrency)} slots in use`,
          ),
        );
      }

      try {
        if (request.context.cancellation.cancelled) {
          return finish(
            failed({
              errorCode: TOOL_ERROR_CODES.cancelled,
              message:
                request.context.cancellation.reason ??
                "execution was cancelled before the tool started",
              retryable: false,
              cancelled: true,
            }),
          );
        }

        const handler = this.registry.requireHandler(descriptor.id);
        const invocation = this.buildInvocation(
          descriptor,
          request,
          args,
          attempt,
          startedAtMs,
          timeoutMs,
        );
        const outcome = await this.runHandler(handler, invocation, timeoutMs, request.context);
        const finishedAtMs = this.clock();

        switch (outcome.kind) {
          case "timeout":
            return finish(
              failed({
                errorCode: TOOL_ERROR_CODES.timedOut,
                message: `tool "${descriptor.name}" exceeded ${String(timeoutMs)}ms`,
                // A timeout leaves the work in an unknown state, so whether it may be repeated
                // depends entirely on whether repeating it is safe.
                retryable: true,
                timedOut: true,
                finishedAtMs,
              }),
            );
          case "cancelled":
            return finish(
              failed({
                errorCode: TOOL_ERROR_CODES.cancelled,
                message: outcome.reason,
                retryable: false,
                cancelled: true,
                finishedAtMs,
              }),
            );
          case "threw":
            return finish(this.normalizeThrown(outcome.error, finishedAtMs, failed));
          case "completed": {
            const result = outcome.result;
            if (result.ok) {
              return finish(
                Object.freeze({
                  status: "succeeded",
                  toolId: descriptor.id,
                  value: result.value,
                  durationMs: Math.max(0, finishedAtMs - startedAtMs),
                  audit: audit({ finishedAtMs }),
                }),
              );
            }
            return finish(
              failed({
                errorCode: result.errorCode,
                message: result.message,
                retryable: result.retryable ?? false,
                finishedAtMs,
              }),
            );
          }
        }
      } finally {
        this.concurrency.release(descriptor.id);
      }
    } catch (error) {
      // A gate itself failed: a missing policy set, an invalid descriptor, an audit sink that
      // threw. The invocation is reported as a failure rather than unwinding the execution,
      // because the caller asked for a tool result and a crash is not one.
      const code = isOmnisError(error) ? error.code : TOOL_ERROR_CODES.runtimeError;
      const message = error instanceof Error ? error.message : String(error);
      return finish(
        failed({
          errorCode: code,
          message: `tool runtime could not complete the invocation: ${message}`,
          retryable: false,
        }),
      );
    }
  }

  /** Permissions the caller holds, from the request or from the configured resolver. */
  private grantedPermissions(
    request: ToolInvocationRequest,
    descriptor: ToolDescriptor,
  ): readonly string[] {
    if (request.grantedPermissions !== undefined) {
      return request.grantedPermissions;
    }
    if (this.resolveGrants !== null) {
      return this.resolveGrants(request.context, descriptor);
    }
    // Fail closed: with no grant source configured, nothing is granted and every tool that
    // declares a permission is refused. A runtime that assumed grants would be enforcing a
    // permission model it had never been told about.
    return [];
  }

  /** Runs the policy gate, or returns `null` when no policy applies. */
  private evaluatePolicy(
    descriptor: ToolDescriptor,
    request: ToolInvocationRequest,
    args: ToolArguments,
  ): PolicyGateResult | null {
    if (this.policyEngine === null) {
      return null;
    }
    const policyIds: PolicyId[] = [];
    for (const policyId of [
      descriptor.policyId,
      ...this.defaultPolicyIds,
      ...(request.policyIds ?? []),
    ]) {
      if (policyId !== null && !policyIds.includes(policyId)) {
        policyIds.push(policyId);
      }
    }
    if (policyIds.length === 0) {
      return null;
    }
    return this.policyEngine.gateWithContext(
      request.context,
      {
        action: "tool.invoke",
        subject: "tool",
        resource: descriptor.name,
        riskLevel: descriptor.riskLevel,
        toolId: descriptor.id,
        budgetId: descriptor.budgetId ?? undefined,
        // Argument *keys* are facts a policy may use; values are not telemetry and not policy
        // input, because a rule that reads argument content is a rule that leaks it into an
        // audit record.
        attributes: {
          toolVersion: descriptor.version,
          toolKind: descriptor.kind,
          sideEffect: descriptor.sideEffect,
          requiresApproval: descriptor.requiresApproval,
          approved: request.approval?.approved ?? null,
          // A separate boolean, so a rule can demand approval without having to spell out the
          // difference between "no approval submitted" and "approval refused".
          approvalGranted: request.approval?.approved === true,
          approver: request.approval?.approver ?? null,
          argumentKeys: Object.keys(args).sort(),
          grantedPermissions: this.grantedPermissions(request, descriptor),
        },
      },
      policyIds,
    );
  }

  /** The timeout this invocation actually gets: the tightest of every bound that applies. */
  private effectiveTimeoutMs(
    descriptor: ToolDescriptor,
    request: ToolInvocationRequest,
    gate: PolicyGateResult | null,
    remainingMs: number | null,
  ): number {
    const candidates: number[] = [descriptor.timeoutMs];
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) {
      candidates.push(request.timeoutMs);
    }
    const policyDuration =
      gate === null ? null : numericConstraint(gate.constraints, "max_duration_ms");
    if (policyDuration !== null) {
      candidates.push(policyDuration);
    }
    if (remainingMs !== null) {
      candidates.push(remainingMs);
    }
    const tightest = Math.min(...candidates);
    return Math.max(1, Math.trunc(tightest));
  }

  /** The invocation value a handler receives. */
  private buildInvocation(
    descriptor: ToolDescriptor,
    request: ToolInvocationRequest,
    args: ToolArguments,
    attempt: number,
    startedAtMs: number,
    timeoutMs: number,
  ): ToolInvocation {
    const deadlineAtMs = startedAtMs + timeoutMs;
    const context = request.context;
    const environment: ToolExecutionEnvironment = {
      executionId: context.executionId,
      correlationId: context.correlationId,
      attempt,
      isCancelled: () => context.cancellation.cancelled,
      // The tighter of the invocation timeout and the execution deadline, so a handler that
      // budgets its own work budgets against the limit that will actually stop it.
      remainingMs: () => {
        const now = this.clock();
        const contextRemaining = contextRemainingMs(context, now);
        const timeoutRemaining = deadlineAtMs - now;
        if (contextRemaining === null) {
          return Math.max(0, timeoutRemaining);
        }
        return Math.max(0, Math.min(contextRemaining, timeoutRemaining));
      },
    };
    return Object.freeze({
      toolId: descriptor.id,
      name: descriptor.name,
      arguments: Object.freeze({ ...args }),
      environment,
      metadata: sanitizeMetadata(request.metadata ?? {}),
    });
  }

  /** Races the handler against the timeout and the cancellation token. */
  private async runHandler(
    handler: (invocation: ToolInvocation) => Promise<ToolHandlerResult> | ToolHandlerResult,
    invocation: ToolInvocation,
    timeoutMs: number,
    context: ExecutionContext,
  ): Promise<HandlerOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: Unsubscribe | undefined;
    try {
      // The handler is called inside a resolved promise chain so a synchronous throw becomes a
      // rejection like any other, and one code path handles both.
      const handlerOutcome = Promise.resolve()
        .then(() => handler(invocation))
        .then(
          (result): HandlerOutcome => ({ kind: "completed", result }),
          (error: unknown): HandlerOutcome => ({ kind: "threw", error }),
        );

      const timeoutOutcome = new Promise<HandlerOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      });

      const cancellationOutcome = new Promise<HandlerOutcome>((resolve) => {
        if (context.cancellation.cancelled) {
          resolve({
            kind: "cancelled",
            reason: context.cancellation.reason ?? "execution was cancelled",
          });
          return;
        }
        unsubscribe = context.cancellation.onCancelled((reason) => {
          resolve({ kind: "cancelled", reason });
        });
      });

      return await Promise.race([handlerOutcome, timeoutOutcome, cancellationOutcome]);
    } finally {
      // Always cleared. A timer left running after the invocation finished would keep the event
      // loop alive and, in a test process, keep the process alive with it.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      unsubscribe?.();
    }
  }

  /** Turns a thrown handler error into a failed result. */
  private normalizeThrown(
    error: unknown,
    finishedAtMs: number,
    failed: (input: {
      errorCode: string;
      message: string;
      retryable: boolean;
      finishedAtMs?: number;
    }) => ToolResult,
  ): ToolResult {
    const failureClass = classifyError(error);
    const code = isOmnisError(error) ? error.code : TOOL_ERROR_CODES.handlerFailed;
    const message = error instanceof Error ? error.message : String(error);
    // `classifyError` knows which failures are transient; a handler that throws a timeout should
    // not be reported as permanently broken.
    const retryable = failureClass === "retryable" || failureClass === "provider_failure";
    return failed({ errorCode: code, message, retryable, finishedAtMs });
  }

  /** Starts the invocation span, parented to the execution's span when there is one. */
  private startSpan(descriptor: ToolDescriptor, context: ExecutionContext, attempt: number): Span {
    const parent = spanParentOf(context);
    return this.tracer.startSpan(parseTrimmedString(`tool.invoke ${descriptor.name}`), {
      kind: "internal",
      ...(parent === undefined ? {} : { parent }),
      attributes: {
        ...contextTelemetryAttributes(context),
        ...aiSpanAttributes({
          executionId: context.executionId,
          correlationId: context.correlationId,
          toolId: descriptor.id,
          toolName: descriptor.name,
          toolVersion: descriptor.version,
          toolKind: descriptor.kind,
          toolRiskLevel: descriptor.riskLevel,
          attempt,
        }),
      },
    });
  }

  /**
   * Records the outcome on the span and ends it.
   *
   * Only the namespace helper builds attribute names here: a span attribute typed by hand is a
   * span attribute that can drift from the vocabulary dashboards are built on.
   */
  private endSpan(
    span: Span,
    descriptor: ToolDescriptor,
    result: ToolResult,
    policyOutcome: string,
  ): void {
    const shared = {
      toolName: descriptor.name,
      toolId: descriptor.id,
      policyOutcome,
    };
    let attributes: TelemetryAttributes;
    if (result.status === "succeeded") {
      attributes = aiSpanAttributes({
        ...shared,
        status: "succeeded",
        durationMs: result.durationMs,
      });
      span.setAttributes(attributes);
      span.setStatus("ok");
    } else if (result.status === "failed") {
      attributes = aiSpanAttributes({
        ...shared,
        status: "failed",
        durationMs: result.durationMs,
        failureCode: result.errorCode,
        retryable: result.retryable,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
      });
      span.setAttributes(attributes);
      // The message is a status description, not an attribute: it is bounded, it is not indexed,
      // and it never becomes a metric label.
      span.setStatus("error", result.message);
    } else {
      attributes = aiSpanAttributes({ ...shared, status: "denied", outcome: result.reason });
      span.setAttributes(attributes);
      span.setStatus("error", result.message);
    }
    span.end();
  }
}

/** Creates a tool runtime. */
export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  return new InMemoryToolRuntime(options);
}
