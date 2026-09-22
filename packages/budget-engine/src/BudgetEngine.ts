/**
 * The budget engine contract.
 *
 * The engine's job is to make spending *authorized before it happens*. That produces three
 * obligations the interface encodes:
 *
 * - {@link BudgetEngine.check} answers "would this fit?" without holding anything, so a caller
 *   can plan.
 * - {@link BudgetEngine.reserve} holds the amount, keyed for idempotency, so a retried step is
 *   charged once.
 * - {@link BudgetEngine.commit} settles the hold against what was actually consumed, and
 *   {@link BudgetEngine.release} / {@link BudgetEngine.expire} give the hold back.
 *
 * Nothing here is asynchronous. Between two awaits no other code runs, so "check the ledger,
 * then write the ledger" cannot interleave with another reservation — the property a spend cap
 * depends on, obtained without locks.
 *
 * Windows are the other half of the contract. A limit is meaningless without saying *over what
 * span*, so every limit names a window and every reservation names a scope; the pair decides
 * which bucket of the ledger is charged. {@link windowBucket} is exported because it is the
 * whole rule, and a caller that computes buckets differently would enforce a different budget.
 */

import type { ExecutionContext } from "@omnis/execution-context";
import type {
  Budget,
  BudgetCheckResult,
  BudgetDimension,
  BudgetHold,
  BudgetReservation,
  BudgetStatus,
  BudgetUsage,
  BudgetWindow,
  ExecutionId,
  ReservationId,
  ReservationState,
} from "@omnis/ai-core-types";
import type { BudgetId } from "@omnis/ai-core-types";
import type { BudgetInput, BudgetLimitInput, ReserveRequest } from "./budgetValidation.js";

/** How an engine is configured. */
export interface BudgetEngineOptions {
  /** Source of ledger timestamps, as UTC ISO 8601. Injectable so day windows are testable. */
  readonly clock?: () => string;
  /** Maximum number of registered budgets. */
  readonly maxBudgets?: number;
  /** Maximum number of reservations one budget may hold at once. */
  readonly maxReservationsPerBudget?: number;
}

/** Which buckets of the ledger a reservation charges. */
export interface ReservationScope {
  readonly executionId: ExecutionId;
  /** Session bucket for `session`-windowed limits; falls back to the execution when absent. */
  readonly sessionId: string | null;
}

/** Lifecycle transitions a budget may make. */
export const BUDGET_STATUS_TRANSITIONS: Readonly<Record<BudgetStatus, readonly BudgetStatus[]>> =
  Object.freeze({
    active: Object.freeze(["suspended", "exhausted", "closed"] as readonly BudgetStatus[]),
    suspended: Object.freeze(["active", "closed"] as readonly BudgetStatus[]),
    // Exhausted is recoverable: raising a limit or releasing settled work is a legitimate way
    // back to active, and forcing a re-registration would lose the ledger.
    exhausted: Object.freeze(["active", "closed"] as readonly BudgetStatus[]),
    // Closed is terminal. The ledger stays readable for audit; it never accepts work again.
    closed: Object.freeze([] as readonly BudgetStatus[]),
  });

/** True when a budget may move from `from` to `to`. */
export function isLegalBudgetStatusTransition(from: BudgetStatus, to: BudgetStatus): boolean {
  return from === to || (BUDGET_STATUS_TRANSITIONS[from]?.includes(to) ?? false);
}

/** Lifecycle transitions a reservation may make. Everything but `held` is terminal. */
export const RESERVATION_STATE_TRANSITIONS: Readonly<
  Record<ReservationState, readonly ReservationState[]>
> = Object.freeze({
  held: Object.freeze(["committed", "released", "expired"] as readonly ReservationState[]),
  committed: Object.freeze([] as readonly ReservationState[]),
  released: Object.freeze([] as readonly ReservationState[]),
  expired: Object.freeze([] as readonly ReservationState[]),
});

/** True when a reservation may move from `from` to `to`. */
export function isLegalReservationTransition(
  from: ReservationState,
  to: ReservationState,
): boolean {
  return from === to || (RESERVATION_STATE_TRANSITIONS[from]?.includes(to) ?? false);
}

/**
 * The ledger bucket a limit charges, for one reservation scope at one instant.
 *
 * Deterministic and pure: the same window, scope and timestamp always produce the same key.
 * The `day` bucket is the UTC calendar date of the observation, so a budget day ends at
 * midnight UTC regardless of where the operator or the provider is.
 */
export function windowBucket(
  window: BudgetWindow,
  scope: ReservationScope,
  observedAt: string,
): string {
  switch (window) {
    case "execution":
      return `execution:${scope.executionId}`;
    case "session":
      // An execution that names no session is its own session. Charging it to a shared bucket
      // would let unrelated executions exhaust each other.
      return `session:${scope.sessionId ?? scope.executionId}`;
    case "day":
      return `day:${observedAt.slice(0, 10)}`;
    case "total":
      return "total";
  }
}

/** The instant a window bucket started, for a ledger snapshot. */
export function windowStart(
  window: BudgetWindow,
  observedAt: string,
  budgetCreatedAt: string,
): string {
  return window === "day" ? `${observedAt.slice(0, 10)}T00:00:00.000Z` : budgetCreatedAt;
}

/** The engine's public surface. */
export interface BudgetEngine {
  /** Number of registered budgets. */
  readonly size: number;

  /** Registers a budget at version 1. */
  registerBudget(input: BudgetInput): Budget;

  /** Replaces a budget's limits, incrementing its version. */
  setLimits(budgetId: BudgetId, limits: readonly BudgetLimitInput[]): Budget;

  /** Moves a budget through its lifecycle, incrementing its version. */
  setStatus(budgetId: BudgetId, status: BudgetStatus): Budget;

  getBudget(budgetId: BudgetId): Budget | null;

  /** Like {@link getBudget}, but throws when the budget is not registered. */
  requireBudget(budgetId: BudgetId): Budget;

  has(budgetId: BudgetId): boolean;

  /** Removes a budget. Refuses while it still holds active reservations. */
  removeBudget(budgetId: BudgetId): boolean;

  /** Every budget, ordered by name then identifier. */
  listBudgets(): readonly Budget[];

  /** Would this reservation fit? Holds nothing and never throws for a refusal. */
  check(request: ReserveRequest): BudgetCheckResult;

  /**
   * Holds the requested amounts.
   *
   * Idempotent on `(budgetId, key)`: reserving twice with the same key returns the first
   * reservation and holds nothing extra. Throws when a hard limit would be exceeded, when the
   * budget cannot accept reservations, or when cost-limited work has no price.
   */
  reserve(request: ReserveRequest): BudgetReservation;

  /** {@link reserve} with the execution and session taken from an execution context. */
  reserveFromContext(
    context: ExecutionContext,
    request: Omit<ReserveRequest, "executionId" | "sessionId"> & {
      readonly sessionId?: string | null;
    },
  ): BudgetReservation;

  /**
   * Settles a hold against what was actually consumed.
   *
   * `actual` defaults to the held amounts. Charging more than was held is allowed and is not
   * an error — the work already happened — but it can push the budget to `exhausted`, which
   * this method records.
   */
  commit(reservationId: ReservationId, actual?: readonly BudgetHold[]): BudgetReservation;

  /** Gives a hold back. Idempotent: releasing a settled reservation returns it unchanged. */
  release(reservationId: ReservationId): BudgetReservation;

  /** Gives a hold back because the work will never happen, e.g. a deadline passed. */
  expire(reservationId: ReservationId): BudgetReservation;

  /** Releases every held reservation for one execution; returns how many were released. */
  releaseAllForExecution(executionId: ExecutionId): number;

  getReservation(reservationId: ReservationId): BudgetReservation | null;

  requireReservation(reservationId: ReservationId): BudgetReservation;

  /** Every reservation against a budget, ordered by creation then identifier. */
  reservationsForBudget(budgetId: BudgetId): readonly BudgetReservation[];

  /** Every reservation for one execution, across all budgets, in the same order. */
  reservationsForExecution(executionId: ExecutionId): readonly BudgetReservation[];

  /**
   * A ledger snapshot for one budget, scope and window.
   *
   * Only dimensions the budget limits are counted. An unlimited dimension is not tracked,
   * because nothing in the engine would ever read it and a ledger that grows without being
   * read is a leak.
   */
  usage(budgetId: BudgetId, scope: ReservationScope, window?: BudgetWindow): BudgetUsage;

  /** Remaining allowance on one dimension, or `null` when the budget does not limit it. */
  remaining(
    budgetId: BudgetId,
    dimension: BudgetDimension,
    scope: ReservationScope,
    window?: BudgetWindow,
  ): number | null;
}
