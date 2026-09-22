/**
 * Deadlines.
 *
 * A deadline is an absolute instant plus the duration that produced it. Storing the
 * absolute instant is what makes deadlines survive being passed down a call tree: a
 * child that received "30 seconds" from its parent and then spent 12 seconds planning
 * must not hand the next child a fresh 30 seconds. `boundDeadline` is the rule — a
 * child deadline may be *shorter* than its parent's, never longer.
 *
 * Nothing here reads the clock itself. Every function takes `nowMs` as an argument, so
 * a test can walk a deadline's entire life — full, nearly elapsed, elapsed — without
 * waiting, and without the module ever scheduling a timer that could outlive the test.
 */

import { ValidationError } from "@omnis/errors";
import { toIso, type Clock } from "./Clock.js";

/** An absolute point in time by which work must finish. */
export interface Deadline {
  /** Absolute epoch milliseconds at which the deadline expires. */
  readonly atMs: number;
  /** The duration that produced it, kept so a record can say "this was a 30s budget". */
  readonly durationMs: number;
  /** When the deadline was created, in epoch milliseconds. */
  readonly createdAtMs: number;
}

/** Asserts a duration is usable as a deadline, and explains why not when it is not. */
export function assertDeadlineDuration(durationMs: number): void {
  if (!Number.isInteger(durationMs)) {
    throw new ValidationError(
      `deadline duration must be an integer number of milliseconds, received ${String(durationMs)}`,
      {
        issues: [
          {
            path: "deadlineMs",
            code: "invalid_type",
            message: "duration must be an integer",
            received: null,
          },
        ],
      },
    );
  }
  if (durationMs <= 0) {
    // A zero or negative deadline is already expired at creation. Accepting it would
    // produce an execution that fails before its first step, reported as a timeout —
    // which reads like an infrastructure problem instead of a caller mistake.
    throw new ValidationError(
      `deadline duration must be positive, received ${String(durationMs)}`,
      {
        issues: [
          {
            path: "deadlineMs",
            code: "out_of_range",
            message: "duration must be positive",
            received: durationMs,
          },
        ],
      },
    );
  }
}

/** Creates a deadline `durationMs` after `nowMs`. */
export function createDeadline(nowMs: number, durationMs: number): Deadline {
  assertDeadlineDuration(durationMs);
  if (!Number.isInteger(nowMs)) {
    throw new ValidationError(
      `deadline origin must be an integer number of milliseconds, received ${String(nowMs)}`,
    );
  }
  return Object.freeze({ atMs: nowMs + durationMs, durationMs, createdAtMs: nowMs });
}

/** Creates a deadline at an absolute instant, which must lie in the future. */
export function deadlineAt(nowMs: number, atMs: number): Deadline {
  if (!Number.isInteger(atMs)) {
    throw new ValidationError(
      `deadline instant must be an integer number of milliseconds, received ${String(atMs)}`,
    );
  }
  const durationMs = atMs - nowMs;
  assertDeadlineDuration(durationMs);
  return Object.freeze({ atMs, durationMs, createdAtMs: nowMs });
}

/**
 * Milliseconds left before the deadline, or `null` when there is no deadline.
 *
 * Clamped at zero: a negative remaining time would flow into `setTimeout` as an
 * immediate fire and into budget holds as a negative duration.
 */
export function remainingMs(deadline: Deadline | null, nowMs: number): number | null {
  if (deadline === null) {
    return null;
  }
  return Math.max(0, deadline.atMs - nowMs);
}

/** True when the deadline has passed. A missing deadline never expires. */
export function isExpired(deadline: Deadline | null, nowMs: number): boolean {
  return deadline !== null && deadline.atMs <= nowMs;
}

/** True when the deadline expires within the given horizon. */
export function expiresWithin(
  deadline: Deadline | null,
  nowMs: number,
  horizonMs: number,
): boolean {
  const remaining = remainingMs(deadline, nowMs);
  return remaining !== null && remaining <= horizonMs;
}

/** The deadline instant as a UTC ISO 8601 timestamp. */
export function deadlineIso(deadline: Deadline): string {
  return toIso(deadline.atMs);
}

/** The earlier of two deadlines, treating `null` as "no limit". */
export function earliestDeadline(left: Deadline | null, right: Deadline | null): Deadline | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left.atMs <= right.atMs ? left : right;
}

/**
 * The deadline a child scope actually gets.
 *
 * The parent's deadline is a ceiling that no child may raise: a child asking for an
 * hour inside a parent's ten seconds gets ten seconds. When the request is already
 * within the ceiling it is honored unchanged, so the recorded `durationMs` still says
 * what the caller asked for.
 */
export function boundDeadline(
  parent: Deadline | null,
  requested: Deadline | null,
): Deadline | null {
  if (requested === null) {
    // The child asked for no limit of its own, so it inherits the parent's deadline
    // object unchanged — identity preserved, so an audit row can see the two share it.
    return parent;
  }
  if (parent === null) {
    return requested;
  }
  if (requested.atMs <= parent.atMs) {
    // Within the ceiling: honored exactly as asked, so the recorded duration still says
    // what the caller requested.
    return requested;
  }
  // The parent's instant wins. Re-expressed as a deadline whose duration is the allowance
  // the child actually has, rather than the one it asked for.
  return Object.freeze({
    atMs: parent.atMs,
    durationMs: Math.max(1, parent.atMs - requested.createdAtMs),
    createdAtMs: requested.createdAtMs,
  });
}

/** Reads the remaining allowance through a clock. */
export function remainingMsAt(deadline: Deadline | null, clock: Clock): number | null {
  return remainingMs(deadline, clock());
}
