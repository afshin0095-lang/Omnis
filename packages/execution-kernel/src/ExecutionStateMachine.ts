/**
 * The execution lifecycle, as a table rather than as a series of `if` statements.
 *
 * The states come from `@omnis/ai-core-types`; what lives here is which moves between them are
 * legal. Writing the table down matters because the illegal moves are the interesting ones:
 *
 * - `created -> running` would skip validation, authorization and reservation. Governance states
 *   precede `running` precisely so that reaching `running` is *proof* policy and budget said yes,
 *   and a shortcut through the table would destroy that guarantee for every consumer.
 * - `authorized -> reserved` may be skipped when no budget applies, which is why `authorized ->
 *   planned` is also legal. Skipping a gate that does not exist is not the same as skipping a gate.
 * - `succeeded -> running` would let a finished execution be reopened, which would retroactively
 *   change what an audit reader already saw.
 * - `waiting -> running` is legal: waiting is a pause inside a run, not a terminal state.
 *
 * Every non-terminal state can also reach `failed`, `cancelled` and `timed_out`, because a
 * deadline or a cancellation can arrive at any point, including before the first step.
 */

import { illegalExecutionTransitionError, isTerminalExecutionStatus } from "@omnis/ai-core-types";
import type { ExecutionId, ExecutionStatus } from "@omnis/ai-core-types";

/** The legal moves out of each state. Terminal states have none. */
/** Freezes a transition list, keeping the literal statuses typed as statuses. */
function moves(...statuses: ExecutionStatus[]): readonly ExecutionStatus[] {
  return Object.freeze(statuses);
}

export const EXECUTION_STATUS_TRANSITIONS: Readonly<
  Record<ExecutionStatus, readonly ExecutionStatus[]>
> = Object.freeze({
  created: moves("validated", "failed", "cancelled", "timed_out"),
  validated: moves("authorized", "failed", "cancelled", "timed_out"),
  // `planned` is reachable from `authorized` for an execution with no budget to reserve.
  authorized: moves("reserved", "planned", "failed", "cancelled", "timed_out"),
  reserved: moves("planned", "failed", "cancelled", "timed_out"),
  planned: moves("running", "failed", "cancelled", "timed_out"),
  running: moves("waiting", "succeeded", "failed", "cancelled", "timed_out"),
  waiting: moves("running", "succeeded", "failed", "cancelled", "timed_out"),
  succeeded: moves(),
  failed: moves(),
  cancelled: moves(),
  timed_out: moves(),
});

/** True when the move is allowed. */
export function isLegalExecutionStatusTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
): boolean {
  return (EXECUTION_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** The states reachable from one state. */
export function legalExecutionTransitions(from: ExecutionStatus): readonly ExecutionStatus[] {
  return EXECUTION_STATUS_TRANSITIONS[from] ?? [];
}

/**
 * Returns the destination state, or throws the typed contract error.
 *
 * Throwing rather than returning `null` is deliberate: an illegal transition is a bug in the
 * kernel's own sequencing, not a condition a caller can recover from, and a bug that quietly
 * leaves an execution in the wrong state is far harder to find than one that stops the run.
 */
export function assertExecutionStatusTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
  executionId: ExecutionId,
): ExecutionStatus {
  if (isTerminalExecutionStatus(from)) {
    throw illegalExecutionTransitionError(from, to, executionId);
  }
  if (!isLegalExecutionStatusTransition(from, to)) {
    throw illegalExecutionTransitionError(from, to, executionId);
  }
  return to;
}

/**
 * The governance states an execution must pass through, in order.
 *
 * Published so a caller can tell how far an execution got without knowing the table: the index of
 * a status in this list is how much of the pre-flight pipeline it cleared.
 */
export const EXECUTION_GATE_SEQUENCE: readonly ExecutionStatus[] = moves(
  "created",
  "validated",
  "authorized",
  "reserved",
  "planned",
  "running",
);

/** How many gates an execution cleared, from `0` to the length of {@link EXECUTION_GATE_SEQUENCE}. */
export function gatesCleared(status: ExecutionStatus): number {
  const index = EXECUTION_GATE_SEQUENCE.indexOf(status);
  if (index < 0) {
    // A terminal state cleared every gate it was going to clear.
    return EXECUTION_GATE_SEQUENCE.length;
  }
  return index;
}
