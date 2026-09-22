/**
 * Typed errors for the agent runtime.
 *
 * Every failure a caller can act on has its own factory, and every factory uses
 * the platform error class whose *meaning* matches — not the one whose message is
 * easiest to write:
 *
 * - {@link NotFoundError} when a reference names something no registry holds. The
 *   caller's fix is to register it or correct the reference.
 * - {@link ConflictError} when the thing exists but its state refuses the
 *   operation: a duplicate registration, an illegal lifecycle move, an agent that
 *   is not active. The caller's fix is to change state, not to retry.
 * - {@link ValidationError} when the caller's own input is malformed. The
 *   caller's fix is to send something else.
 *
 * Nothing here throws a bare `Error`. A bare error carries no code, so a
 * consumer's retry policy, HTTP mapping and log redaction all fall back to
 * "unknown" — which is how a duplicate registration ends up being retried forever.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { describeAgentReference } from "@omnis/ai-core-types";
import type {
  AgentId,
  AgentReference,
  AgentStateName,
  AgentStatus,
  ExecutionId,
} from "@omnis/ai-core-types";

/** A referenced agent is not registered. */
export function agentNotFound(reference: AgentReference): NotFoundError {
  return new NotFoundError("agent", describeAgentReference(reference), {
    metadata: { reference: describeAgentReference(reference) },
  });
}

/** A referenced agent instance is not known to this runtime. */
export function agentInstanceNotFound(executionId: ExecutionId): NotFoundError {
  return new NotFoundError("agent-instance", String(executionId), {
    metadata: { executionId: String(executionId) },
  });
}

/** An agent with the same identifier or slug is already registered. */
export function duplicateAgent(conflict: string, detail: string): ConflictError {
  return new ConflictError(`agent:${conflict}`, detail);
}

/** A lifecycle move the agent state machine does not allow. */
export function illegalAgentStateTransition(
  agentId: AgentId,
  from: AgentStateName,
  to: AgentStateName,
  allowed: readonly AgentStateName[],
): ConflictError {
  return new ConflictError(
    `agent-state:${String(agentId)}:${from}->${to}`,
    `agent ${String(agentId)} cannot move from "${from}" to "${to}"; legal moves from "${from}" are ` +
      (allowed.length === 0
        ? "none, because the state is terminal"
        : allowed.map((state) => `"${state}"`).join(", ")),
    { metadata: { agentId: String(agentId), from, to, allowed: [...allowed] } },
  );
}

/** A status move the registration lifecycle does not allow. */
export function illegalAgentStatusTransition(
  agentId: AgentId,
  from: AgentStatus,
  to: AgentStatus,
  allowed: readonly AgentStatus[],
): ConflictError {
  return new ConflictError(
    `agent-status:${String(agentId)}:${from}->${to}`,
    `agent ${String(agentId)} cannot change status from "${from}" to "${to}"; legal moves are ` +
      (allowed.length === 0
        ? "none, because the status is terminal"
        : allowed.map((status) => `"${status}"`).join(", ")),
    { metadata: { agentId: String(agentId), from, to, allowed: [...allowed] } },
  );
}

/** An agent that is registered but may not run: only `active` agents execute. */
export function agentNotExecutable(
  agentId: AgentId,
  slug: string,
  status: AgentStatus,
): ConflictError {
  return new ConflictError(
    `agent:${String(agentId)}`,
    `agent "${slug}" has status "${status}", and only an active agent may run`,
    {
      metadata: { agentId: String(agentId), slug, status },
    },
  );
}

/**
 * A live execution cannot be paused.
 *
 * The kernel has no suspend primitive: a step is either running or finished, and
 * an executor holds no state between attempts that a pause could preserve. Saying
 * so is better than cancelling the run and calling it paused, which would report a
 * resumable state for work that has been destroyed.
 */
export function agentCannotPauseWhileRunning(
  executionId: ExecutionId,
  state: AgentStateName,
): ConflictError {
  return new ConflictError(
    `agent-execution:${String(executionId)}`,
    `execution ${String(executionId)} is "${state}" and cannot be paused; cancel it instead, or pause before the run starts`,
    { metadata: { executionId: String(executionId), state } },
  );
}

/** A plan the runtime was asked to run is not one it can build or accept. */
export function agentPlanRejected(agentId: AgentId, reasons: readonly string[]): ValidationError {
  return new ValidationError(
    `the plan for agent ${String(agentId)} was rejected: ${reasons.join("; ")}`,
    {
      metadata: { agentId: String(agentId), reasons: [...reasons] },
    },
  );
}

/** A run input the runtime cannot use. */
export function invalidAgentRunInput(reason: string): ValidationError {
  return new ValidationError(`agent run input is invalid: ${reason}`);
}

/** The runtime holds as many instances as it was configured to. */
export function agentInstanceCapacityExceeded(limit: number): ConflictError {
  return new ConflictError(
    "agent-instance:capacity",
    `the agent runtime already tracks ${String(limit)} instances; raise the limit or dispose of finished runs`,
    { metadata: { limit } },
  );
}
