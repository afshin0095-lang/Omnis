/**
 * The execution context factory.
 *
 * One place that knows the defaults: which clock reads time, what an execution's default
 * deadline is, which mode and priority apply when a caller does not choose, and what
 * metadata every execution in this process carries (deployment, region, build). Injecting
 * those once, at composition time, is what keeps them out of the call sites — a kernel
 * that passed `Date.now()` and a hard-coded 30 s timeout into every scope would be
 * untestable and would drift from the runtime's configured policy.
 *
 * The factory is small on purpose. It creates roots, creates children and exposes its
 * clock; it does not track live scopes, schedule timeouts or hold a registry. Tracking
 * live executions is the kernel's job, where it belongs to a lifecycle with explicit
 * start and end; a factory that quietly accumulated scopes would leak one per execution.
 */

import type { ExecutionMode, ExecutionPriority } from "@omnis/ai-core-types";
import type { CancellationToken } from "./Cancellation.js";
import { NEVER_CANCELLED } from "./Cancellation.js";
import { systemClock, toIso, type Clock } from "./Clock.js";
import { newCorrelationId } from "./Correlation.js";
import { createDeadline } from "./Deadline.js";
import type { ExecutionContext } from "./ExecutionContext.js";
import {
  composeContext,
  DEFAULT_SCOPE_MODE,
  DEFAULT_SCOPE_PRIORITY,
  ExecutionScope,
} from "./ExecutionScope.js";
import type { ScopeDependencies, ScopeOptions } from "./ExecutionScope.js";
import { sanitizeMetadata } from "./ExecutionMetadata.js";
import { createExecutionId } from "@omnis/ai-core-types";

/** How a factory is configured. */
export interface ExecutionContextFactoryOptions {
  /** Time source. Defaults to the system clock; tests inject a controllable one. */
  readonly clock?: Clock;
  /** Allowance given to executions that do not ask for one. `null` means unbounded. */
  readonly defaultDeadlineMs?: number | null;
  readonly defaultMode?: ExecutionMode;
  readonly defaultPriority?: ExecutionPriority;
  /** Metadata attached to every context this factory creates, e.g. deployment facts. */
  readonly baseMetadata?: Readonly<Record<string, unknown>>;
}

/** What a caller may ask the factory for when creating a bare context. */
export interface CreateContextOptions extends ScopeOptions {
  /** Token to attach. Defaults to a token that never cancels. */
  readonly cancellation?: CancellationToken;
}

/** Creates contexts and scopes with one set of defaults. */
export interface ExecutionContextFactory {
  /** The clock every context created here is timed against. */
  readonly clock: Clock;
  /** The allowance given to contexts that do not request one, or `null`. */
  readonly defaultDeadlineMs: number | null;
  readonly defaultMode: ExecutionMode;
  readonly defaultPriority: ExecutionPriority;

  /**
   * Creates a bare root context.
   *
   * The result is *not* cancellable by OMNIS unless the caller supplies a token: there is
   * no owner holding a write side. Use {@link createRootScope} when the caller intends to
   * be able to cancel — which is every execution the kernel runs.
   */
  createContext(options?: CreateContextOptions): ExecutionContext;

  /** Opens a root scope: a new correlation, an owned cancellation source. */
  createRootScope(options?: ScopeOptions): ExecutionScope;

  /** Opens a child scope of an existing scope, inheriting identity and bounding the deadline. */
  createChildScope(parent: ExecutionScope, options?: ScopeOptions): ExecutionScope;

  /** Opens a child scope of a bare context. */
  createChildScopeOfContext(parent: ExecutionContext, options?: ScopeOptions): ExecutionScope;

  /** The dependencies a scope must be created with to inherit this factory's defaults. */
  scopeDependencies(): ScopeDependencies;
}

/** Creates a factory. Defaults are resolved once, here, not at every call site. */
export function createExecutionContextFactory(
  options: ExecutionContextFactoryOptions = {},
): ExecutionContextFactory {
  const clock = options.clock ?? systemClock;
  const defaultDeadlineMs = options.defaultDeadlineMs ?? null;
  const defaultMode = options.defaultMode ?? DEFAULT_SCOPE_MODE;
  const defaultPriority = options.defaultPriority ?? DEFAULT_SCOPE_PRIORITY;
  const baseMetadata = sanitizeMetadata(options.baseMetadata ?? {}, "factory base metadata");

  const dependencies: ScopeDependencies = Object.freeze({
    clock,
    defaultDeadlineMs,
    defaultMode,
    defaultPriority,
    baseMetadata,
  });

  return Object.freeze({
    clock,
    defaultDeadlineMs,
    defaultMode,
    defaultPriority,

    createContext(createOptions: CreateContextOptions = {}): ExecutionContext {
      const startedAtMs = clock();
      const cancellation = createOptions.cancellation ?? NEVER_CANCELLED;
      const deadline = resolveContextDeadline(createOptions, defaultDeadlineMs, startedAtMs);
      return composeContext({
        executionId: createOptions.executionId ?? createExecutionId(),
        correlationId: createOptions.correlationId ?? newCorrelationId(),
        causationId: createOptions.causationId ?? null,
        parentExecutionId: null,
        tenantId: createOptions.tenantId ?? null,
        agentId: createOptions.agentId ?? null,
        requestId: createOptions.requestId ?? null,
        traceId: createOptions.traceId ?? null,
        parentSpanId: createOptions.parentSpanId ?? null,
        startedAtMs,
        deadline,
        cancellation,
        priority: createOptions.priority ?? defaultPriority,
        mode: createOptions.mode ?? defaultMode,
        depth: 0,
        metadata:
          createOptions.metadata === undefined
            ? baseMetadata
            : sanitizeMetadata({ ...baseMetadata, ...createOptions.metadata }, "context metadata"),
      });
    },

    createRootScope(scopeOptions: ScopeOptions = {}): ExecutionScope {
      return ExecutionScope.createRoot(scopeOptions, dependencies);
    },

    createChildScope(parent: ExecutionScope, scopeOptions: ScopeOptions = {}): ExecutionScope {
      return ExecutionScope.createChild(parent, scopeOptions, dependencies);
    },

    createChildScopeOfContext(
      parent: ExecutionContext,
      scopeOptions: ScopeOptions = {},
    ): ExecutionScope {
      return ExecutionScope.createChildOfContext(parent, scopeOptions, dependencies);
    },

    scopeDependencies(): ScopeDependencies {
      return dependencies;
    },
  });
}

/**
 * Creates a single context without a factory.
 *
 * For the caller that needs one context and has no composition root — a test, or a
 * boundary adapter translating an inbound command. Anything that creates contexts in a
 * loop should hold a factory, so its defaults are declared once.
 */
export function createExecutionContext(
  options: CreateContextOptions = {},
  factoryOptions: ExecutionContextFactoryOptions = {},
): ExecutionContext {
  return createExecutionContextFactory(factoryOptions).createContext(options);
}

/** Formats an epoch-millisecond reading as the ISO timestamp a record stores. */
export function startedAtIso(startedAtMs: number): string {
  return toIso(startedAtMs);
}

/** Resolves a bare context's deadline from the request or the factory default. */
function resolveContextDeadline(
  options: CreateContextOptions,
  defaultDeadlineMs: number | null,
  nowMs: number,
) {
  if (options.deadline !== undefined) {
    return options.deadline;
  }
  if (options.deadlineMs !== undefined) {
    return options.deadlineMs === null ? null : createDeadline(nowMs, options.deadlineMs);
  }
  return defaultDeadlineMs === null ? null : createDeadline(nowMs, defaultDeadlineMs);
}
