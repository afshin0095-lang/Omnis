/**
 * Budget engine errors.
 *
 * Every error here answers one of three questions a caller needs answered precisely:
 * *is this budget usable?* (`budgetNotReservable`, `budgetNotFound`), *does the requested
 * work fit?* ({@link budgetExhaustedError}, {@link unpricedWorkAgainstCostLimit}), and *is
 * this reservation in a state that allows that?* (`invalidReservationState`).
 *
 * None of them is retryable. A budget that refused a reservation will refuse the same
 * reservation again until something outside the engine changes — a commit, a release, or an
 * operator raising a limit — and marking it retryable would turn a spend cap into a retry
 * loop against a vendor.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import type {
  Budget,
  BudgetDimension,
  BudgetId,
  BudgetStatus,
  ExecutionId,
  ReservationId,
  ReservationState,
} from "@omnis/ai-core-types";
import { budgetExhaustedError } from "@omnis/ai-core-types";

export { budgetExhaustedError };

/** A budget that is not registered. */
export function budgetNotFound(budgetId: BudgetId): NotFoundError {
  return new NotFoundError("budget", budgetId, {
    retryable: false,
    metadata: { registry: "budget" },
  });
}

/** A budget identifier that is already registered. */
export function duplicateBudget(budgetId: BudgetId, name: string): ConflictError {
  return new ConflictError(`budget:${budgetId}`, `budget "${name}" is already registered`, {
    retryable: false,
    metadata: { budgetId, name, registry: "budget" },
  });
}

/** A reservation that is not in the ledger. */
export function reservationNotFound(reservationId: ReservationId): NotFoundError {
  return new NotFoundError("budget-reservation", reservationId, {
    retryable: false,
    metadata: { registry: "budget" },
  });
}

/** A budget whose status does not accept new reservations. */
export function budgetNotReservable(budget: Budget): ConflictError {
  return new ConflictError(
    `budget:${budget.id}`,
    `budget "${budget.name}" is ${budget.status} and cannot accept reservations`,
    {
      retryable: false,
      metadata: { budgetId: budget.id, status: budget.status },
    },
  );
}

/** An illegal move between budget statuses. */
export function invalidBudgetStatusTransition(
  budgetId: BudgetId,
  from: BudgetStatus,
  to: BudgetStatus,
): ValidationError {
  return new ValidationError(`budget cannot move from ${from} to ${to}`, {
    retryable: false,
    metadata: { budgetId, from, to },
  });
}

/** An illegal move between reservation states. */
export function invalidReservationState(
  reservationId: ReservationId,
  from: ReservationState,
  to: ReservationState,
): ValidationError {
  return new ValidationError(`reservation cannot move from ${from} to ${to}`, {
    retryable: false,
    metadata: { reservationId, from, to },
  });
}

/** A budget definition the ledger cannot enforce. */
export function invalidBudget(reason: string, budgetId: BudgetId | null = null): ValidationError {
  return new ValidationError(`budget is invalid: ${reason}`, {
    retryable: false,
    metadata: { budgetId, registry: "budget" },
  });
}

/** A reservation request the ledger cannot hold. */
export function invalidReservationRequest(
  reason: string,
  executionId: ExecutionId | null = null,
): ValidationError {
  return new ValidationError(`reservation request is invalid: ${reason}`, {
    retryable: false,
    metadata: { executionId },
  });
}

/** Too many reservations for one budget. */
export function reservationCapacityExceeded(budgetId: BudgetId, capacity: number): ConflictError {
  return new ConflictError(
    `budget:${budgetId}`,
    `budget holds ${String(capacity)} reservations and cannot take another; release or commit settled work`,
    { retryable: false, metadata: { budgetId, capacity } },
  );
}

/** A budget that still holds active reservations. */
export function budgetHasActiveReservations(
  budgetId: BudgetId,
  activeReservations: number,
): ConflictError {
  return new ConflictError(
    `budget:${budgetId}`,
    `budget still holds ${String(activeReservations)} active reservation(s); release or commit them first`,
    { retryable: false, metadata: { budgetId, activeReservations } },
  );
}

/** Too many budgets for the configured capacity. */
export function budgetCapacityExceeded(capacity: number): ConflictError {
  return new ConflictError(
    "budget-engine-capacity",
    `budget engine is full at ${String(capacity)} budgets`,
    {
      retryable: false,
      metadata: { capacity },
    },
  );
}

/**
 * Work whose cost cannot be computed, requested against a budget that limits cost.
 *
 * The alternative — treating an unpriced model as free — is how a spend cap gets exceeded by
 * exactly the models nobody priced. Refusing makes the gap visible at authorization time
 * instead of on an invoice.
 */
export function unpricedWorkAgainstCostLimit(
  budgetId: BudgetId,
  dimension: BudgetDimension = "cost_micro_usd",
): ValidationError {
  return new ValidationError(`budget limits ${dimension} but the requested work has no price`, {
    retryable: false,
    metadata: { budgetId, dimension, "omnis.budget.unpriced": true },
  });
}
