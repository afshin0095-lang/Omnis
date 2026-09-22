/**
 * Execution scopes: a context plus the authority to cancel it.
 *
 * A context is a *description*; a scope is an *owner*. The split exists because the two
 * travel in different directions: the context is handed down to models, tools and
 * evaluations (read-only, so nothing downstream can cancel anybody else's work), while
 * the scope stays with whoever started the execution and is the only holder of
 * `cancel()`.
 *
 * A child scope:
 * - inherits the correlation identifier unchanged,
 * - records its parent execution as `parentExecutionId` (not as causation — see
 *   `Correlation.ts`),
 * - receives a deadline bounded by its parent's, so a child can never outlive the
 *   execution it belongs to,
 * - is cancelled when its parent is cancelled, and detaches from its parent when it
 *   finishes, so a long-lived root does not accumulate references to completed children,
 * - gets a *copy* of the parent metadata, so its own annotations stay its own.
 *
 * `dispose()` cancels. Leaving a scope without disposing it means work is still running
 * that nobody intends to wait for, and the honest reading of "the owner stopped caring"
 * is "stop the work" — not "keep spending budget in the background".
 */

import type {
  AgentId,
  AiCoreMetadata,
  CausationId,
  CorrelationId,
  ExecutionId,
  ExecutionMode,
  ExecutionPriority,
  SpanId,
  TenantId,
  TraceId,
} from "@omnis/ai-core-types";
import {
  createExecutionId,
  deadlineExceededError,
  executionCancelledError,
} from "@omnis/ai-core-types";
import type { CancellationToken, CancellationSource } from "./Cancellation.js";
import { createCancellationSource } from "./Cancellation.js";
import { systemClock, toIso, type Clock } from "./Clock.js";
import { inheritCorrelation, newCorrelationId } from "./Correlation.js";
import {
  boundDeadline,
  createDeadline,
  isExpired,
  remainingMs,
  type Deadline,
} from "./Deadline.js";
import type { ExecutionContext } from "./ExecutionContext.js";
import { mergeMetadata, sanitizeMetadata } from "./ExecutionMetadata.js";

/** What a caller may specify when opening a scope. Everything has a default. */
export interface ScopeOptions {
  /** Reuse an existing identifier, e.g. one already recorded by an inbound command. */
  readonly executionId?: ExecutionId;
  readonly correlationId?: CorrelationId;
  readonly causationId?: CausationId | null;
  readonly tenantId?: TenantId | null;
  readonly agentId?: AgentId | null;
  readonly requestId?: string | null;
  readonly traceId?: TraceId | null;
  readonly parentSpanId?: SpanId | null;
  readonly mode?: ExecutionMode;
  readonly priority?: ExecutionPriority;
  /** Relative allowance in milliseconds. Bounded by the parent's deadline. */
  readonly deadlineMs?: number | null;
  /** Absolute deadline. Bounded by the parent's deadline. */
  readonly deadline?: Deadline | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Attach an externally-owned token instead of creating one. */
  readonly cancellation?: CancellationToken;
}

/** The ambient inputs a scope needs, injectable for deterministic tests. */
export interface ScopeDependencies {
  readonly clock?: Clock;
  readonly defaultDeadlineMs?: number | null;
  readonly defaultMode?: ExecutionMode;
  readonly defaultPriority?: ExecutionPriority;
  /** Metadata applied to every scope created with these dependencies. */
  readonly baseMetadata?: Readonly<Record<string, unknown>>;
}

/** The resolved inputs used to compose a context. Internal to this package. */
export interface ComposedContextInput {
  readonly executionId: ExecutionId;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
  readonly parentExecutionId: ExecutionId | null;
  readonly tenantId: TenantId | null;
  readonly agentId: AgentId | null;
  readonly requestId: string | null;
  readonly traceId: TraceId | null;
  readonly parentSpanId: SpanId | null;
  readonly startedAtMs: number;
  readonly deadline: Deadline | null;
  readonly cancellation: CancellationToken;
  readonly priority: ExecutionPriority;
  readonly mode: ExecutionMode;
  readonly depth: number;
  readonly metadata: AiCoreMetadata;
}

/** Freezes a composed context. Kept separate so the factory and the scope agree on one shape. */
export function composeContext(input: ComposedContextInput): ExecutionContext {
  return Object.freeze({
    executionId: input.executionId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    parentExecutionId: input.parentExecutionId,
    tenantId: input.tenantId,
    agentId: input.agentId,
    requestId: input.requestId,
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    startedAt: toIso(input.startedAtMs),
    startedAtMs: input.startedAtMs,
    deadline: input.deadline,
    cancellation: input.cancellation,
    priority: input.priority,
    mode: input.mode,
    depth: input.depth,
    metadata: input.metadata,
  });
}

/** The default mode for a scope whose caller did not choose one. */
export const DEFAULT_SCOPE_MODE: ExecutionMode = "interactive";

/** The default priority for a scope whose caller did not choose one. */
export const DEFAULT_SCOPE_PRIORITY: ExecutionPriority = "normal";

/**
 * An owned execution: one immutable context plus the authority to cancel it.
 *
 * Instances are created through {@link ExecutionScope.createRoot} or
 * {@link ExecutionScope.createChild}; the constructor is private so that a scope cannot
 * exist without a cancellation source, which is the invariant the kernel relies on when
 * it implements `cancelExecution`.
 */
export class ExecutionScope {
  readonly context: ExecutionContext;
  private readonly source: CancellationSource;
  private readonly clock: Clock;
  private disposed: boolean;

  private constructor(context: ExecutionContext, source: CancellationSource, clock: Clock) {
    this.context = context;
    this.source = source;
    this.clock = clock;
    this.disposed = false;
  }

  /** Opens a root scope: a new correlation, no parent, cancellation owned here. */
  static createRoot(
    options: ScopeOptions = {},
    dependencies: ScopeDependencies = {},
  ): ExecutionScope {
    const clock = dependencies.clock ?? systemClock;
    const startedAtMs = clock();
    const source = createCancellationSource(options.cancellation ?? null);
    const deadline = resolveDeadline(null, options, dependencies, startedAtMs);
    const context = composeContext({
      executionId: options.executionId ?? createExecutionId(),
      correlationId: options.correlationId ?? newCorrelationId(),
      causationId: options.causationId ?? null,
      parentExecutionId: null,
      tenantId: options.tenantId ?? null,
      agentId: options.agentId ?? null,
      requestId: options.requestId ?? null,
      traceId: options.traceId ?? null,
      parentSpanId: options.parentSpanId ?? null,
      startedAtMs,
      deadline,
      cancellation: source.token,
      priority: options.priority ?? dependencies.defaultPriority ?? DEFAULT_SCOPE_PRIORITY,
      mode: options.mode ?? dependencies.defaultMode ?? DEFAULT_SCOPE_MODE,
      depth: 0,
      metadata: composeMetadata(null, options, dependencies),
    });
    return new ExecutionScope(context, source, clock);
  }

  /** Opens a child scope of an existing scope, inheriting identity and bounding the deadline. */
  static createChild(
    parent: ExecutionScope,
    options: ScopeOptions = {},
    dependencies: ScopeDependencies = {},
  ): ExecutionScope {
    const clock = dependencies.clock ?? parent.clock;
    const startedAtMs = clock();
    const parentContext = parent.context;
    const source = createCancellationSource(options.cancellation ?? parentContext.cancellation);
    const deadline = resolveDeadline(parentContext.deadline, options, dependencies, startedAtMs);
    const context = composeContext({
      executionId: options.executionId ?? createExecutionId(),
      // Inherited, never regenerated: see Correlation.ts.
      correlationId: inheritCorrelation(parentContext.correlationId),
      causationId: options.causationId ?? null,
      parentExecutionId: parentContext.executionId,
      tenantId: options.tenantId ?? parentContext.tenantId,
      agentId: options.agentId ?? parentContext.agentId,
      requestId: options.requestId ?? parentContext.requestId,
      traceId: options.traceId ?? parentContext.traceId,
      parentSpanId: options.parentSpanId ?? parentContext.parentSpanId,
      startedAtMs,
      deadline,
      cancellation: source.token,
      priority: options.priority ?? parentContext.priority,
      mode: options.mode ?? parentContext.mode,
      depth: parentContext.depth + 1,
      metadata: composeMetadata(parentContext.metadata, options, dependencies),
    });
    return new ExecutionScope(context, source, clock);
  }

  /**
   * Opens a child scope of a bare context.
   *
   * Used when the caller holds a context rather than a scope — for example a context
   * received from another package's API — and still needs its own cancellable unit.
   */
  static createChildOfContext(
    parentContext: ExecutionContext,
    options: ScopeOptions = {},
    dependencies: ScopeDependencies = {},
  ): ExecutionScope {
    const clock = dependencies.clock ?? systemClock;
    const startedAtMs = clock();
    const source = createCancellationSource(options.cancellation ?? parentContext.cancellation);
    const context = composeContext({
      executionId: options.executionId ?? createExecutionId(),
      correlationId: inheritCorrelation(parentContext.correlationId),
      causationId: options.causationId ?? null,
      parentExecutionId: parentContext.executionId,
      tenantId: options.tenantId ?? parentContext.tenantId,
      agentId: options.agentId ?? parentContext.agentId,
      requestId: options.requestId ?? parentContext.requestId,
      traceId: options.traceId ?? parentContext.traceId,
      parentSpanId: options.parentSpanId ?? parentContext.parentSpanId,
      startedAtMs,
      deadline: resolveDeadline(parentContext.deadline, options, dependencies, startedAtMs),
      cancellation: source.token,
      priority: options.priority ?? parentContext.priority,
      mode: options.mode ?? parentContext.mode,
      depth: parentContext.depth + 1,
      metadata: composeMetadata(parentContext.metadata, options, dependencies),
    });
    return new ExecutionScope(context, source, clock);
  }

  /** True when cancellation has been requested for this scope. */
  get cancelled(): boolean {
    return this.context.cancellation.cancelled;
  }

  /** The reason for cancellation, or `null`. */
  get cancellationReason(): string | null {
    return this.context.cancellation.reason;
  }

  /** True once {@link dispose} has run. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The current reading of this scope's clock, in epoch milliseconds. */
  now(): number {
    return this.clock();
  }

  /** Milliseconds left on this scope's deadline, or `null` when unbounded. */
  remainingMs(): number | null {
    return remainingMs(this.context.deadline, this.clock());
  }

  /** True when this scope's deadline has passed. */
  isExpired(): boolean {
    return isExpired(this.context.deadline, this.clock());
  }

  /**
   * Requests cancellation.
   *
   * Idempotent, and propagates to every child scope linked to this one. When the scope
   * was created with an externally-owned token, cancelling here stops this scope and
   * everything under it without touching the external token's other listeners.
   */
  cancel(reason: string): void {
    this.source.cancel(reason);
  }

  /**
   * Releases the scope: detaches from the parent token, drops listeners and cancels any
   * work still running under it. Idempotent.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (!this.source.cancelled) {
      this.source.cancel("scope disposed");
    }
    this.source.dispose();
  }

  /** Throws the typed error for whichever condition makes this scope unusable. */
  throwIfUnusable(): void {
    this.context.cancellation.throwIfCancelled();
    const deadline = this.context.deadline;
    if (deadline !== null && isExpired(deadline, this.clock())) {
      throw deadlineExceededError(this.context.executionId, deadline.durationMs);
    }
  }

  /** Throws the typed cancellation error when this scope has been cancelled. */
  throwIfCancelled(): void {
    if (this.context.cancellation.cancelled) {
      throw executionCancelledError(
        this.context.executionId,
        this.context.cancellation.reason ?? "cancelled",
      );
    }
  }

  /** Opens a child scope of this one. */
  child(options: ScopeOptions = {}, dependencies: ScopeDependencies = {}): ExecutionScope {
    return ExecutionScope.createChild(this, options, { clock: this.clock, ...dependencies });
  }
}

/** Resolves the deadline for a new scope, bounded by the parent's and by the defaults. */
function resolveDeadline(
  parentDeadline: Deadline | null,
  options: ScopeOptions,
  dependencies: ScopeDependencies,
  nowMs: number,
): Deadline | null {
  const requested: Deadline | null =
    options.deadline ??
    (options.deadlineMs === undefined
      ? dependencies.defaultDeadlineMs === undefined || dependencies.defaultDeadlineMs === null
        ? null
        : createDeadline(nowMs, dependencies.defaultDeadlineMs)
      : options.deadlineMs === null
        ? null
        : createDeadline(nowMs, options.deadlineMs));
  return boundDeadline(parentDeadline, requested);
}

/** Builds a scope's metadata from the base, the parent's bag and the caller's patch. */
function composeMetadata(
  parentMetadata: AiCoreMetadata | null,
  options: ScopeOptions,
  dependencies: ScopeDependencies,
): AiCoreMetadata {
  const base = sanitizeMetadata(dependencies.baseMetadata ?? {}, "scope base metadata");
  const inherited = parentMetadata === null ? base : mergeMetadata(parentMetadata, base);
  return options.metadata === undefined ? inherited : mergeMetadata(inherited, options.metadata);
}
