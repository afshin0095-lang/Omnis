/**
 * Execution hooks.
 *
 * Hooks are how the rest of the platform observes a run without the kernel knowing it exists: an
 * event publisher emits `ai.*` events, an audit writer appends rows, a metrics recorder counts
 * attempts, Studio streams progress to a browser. None of that belongs in the kernel, and none of
 * it should be able to break one.
 *
 * That last point is enforced here rather than hoped for. A hook that throws is recorded as a
 * timeline note and execution continues: an observability hook must never be able to fail the work
 * it is observing. The one thing a hook cannot do is change the outcome — hooks receive frozen
 * records and return nothing.
 */

import type {
  ExecutionAttempt,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStep,
  PlanId,
} from "@omnis/ai-core-types";
import type { ExecutionId } from "@omnis/types";
import type { StepEnvironment } from "./StepExecutor.js";

/** One status move, as a hook sees it. */
export interface StatusChange {
  readonly executionId: ExecutionId;
  readonly from: ExecutionStatus;
  readonly to: ExecutionStatus;
  readonly at: string;
  readonly note: string | null;
  readonly stepId: string | null;
}

/** One decision to retry, as a hook sees it. */
export interface RetryDecision {
  readonly executionId: ExecutionId;
  readonly stepId: string;
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly delayMs: number;
  readonly failureCode: string;
  readonly failureClass: string;
}

/** Where a hook failed, for the timeline note that records it. */
export type HookPoint =
  | "beforeExecution"
  | "afterExecution"
  | "beforeStep"
  | "afterStep"
  | "onStatusChange"
  | "onRetry"
  | "onHookError";

/** The observation points a hook may implement. All are optional. */
export interface ExecutionHooks {
  /** Called once, after the record is created and before the first gate. */
  beforeExecution?(record: ExecutionRecord): void | Promise<void>;
  /** Called once, after the record reached a terminal state. */
  afterExecution?(record: ExecutionRecord): void | Promise<void>;
  /** Called before each attempt at a step. */
  beforeStep?(step: ExecutionStep, environment: StepEnvironment): void | Promise<void>;
  /** Called after each attempt at a step, with the attempt row that was recorded. */
  afterStep?(step: ExecutionStep, attempt: ExecutionAttempt): void | Promise<void>;
  /** Called on every status move, including the terminal one. */
  onStatusChange?(change: StatusChange): void | Promise<void>;
  /** Called when the kernel decides to try a step again. */
  onRetry?(decision: RetryDecision): void | Promise<void>;
  /** Called when another hook threw. Never called for its own failure. */
  onHookError?(
    point: HookPoint,
    error: unknown,
    executionId: ExecutionId | null,
  ): void | Promise<void>;
}

/** Hooks that observe nothing. The default, so a kernel always has something to call. */
export const NOOP_HOOKS: ExecutionHooks = Object.freeze({});

/**
 * Runs several hook sets as one, in the order given.
 *
 * Order matters and is the caller's: an event publisher composed before an audit writer sees the
 * execution first, which is what a consumer reading a stream before a query expects.
 */
export function compositeHooks(...hookSets: readonly ExecutionHooks[]): ExecutionHooks {
  const sets = hookSets.filter((hooks) => hooks !== NOOP_HOOKS);
  if (sets.length === 0) {
    return NOOP_HOOKS;
  }
  if (sets.length === 1) {
    return sets[0] ?? NOOP_HOOKS;
  }
  const composite: ExecutionHooks = {
    beforeExecution: async (record) => {
      for (const hooks of sets) {
        await hooks.beforeExecution?.(record);
      }
    },
    afterExecution: async (record) => {
      for (const hooks of sets) {
        await hooks.afterExecution?.(record);
      }
    },
    beforeStep: async (step, environment) => {
      for (const hooks of sets) {
        await hooks.beforeStep?.(step, environment);
      }
    },
    afterStep: async (step, attempt) => {
      for (const hooks of sets) {
        await hooks.afterStep?.(step, attempt);
      }
    },
    onStatusChange: async (change) => {
      for (const hooks of sets) {
        await hooks.onStatusChange?.(change);
      }
    },
    onRetry: async (decision) => {
      for (const hooks of sets) {
        await hooks.onRetry?.(decision);
      }
    },
    onHookError: async (point, error, executionId) => {
      for (const hooks of sets) {
        await hooks.onHookError?.(point, error, executionId);
      }
    },
  };
  return Object.freeze(composite);
}

/** A hook set that records everything it was called with. Useful in tests and in Studio. */
export interface CollectingHooks extends ExecutionHooks {
  readonly records: readonly ExecutionRecord[];
  readonly changes: readonly StatusChange[];
  readonly steps: readonly { readonly step: ExecutionStep; readonly attempt: ExecutionAttempt }[];
  readonly retries: readonly RetryDecision[];
  readonly hookErrors: readonly { readonly point: HookPoint; readonly message: string }[];
}

/** Builds hooks that collect what they observe, bounded so a long run cannot grow without limit. */
export function collectingHooks(limit = 1_000): CollectingHooks {
  const records: ExecutionRecord[] = [];
  const changes: StatusChange[] = [];
  const steps: { step: ExecutionStep; attempt: ExecutionAttempt }[] = [];
  const retries: RetryDecision[] = [];
  const hookErrors: { point: HookPoint; message: string }[] = [];

  const push = <T>(list: T[], value: T): void => {
    if (list.length < limit) {
      list.push(value);
    }
  };

  return {
    beforeExecution: (record) => {
      push(records, record);
    },
    afterExecution: (record) => {
      push(records, record);
    },
    afterStep: (step, attempt) => {
      push(steps, { step, attempt });
    },
    onStatusChange: (change) => {
      push(changes, change);
    },
    onRetry: (decision) => {
      push(retries, decision);
    },
    onHookError: (point, error) => {
      push(hookErrors, { point, message: error instanceof Error ? error.message : String(error) });
    },
    get records(): readonly ExecutionRecord[] {
      return records;
    },
    get changes(): readonly StatusChange[] {
      return changes;
    },
    get steps(): readonly { readonly step: ExecutionStep; readonly attempt: ExecutionAttempt }[] {
      return steps;
    },
    get retries(): readonly RetryDecision[] {
      return retries;
    },
    get hookErrors(): readonly { readonly point: HookPoint; readonly message: string }[] {
      return hookErrors;
    },
  };
}

/** The identifier of the plan a record holds, or `null`. */
export function planIdOf(record: ExecutionRecord): PlanId | null {
  return record.plan === null ? null : record.plan.id;
}
