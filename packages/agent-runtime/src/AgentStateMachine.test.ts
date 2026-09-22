/**
 * The agent lifecycle as data.
 *
 * These tests are the specification: every legal move is asserted to be legal, and
 * the moves that would let an agent escape its own audit trail are asserted to be
 * refused. A transition table nobody tests is a transition table nobody can trust.
 */

import { describe, expect, it } from "vitest";
import { createAgentId } from "@omnis/types";
import { AGENT_STATES, isTerminalAgentState } from "@omnis/ai-core-types";
import type { AgentStateName, AgentStatus } from "@omnis/ai-core-types";
import { ConflictError } from "@omnis/errors";
import {
  AGENT_STATE_TRANSITIONS,
  AGENT_STATUS_TRANSITIONS,
  agentStateMachineIsConsistent,
  agentStatePath,
  assertAgentStateTransition,
  assertAgentStatusTransition,
  isLegalAgentStateTransition,
  isLegalAgentStatusTransition,
  legalAgentStatusTransitions,
  legalAgentTransitions,
} from "./AgentStateMachine.js";

const AGENT = createAgentId();

describe("the transition table", () => {
  it("covers every state the contract declares, and no others", () => {
    expect(Object.keys(AGENT_STATE_TRANSITIONS).sort()).toEqual([...AGENT_STATES].sort());
  });

  it("only ever names declared states as destinations", () => {
    for (const [from, destinations] of Object.entries(AGENT_STATE_TRANSITIONS)) {
      for (const to of destinations) {
        expect(AGENT_STATES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it("gives terminal states no way out", () => {
    for (const state of AGENT_STATES) {
      if (isTerminalAgentState(state)) {
        expect(AGENT_STATE_TRANSITIONS[state], state).toHaveLength(0);
        expect(legalAgentTransitions(state), state).toHaveLength(0);
      }
    }
  });

  it("gives every non-terminal state a way out, so no agent can be stranded", () => {
    for (const state of AGENT_STATES) {
      if (!isTerminalAgentState(state)) {
        expect(legalAgentTransitions(state).length, state).toBeGreaterThan(0);
      }
    }
  });

  it("lets every non-terminal state be cancelled, because an operator can always stop an agent", () => {
    for (const state of AGENT_STATES) {
      if (!isTerminalAgentState(state)) {
        expect(isLegalAgentStateTransition(state, "cancelled"), state).toBe(true);
      }
    }
  });

  it("agrees with the contract about which states are terminal", () => {
    expect(agentStateMachineIsConsistent()).toBe(true);
  });

  it("is frozen, so a caller cannot widen it at runtime", () => {
    expect(Object.isFrozen(AGENT_STATE_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(AGENT_STATE_TRANSITIONS.running)).toBe(true);
  });

  it("keeps waiting and paused distinct in both directions", () => {
    // `waiting` is what the agent asked for; `paused` is what an operator did. An
    // agent that is waiting may resume into running; a paused one returns to ready.
    expect(isLegalAgentStateTransition("waiting", "running")).toBe(true);
    expect(isLegalAgentStateTransition("waiting", "ready")).toBe(false);
    expect(isLegalAgentStateTransition("paused", "ready")).toBe(true);
    expect(isLegalAgentStateTransition("paused", "waiting")).toBe(false);
  });

  it("does not let a finished agent be moved back to work", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as AgentStateName[]) {
      for (const state of AGENT_STATES) {
        expect(isLegalAgentStateTransition(terminal, state), `${terminal} -> ${state}`).toBe(false);
      }
    }
  });
});

describe("isLegalAgentStateTransition", () => {
  it("refuses a move to the state the agent is already in", () => {
    // Not an error, but not a transition either: reporting one would publish an
    // event saying something changed when nothing did.
    expect(isLegalAgentStateTransition("running", "running")).toBe(false);
    expect(isLegalAgentStateTransition("created", "created")).toBe(false);
  });

  it("refuses a shortcut no path contains", () => {
    expect(isLegalAgentStateTransition("created", "running")).toBe(false);
    expect(isLegalAgentStateTransition("created", "completed")).toBe(false);
    expect(isLegalAgentStateTransition("planning", "completed")).toBe(false);
  });
});

describe("assertAgentStateTransition", () => {
  it("returns the destination for a legal move", () => {
    expect(assertAgentStateTransition(AGENT, "ready", "planning")).toBe("planning");
    expect(assertAgentStateTransition(AGENT, "running", "completed")).toBe("completed");
  });

  it("treats staying put as legal and says nothing happened", () => {
    expect(assertAgentStateTransition(AGENT, "running", "running")).toBe("running");
  });

  it("throws a conflict naming the agent, the move and the legal alternatives", () => {
    let caught: unknown = null;
    try {
      assertAgentStateTransition(AGENT, "completed", "running");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const error = caught as ConflictError;
    expect(error.message).toContain("completed");
    expect(error.message).toContain("running");
    expect(error.message).toContain("terminal");
    expect(String(error.conflict)).toContain(String(AGENT));
  });

  it("lists the legal moves in the error, so the caller can recover without reading the source", () => {
    let message = "";
    try {
      assertAgentStateTransition(AGENT, "created", "running");
    } catch (error) {
      message = (error as ConflictError).message;
    }
    expect(message).toContain('"ready"');
    expect(message).toContain('"failed"');
    expect(message).toContain('"cancelled"');
  });
});

describe("agentStatePath", () => {
  it("returns the state itself when there is nowhere to go", () => {
    expect(agentStatePath("running", "running")).toEqual(["running"]);
  });

  it("returns a single legal move as a two-state path", () => {
    expect(agentStatePath("ready", "planning")).toEqual(["ready", "planning"]);
  });

  it("walks only legal moves when the destination is several states away", () => {
    const path = agentStatePath("created", "completed");
    expect(path).not.toBeNull();
    expect(path?.[0]).toBe("created");
    expect(path?.at(-1)).toBe("completed");
    for (let index = 1; index < (path?.length ?? 0); index += 1) {
      const from = path?.[index - 1] as AgentStateName;
      const to = path?.[index] as AgentStateName;
      expect(isLegalAgentStateTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("finds the shortest path rather than any path", () => {
    // `planning` is optional: a reactive agent goes straight from ready to running,
    // so the shortest path to completion has three moves, not four.
    expect(agentStatePath("created", "completed")).toEqual([
      "created",
      "ready",
      "running",
      "completed",
    ]);
    expect(agentStatePath("running", "waiting")).toHaveLength(2);
    expect(agentStatePath("created", "planning")).toEqual(["created", "ready", "planning"]);
  });

  it("returns null when a terminal state would have to be left", () => {
    expect(agentStatePath("failed", "running")).toBeNull();
    expect(agentStatePath("completed", "ready")).toBeNull();
    expect(agentStatePath("cancelled", "cancelled")).toEqual(["cancelled"]);
  });
});

describe("the registration status lifecycle", () => {
  it("covers every status and makes retired terminal", () => {
    expect(Object.keys(AGENT_STATUS_TRANSITIONS).sort()).toEqual([
      "active",
      "disabled",
      "draft",
      "retired",
    ]);
    expect(legalAgentStatusTransitions("retired")).toHaveLength(0);
  });

  it("lets a draft be activated and a disabled agent be brought back", () => {
    expect(isLegalAgentStatusTransition("draft", "active")).toBe(true);
    expect(isLegalAgentStatusTransition("disabled", "active")).toBe(true);
    expect(isLegalAgentStatusTransition("active", "draft")).toBe(false);
  });

  it("refuses to un-retire an agent", () => {
    // A withdrawn agent that can be reactivated by a stale configuration is a
    // withdrawn agent that will run.
    for (const status of ["draft", "active", "disabled"] as AgentStatus[]) {
      expect(isLegalAgentStatusTransition("retired", status), status).toBe(false);
    }
  });

  it("throws a typed conflict for an illegal status move", () => {
    expect(() => assertAgentStatusTransition(AGENT, "retired", "active")).toThrow(ConflictError);
    expect(assertAgentStatusTransition(AGENT, "draft", "active")).toBe("active");
    expect(assertAgentStatusTransition(AGENT, "active", "active")).toBe("active");
  });
});
