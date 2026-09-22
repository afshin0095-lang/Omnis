/**
 * The agent lifecycle: a state machine, not a status string.
 *
 * WHY A TABLE RATHER THAN `setState`
 * ----------------------------------
 * An agent's state is the single fact an operator, a budget check and an audit
 * reader all consult. If any code path can assign it, then "the agent is running"
 * means "some code said so", and the three readers will disagree. A transition
 * table makes the legal moves data: one place to review, one place to test, and a
 * typed error at every illegal attempt rather than a silent overwrite.
 *
 * `waiting` AND `paused` ARE DIFFERENT STATES
 * -------------------------------------------
 * `waiting` is the agent blocked on something *it* asked for — a tool result, an
 * approval, a model response. `paused` is an operator or the runtime suspending it
 * from outside. Merging them would make "resume" ambiguous: one resumes by
 * delivering what was asked for, the other by an explicit command, and a runtime
 * that cannot tell them apart will resume an agent nobody approved.
 *
 * TERMINAL STATES ABSORB EVERYTHING
 * ---------------------------------
 * `completed`, `failed` and `cancelled` have no outgoing moves. A finished agent
 * that can be moved back to `running` is a finished agent whose audit trail can be
 * rewritten, and a budget that was settled against it can be charged again.
 */

import { isTerminalAgentState } from "@omnis/ai-core-types";
import type { AgentStateName, AgentStatus } from "@omnis/ai-core-types";
import type { AgentId } from "@omnis/ai-core-types";
import { illegalAgentStateTransition, illegalAgentStatusTransition } from "./errors.js";

/**
 * The legal moves between agent states.
 *
 * Read as: from `created` an agent may become `ready` (its descriptor is accepted
 * and it can be planned), or be cancelled or failed before it ever ran. From
 * `ready` it may plan, run directly (a reactive agent has nothing to plan), be
 * paused by an operator, or be cancelled. `planning` may produce work (`running`),
 * block on something it asked for (`waiting`), be paused, fail or be cancelled.
 * `running` may block, be paused, or reach a terminal state. `waiting` may resume
 * into `running`, be paused, fail or be cancelled — it may not go back to
 * `planning`, because the plan it is executing already exists. `paused` may return
 * to `ready` (restart the decision) or to `running` (continue where it stopped),
 * or be cancelled or failed while suspended.
 */
/** Freezes a list of destinations without widening its element type to `string`. */
function moves(...states: readonly AgentStateName[]): readonly AgentStateName[] {
  return Object.freeze([...states]);
}

/** Freezes a list of statuses without widening its element type to `string`. */
function statusMoves(...statuses: readonly AgentStatus[]): readonly AgentStatus[] {
  return Object.freeze([...statuses]);
}

export const AGENT_STATE_TRANSITIONS: Readonly<Record<AgentStateName, readonly AgentStateName[]>> =
  Object.freeze({
    created: moves("ready", "failed", "cancelled"),
    ready: moves("planning", "running", "paused", "failed", "cancelled"),
    planning: moves("running", "waiting", "paused", "failed", "cancelled"),
    running: moves("waiting", "paused", "completed", "failed", "cancelled"),
    waiting: moves("running", "paused", "failed", "cancelled"),
    paused: moves("ready", "running", "failed", "cancelled"),
    completed: moves(),
    failed: moves(),
    cancelled: moves(),
  });

/**
 * The legal moves between registration statuses.
 *
 * `retired` is terminal: a retired agent stays retired, so a configuration that
 * still names it fails loudly instead of quietly running a version somebody
 * deliberately withdrew.
 */
export const AGENT_STATUS_TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> =
  Object.freeze({
    draft: statusMoves("active", "disabled", "retired"),
    active: statusMoves("disabled", "retired"),
    disabled: statusMoves("active", "retired"),
    retired: statusMoves(),
  });

/** True when the move is allowed. A move to the state the agent is already in is not a move. */
export function isLegalAgentStateTransition(from: AgentStateName, to: AgentStateName): boolean {
  if (from === to) {
    return false;
  }
  return (AGENT_STATE_TRANSITIONS[from] ?? []).includes(to);
}

/** The states reachable from one state. */
export function legalAgentTransitions(from: AgentStateName): readonly AgentStateName[] {
  return AGENT_STATE_TRANSITIONS[from] ?? [];
}

/** True when the status move is allowed. */
export function isLegalAgentStatusTransition(from: AgentStatus, to: AgentStatus): boolean {
  if (from === to) {
    return false;
  }
  return (AGENT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** The statuses reachable from one status. */
export function legalAgentStatusTransitions(from: AgentStatus): readonly AgentStatus[] {
  return AGENT_STATUS_TRANSITIONS[from] ?? [];
}

/**
 * Returns the destination state, or throws {@link illegalAgentStateTransition}.
 *
 * Throwing rather than returning `null` is deliberate: an illegal move is a bug in
 * the caller's sequencing, and a bug that quietly leaves an agent in the wrong
 * state is diagnosed from an audit trail that no longer matches reality.
 */
export function assertAgentStateTransition(
  agentId: AgentId,
  from: AgentStateName,
  to: AgentStateName,
): AgentStateName {
  if (from === to) {
    return to;
  }
  if (!isLegalAgentStateTransition(from, to)) {
    throw illegalAgentStateTransition(agentId, from, to, legalAgentTransitions(from));
  }
  return to;
}

/** Returns the destination status, or throws {@link illegalAgentStatusTransition}. */
export function assertAgentStatusTransition(
  agentId: AgentId,
  from: AgentStatus,
  to: AgentStatus,
): AgentStatus {
  if (from === to) {
    return to;
  }
  if (!isLegalAgentStatusTransition(from, to)) {
    throw illegalAgentStatusTransition(agentId, from, to, legalAgentStatusTransitions(from));
  }
  return to;
}

/**
 * The shortest legal path between two states, inclusive of both ends, or `null`
 * when no path exists.
 *
 * Callers that need to reach a state several moves away — suspending a running
 * agent, or recording a run that failed before it started — walk the path rather
 * than inventing a shortcut, so every intermediate state still appears in the
 * trail. Breadth-first over nine states is exact and cheap; a heuristic here would
 * be a second, untested idea of what "legal" means.
 */
export function agentStatePath(
  from: AgentStateName,
  to: AgentStateName,
): readonly AgentStateName[] | null {
  if (from === to) {
    return Object.freeze([from]);
  }
  if (isTerminalAgentState(from)) {
    return null;
  }

  let queue: readonly AgentStateName[][] = [[from]];
  const seen = new Set<AgentStateName>([from]);
  while (queue.length > 0) {
    const [path, ...rest] = queue;
    if (path === undefined) {
      return null;
    }
    const current = path[path.length - 1];
    if (current === undefined) {
      return null;
    }
    for (const next of legalAgentTransitions(current)) {
      if (seen.has(next)) {
        continue;
      }
      const extended = [...path, next];
      if (next === to) {
        return Object.freeze(extended);
      }
      seen.add(next);
      rest.push(extended);
    }
    queue = rest;
  }
  return null;
}

/** True when the state machine above agrees with the terminal states the contract declares. */
export function agentStateMachineIsConsistent(): boolean {
  for (const state of Object.keys(AGENT_STATE_TRANSITIONS) as AgentStateName[]) {
    if (isTerminalAgentState(state) && AGENT_STATE_TRANSITIONS[state].length !== 0) {
      return false;
    }
    if (!isTerminalAgentState(state) && AGENT_STATE_TRANSITIONS[state].length === 0) {
      // A non-terminal state with no way out would strand an agent forever.
      return false;
    }
  }
  return true;
}
