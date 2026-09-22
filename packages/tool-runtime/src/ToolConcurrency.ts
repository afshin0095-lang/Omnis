/**
 * Per-tool concurrency accounting.
 *
 * A tool declares `maxConcurrency` because it wraps something that cannot be overlapped: a
 * rate-limited API, a file lock, a browser session, a device. The gate below is the only place
 * that number is enforced, and it enforces it by refusing rather than queueing.
 *
 * Refusing is the honest behaviour for an execution kernel. A queue inside the gate would hide
 * latency from the deadline that bounds the step, and two steps waiting on each other's tools
 * would deadlock with nothing to cancel them. The caller sees "at its concurrency limit" and can
 * retry, reschedule or fail the step — decisions that belong to the caller, not to a counter.
 */

import type { ToolId } from "@omnis/ai-core-types";

/** In-flight count for one tool. */
export interface ConcurrencySnapshot {
  readonly toolId: ToolId;
  readonly inFlight: number;
}

/** A gate that counts in-flight invocations per tool. */
export interface ConcurrencyGate {
  /**
   * Takes a slot if one is free.
   *
   * Returns `false` when the tool is already at `maxConcurrency`. A `false` result takes
   * nothing, so there is no slot to release.
   */
  tryAcquire(toolId: ToolId, maxConcurrency: number): boolean;

  /** Gives a slot back. Ignored when the tool has none in flight, so it is safe in a `finally`. */
  release(toolId: ToolId): void;

  /** Number of invocations of one tool currently in flight. */
  inFlight(toolId: ToolId): number;

  /** Every tool with a slot taken, ordered by identifier. */
  snapshot(): readonly ConcurrencySnapshot[];

  /** Releases every slot. Used when a runtime is disposed mid-flight. */
  releaseAll(): void;
}

/** Creates a gate. Counters live in a Map; nothing is global and nothing outlives the gate. */
export function createConcurrencyGate(): ConcurrencyGate {
  const counts = new Map<ToolId, number>();

  return {
    tryAcquire(toolId: ToolId, maxConcurrency: number): boolean {
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
        throw new RangeError(
          `maxConcurrency must be a positive integer, received ${String(maxConcurrency)}`,
        );
      }
      const current = counts.get(toolId) ?? 0;
      if (current >= maxConcurrency) {
        return false;
      }
      counts.set(toolId, current + 1);
      return true;
    },

    release(toolId: ToolId): void {
      const current = counts.get(toolId) ?? 0;
      if (current <= 1) {
        counts.delete(toolId);
        return;
      }
      counts.set(toolId, current - 1);
    },

    inFlight(toolId: ToolId): number {
      return counts.get(toolId) ?? 0;
    },

    snapshot(): readonly ConcurrencySnapshot[] {
      return Object.freeze(
        [...counts.entries()]
          .map(([toolId, inFlight]) => Object.freeze({ toolId, inFlight }))
          .sort((left, right) => left.toolId.localeCompare(right.toolId)),
      );
    },

    releaseAll(): void {
      counts.clear();
    },
  };
}
