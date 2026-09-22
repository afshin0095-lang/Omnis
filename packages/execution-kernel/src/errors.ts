/**
 * Kernel errors.
 *
 * The kernel throws for three reasons only: a request it cannot store, a plan it cannot run, and a
 * lifecycle move the state machine does not allow. Everything that happens *during* a run — a step
 * that fails, a policy that denies, a budget that is exhausted, a deadline that passes — is
 * recorded as an {@link ExecutionFailure} on the record and returned, never thrown. An execution
 * that throws leaves its caller without a record, and a record is the only thing an operator can
 * audit after the fact.
 *
 * Transition and plan errors are re-used from `@omnis/ai-core-types` rather than re-declared here,
 * because the transition table and the plan contract live with the types they describe.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import type { ExecutionId, ExecutionStatus, PlanIssue } from "@omnis/ai-core-types";

/** An execution the kernel has no record of. */
export function executionNotFound(executionId: ExecutionId): NotFoundError {
  return new NotFoundError("execution", executionId, {
    retryable: false,
    metadata: { registry: "kernel", executionId },
  });
}

/** An execution identifier that is already in flight or already stored. */
export function duplicateExecution(executionId: ExecutionId): ConflictError {
  return new ConflictError(
    `execution:${executionId}`,
    `execution ${executionId} is already registered`,
    {
      retryable: false,
      metadata: { registry: "kernel", executionId },
    },
  );
}

/** A request the kernel cannot store. */
export function invalidExecutionRequest(
  reason: string,
  executionId: ExecutionId | null = null,
): ValidationError {
  return new ValidationError(`execution request is invalid: ${reason}`, {
    retryable: false,
    metadata: { registry: "kernel", executionId },
  });
}

/** A plan the kernel refuses to run, with every structural problem it found. */
export function planRejected(
  issues: readonly PlanIssue[],
  executionId: ExecutionId | null = null,
): ValidationError {
  return new ValidationError(`execution plan was rejected: ${describePlanIssues(issues)}`, {
    retryable: false,
    issues: issues.map((issue) => ({
      path: issue.stepId === null ? "plan" : `plan.steps.${issue.stepId}`,
      code: issue.code,
      message: issue.message,
      received: null,
    })),
    metadata: { registry: "kernel", executionId, codes: issues.map((issue) => issue.code) },
  });
}

/** An executor that does not satisfy the contract. */
export function invalidExecutor(kind: string, reason: string): ValidationError {
  return new ValidationError(`step executor for kind "${kind}" is invalid: ${reason}`, {
    retryable: false,
    metadata: { registry: "kernel", kind },
  });
}

/** No executor is registered for a step's kind. */
export function noStepExecutor(
  kind: string,
  stepId: string,
  executionId: ExecutionId,
): ValidationError {
  return new ValidationError(
    `no step executor is registered for kind "${kind}" (step "${stepId}")`,
    {
      retryable: false,
      metadata: { registry: "kernel", kind, stepId, executionId },
    },
  );
}

/** A lifecycle move on an execution that has already finished. */
export function executionAlreadyTerminal(
  executionId: ExecutionId,
  status: ExecutionStatus,
): ConflictError {
  return new ConflictError(
    `execution:${executionId}`,
    `execution ${executionId} is already ${status}`,
    {
      retryable: false,
      metadata: { registry: "kernel", executionId, status },
    },
  );
}

/** More live executions than the kernel is configured to hold. */
export function kernelCapacityExceeded(maxExecutions: number): ConflictError {
  return new ConflictError(
    "execution:capacity",
    `kernel holds at most ${String(maxExecutions)} execution records`,
    {
      retryable: false,
      metadata: { registry: "kernel", maxExecutions },
    },
  );
}

/** Renders plan issues as one line, in the order they were found. */
export function describePlanIssues(issues: readonly PlanIssue[]): string {
  if (issues.length === 0) {
    return "no issues";
  }
  return issues
    .map((issue) => (issue.stepId === null ? issue.message : `${issue.stepId}: ${issue.message}`))
    .join("; ");
}
