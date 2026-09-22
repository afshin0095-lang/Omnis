import { describe, expect, it } from "vitest";
import { createExecutionId } from "@omnis/types";
import {
  EXECUTION_STATUSES,
  illegalExecutionTransitionError,
  isTerminalExecutionStatus,
} from "@omnis/ai-core-types";
import type { ExecutionStatus } from "@omnis/ai-core-types";
import { ContractError } from "@omnis/errors";
import {
  assertExecutionStatusTransition,
  EXECUTION_GATE_SEQUENCE,
  EXECUTION_STATUS_TRANSITIONS,
  gatesCleared,
  isLegalExecutionStatusTransition,
  legalExecutionTransitions,
} from "./ExecutionStateMachine.js";

/** Every non-terminal status, taken from the published list rather than retyped here. */
const NON_TERMINAL: readonly ExecutionStatus[] = EXECUTION_STATUSES.filter(
  (status) => !isTerminalExecutionStatus(status),
);
const TERMINAL: readonly ExecutionStatus[] = EXECUTION_STATUSES.filter(isTerminalExecutionStatus);
/** The three states any execution can fall into from anywhere. */
const UNIVERSAL_EXITS: readonly ExecutionStatus[] = ["failed", "cancelled", "timed_out"];

describe("transition table", () => {
  it("has an entry for every execution status", () => {
    expect(Object.keys(EXECUTION_STATUS_TRANSITIONS).sort()).toEqual(
      [...EXECUTION_STATUSES].sort(),
    );
  });

  it("gives terminal states no moves at all", () => {
    expect(TERMINAL).toHaveLength(4);
    for (const status of TERMINAL) {
      expect(EXECUTION_STATUS_TRANSITIONS[status]).toEqual([]);
      expect(legalExecutionTransitions(status)).toEqual([]);
      for (const target of EXECUTION_STATUSES) {
        expect(isLegalExecutionStatusTransition(status, target), `${status} -> ${target}`).toBe(
          false,
        );
      }
    }
  });

  it("lets every non-terminal state fail, be cancelled or time out", () => {
    for (const status of NON_TERMINAL) {
      for (const exit of UNIVERSAL_EXITS) {
        expect(isLegalExecutionStatusTransition(status, exit), `${status} -> ${exit}`).toBe(true);
      }
    }
  });

  it("freezes the table and each move list", () => {
    expect(Object.isFrozen(EXECUTION_STATUS_TRANSITIONS)).toBe(true);
    for (const status of EXECUTION_STATUSES) {
      expect(Object.isFrozen(EXECUTION_STATUS_TRANSITIONS[status])).toBe(true);
    }
    expect(Object.isFrozen(EXECUTION_GATE_SEQUENCE)).toBe(true);
  });

  it("refuses the shortcut from created straight to running", () => {
    // Reaching `running` is meant to be proof that validation, authorization and reservation all
    // said yes. A move that skips them would make that proof worthless for every consumer.
    expect(isLegalExecutionStatusTransition("created", "running")).toBe(false);
    expect(isLegalExecutionStatusTransition("created", "planned")).toBe(false);
    expect(isLegalExecutionStatusTransition("created", "succeeded")).toBe(false);
    expect(isLegalExecutionStatusTransition("validated", "running")).toBe(false);
  });

  it("allows authorized to skip reservation when no budget applies", () => {
    expect(isLegalExecutionStatusTransition("authorized", "reserved")).toBe(true);
    expect(isLegalExecutionStatusTransition("authorized", "planned")).toBe(true);
    expect(isLegalExecutionStatusTransition("authorized", "running")).toBe(false);
  });

  it("walks the whole gate sequence one step at a time", () => {
    for (let index = 0; index < EXECUTION_GATE_SEQUENCE.length - 1; index += 1) {
      const from = EXECUTION_GATE_SEQUENCE[index] as ExecutionStatus;
      const to = EXECUTION_GATE_SEQUENCE[index + 1] as ExecutionStatus;
      expect(isLegalExecutionStatusTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("treats waiting as a pause inside a run, not as a dead end", () => {
    expect(isLegalExecutionStatusTransition("running", "waiting")).toBe(true);
    expect(isLegalExecutionStatusTransition("waiting", "running")).toBe(true);
    expect(isLegalExecutionStatusTransition("waiting", "succeeded")).toBe(true);
    expect(isTerminalExecutionStatus("waiting")).toBe(false);
  });

  it("refuses to reopen a finished execution", () => {
    expect(isLegalExecutionStatusTransition("succeeded", "running")).toBe(false);
    expect(isLegalExecutionStatusTransition("succeeded", "failed")).toBe(false);
    expect(isLegalExecutionStatusTransition("running", "succeeded")).toBe(true);
  });

  it("refuses every self-transition", () => {
    for (const status of EXECUTION_STATUSES) {
      expect(isLegalExecutionStatusTransition(status, status), `${status} -> ${status}`).toBe(
        false,
      );
    }
  });

  it("never moves backwards through the gates", () => {
    const order = new Map(EXECUTION_GATE_SEQUENCE.map((status, index) => [status, index] as const));
    for (const from of EXECUTION_GATE_SEQUENCE) {
      for (const to of EXECUTION_GATE_SEQUENCE) {
        const fromIndex = order.get(from) ?? -1;
        const toIndex = order.get(to) ?? -1;
        if (toIndex <= fromIndex) {
          expect(isLegalExecutionStatusTransition(from, to), `${from} -> ${to}`).toBe(false);
        }
      }
    }
  });
});

describe("assertExecutionStatusTransition", () => {
  const executionId = createExecutionId();

  it("returns the destination when the move is legal", () => {
    expect(assertExecutionStatusTransition("created", "validated", executionId)).toBe("validated");
    expect(assertExecutionStatusTransition("running", "succeeded", executionId)).toBe("succeeded");
    expect(assertExecutionStatusTransition("planned", "cancelled", executionId)).toBe("cancelled");
  });

  it("throws the published contract error when the move is illegal", () => {
    expect(() => assertExecutionStatusTransition("created", "running", executionId)).toThrow(
      ContractError,
    );
    expect(() => {
      throw illegalExecutionTransitionError("created", "running", executionId);
    }).toThrowError(/illegal execution transition created -> running/);
  });

  it("refuses every move out of a terminal state, including to itself", () => {
    for (const from of TERMINAL) {
      for (const to of EXECUTION_STATUSES) {
        expect(() => assertExecutionStatusTransition(from, to, executionId)).toThrow(ContractError);
      }
    }
  });

  it("carries the identifiers an auditor needs on the error", () => {
    let caught: unknown;
    try {
      assertExecutionStatusTransition("succeeded", "running", executionId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractError);
    const contract = caught as ContractError;
    expect(contract.contractId).toBe("execution-state-machine");
    expect(contract.retryable).toBe(false);
    expect(contract.metadata).toMatchObject({ from: "succeeded", to: "running", executionId });
  });
});

describe("gatesCleared", () => {
  it("counts how far an execution got through the pre-flight pipeline", () => {
    expect(gatesCleared("created")).toBe(0);
    expect(gatesCleared("validated")).toBe(1);
    expect(gatesCleared("authorized")).toBe(2);
    expect(gatesCleared("reserved")).toBe(3);
    expect(gatesCleared("planned")).toBe(4);
    expect(gatesCleared("running")).toBe(5);
  });

  it("reports the full sequence for terminal states, which cleared everything they would clear", () => {
    for (const status of TERMINAL) {
      expect(gatesCleared(status)).toBe(EXECUTION_GATE_SEQUENCE.length);
    }
  });

  it("treats waiting as still inside the run", () => {
    expect(EXECUTION_GATE_SEQUENCE).not.toContain("waiting");
    expect(gatesCleared("waiting")).toBe(EXECUTION_GATE_SEQUENCE.length);
  });
});
