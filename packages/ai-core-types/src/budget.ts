/**
 * Budget contracts.
 *
 * A budget is a set of integer limits over the dimensions an execution can consume,
 * plus a ledger of what has been *reserved* (held before work starts) and what has
 * been *committed* (charged after work finished). Reserving before spending is the
 * point: a check performed after the model call is a post-mortem, not a control.
 *
 * Integer arithmetic only. Money is micro-USD, tokens are counts, time is
 * milliseconds. Floating point would make `remaining === 0` unreliable and would let a
 * long-running agent drift past its own limit by accumulated rounding — a budget that
 * is approximately enforced is not enforced.
 *
 * Pricing is optional everywhere. When a model's price is unknown, cost holds are
 * `null`, and the Budget Engine treats "cannot price this" as "cannot authorize this
 * against a cost limit" rather than as free. Inventing a price would produce a
 * confident, wrong answer.
 */

import { MICRO_USD_PER_USD, MAX_BUDGET_LIMITS, type AiCoreMetadata } from "./constants.js";
import type { BudgetId, ExecutionId, PolicyId, ReservationId, TenantId } from "./identifiers.js";
import type { UsageSummary } from "./messages.js";

/** The dimensions a budget can bound. */
export const BUDGET_DIMENSIONS = [
  "tokens",
  "requests",
  "model_calls",
  "tool_executions",
  "duration_ms",
  "cost_micro_usd",
] as const;

/** One budget dimension. */
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/** True when the value names a budget dimension. */
export function isBudgetDimension(value: string): value is BudgetDimension {
  return (BUDGET_DIMENSIONS as readonly string[]).includes(value);
}

/** The window a limit applies to. */
export const BUDGET_WINDOWS = ["execution", "session", "day", "total"] as const;

/** One budget window. */
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

/** A single integer limit on one dimension within one window. */
export interface BudgetLimit {
  readonly dimension: BudgetDimension;
  readonly window: BudgetWindow;
  /** Inclusive maximum. Must be a non-negative finite integer. */
  readonly limit: number;
  /**
   * Whether exceeding the limit blocks the work or only records it.
   *
   * A soft limit exists for cost telemetry on an experiment; a hard limit is what a
   * customer's spend cap is made of. Defaulting to hard is deliberate: the unsafe
   * direction is spending money nobody authorized.
   */
  readonly enforcement: "hard" | "soft";
}

/** Lifecycle status of a budget. */
export const BUDGET_STATUSES = ["active", "suspended", "exhausted", "closed"] as const;

/** A budget's status. */
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** True when a budget in this status may accept new reservations. */
export function isReservableBudgetStatus(status: BudgetStatus): boolean {
  return status === "active";
}

/** An immutable budget definition. */
export interface Budget {
  readonly id: BudgetId;
  readonly name: string;
  readonly description: string;
  readonly status: BudgetStatus;
  readonly limits: readonly BudgetLimit[];
  /** Owner of the budget, when it belongs to one tenant. */
  readonly tenantId: TenantId | null;
  /** Policy set consulted when a reservation would exceed a soft limit. */
  readonly policyId: PolicyId | null;
  readonly metadata: AiCoreMetadata;
  readonly createdAt: string;
  readonly version: number;
}

/** Asserts a budget declares a sane number of limits and integer amounts. */
export function assertBudgetShape(budget: Budget): void {
  if (budget.limits.length > MAX_BUDGET_LIMITS) {
    throw new RangeError(
      `budget "${budget.name}" declares ${budget.limits.length} limits, the maximum is ${MAX_BUDGET_LIMITS}`,
    );
  }
  for (const limit of budget.limits) {
    if (!isIntegerAmount(limit.limit) || limit.limit < 0) {
      throw new RangeError(
        `budget limit for ${limit.dimension} must be a non-negative integer, received ${String(limit.limit)}`,
      );
    }
  }
}

/** True when the value is a finite integer — the only amount type the ledger accepts. */
export function isIntegerAmount(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

/**
 * Converts a decimal USD amount to integer micro-USD.
 *
 * Rounds half away from zero so that a configuration expressing "1.5 USD" is stored as
 * exactly 1 500 000 micro, and so that no conversion can produce a fraction the ledger
 * would have to truncate later.
 */
export function microUsd(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new RangeError(`micro-USD amount must be finite, received ${String(usd)}`);
  }
  const scaled = usd * MICRO_USD_PER_USD;
  return scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
}

/** Renders integer micro-USD as a fixed six-decimal string, e.g. `1500000` -> `"1.500000"`. */
export function formatMicroUsd(micro: number): string {
  if (!isIntegerAmount(micro)) {
    throw new RangeError(`micro-USD amount must be an integer, received ${String(micro)}`);
  }
  const negative = micro < 0;
  const absolute = Math.abs(micro);
  const whole = Math.floor(absolute / MICRO_USD_PER_USD);
  const fraction = String(absolute % MICRO_USD_PER_USD).padStart(6, "0");
  return `${negative ? "-" : ""}${String(whole)}.${fraction}`;
}

/** One amount held, committed or spent on one dimension. */
export interface BudgetHold {
  readonly dimension: BudgetDimension;
  /** Non-negative finite integer. */
  readonly amount: number;
}

/** Builds a hold, rejecting non-integer or negative amounts. */
export function budgetHold(dimension: BudgetDimension, amount: number): BudgetHold {
  if (!isIntegerAmount(amount)) {
    throw new RangeError(
      `budget hold for ${dimension} must be an integer, received ${String(amount)}`,
    );
  }
  if (amount < 0) {
    throw new RangeError(
      `budget hold for ${dimension} must not be negative, received ${String(amount)}`,
    );
  }
  return Object.freeze({ dimension, amount });
}

/** Sums holds per dimension. Later holds on the same dimension accumulate. */
export function sumHolds(holds: readonly BudgetHold[]): readonly BudgetHold[] {
  const totals = new Map<BudgetDimension, number>();
  for (const hold of holds) {
    totals.set(hold.dimension, (totals.get(hold.dimension) ?? 0) + hold.amount);
  }
  const result: BudgetHold[] = [];
  // Deterministic dimension order, independent of insertion order.
  for (const dimension of BUDGET_DIMENSIONS) {
    const amount = totals.get(dimension);
    if (amount !== undefined && amount !== 0) {
      result.push(budgetHold(dimension, amount));
    }
  }
  return Object.freeze(result);
}

/** The amount held on one dimension, or `0`. */
export function holdAmount(holds: readonly BudgetHold[], dimension: BudgetDimension): number {
  let total = 0;
  for (const hold of holds) {
    if (hold.dimension === dimension) {
      total += hold.amount;
    }
  }
  return total;
}

/**
 * Converts measured model usage into budget holds.
 *
 * The bridge between "what the provider reported" and "what the ledger charges".
 * `cost_micro_usd` is omitted entirely when usage is unpriced, so the ledger never
 * records a fabricated cost — and the Budget Engine can tell "free" from "unknown".
 */
export function usageToHolds(usage: UsageSummary): readonly BudgetHold[] {
  const holds: BudgetHold[] = [];
  if (usage.totalTokens > 0) {
    holds.push(budgetHold("tokens", usage.totalTokens));
  }
  if (usage.requests > 0) {
    holds.push(budgetHold("requests", usage.requests));
    holds.push(budgetHold("model_calls", usage.requests));
  }
  if (usage.costMicro !== null && usage.costMicro > 0) {
    holds.push(budgetHold("cost_micro_usd", usage.costMicro));
  }
  return sumHolds(holds);
}

/** A hold for one tool execution. */
export function toolExecutionHold(count: number = 1): BudgetHold {
  return budgetHold("tool_executions", count);
}

/** A hold for elapsed time. */
export function durationHold(durationMs: number): BudgetHold {
  return budgetHold("duration_ms", Math.max(0, Math.trunc(durationMs)));
}

/** The outcome of a pre-work budget check. */
export interface BudgetCheckResult {
  readonly allowed: boolean;
  /** The dimension that blocked the request, or `null` when allowed. */
  readonly blockingDimension: BudgetDimension | null;
  readonly requested: number;
  readonly available: number;
  readonly reason: string | null;
  /** True when a limit was exceeded but is only enforced softly. */
  readonly softLimitExceeded: boolean;
}

/** An allowed check result, reused instead of allocating per call. */
export const BUDGET_CHECK_ALLOWED: BudgetCheckResult = Object.freeze({
  allowed: true,
  blockingDimension: null,
  requested: 0,
  available: Number.MAX_SAFE_INTEGER,
  reason: null,
  softLimitExceeded: false,
});

/** Lifecycle state of a reservation. */
export const RESERVATION_STATES = ["held", "committed", "released", "expired"] as const;

/** A reservation's state. */
export type ReservationState = (typeof RESERVATION_STATES)[number];

/** True when the reservation still holds budget against its execution. */
export function isReservationActive(state: ReservationState): boolean {
  return state === "held";
}

/**
 * An immutable reservation record.
 *
 * `key` is the idempotency key: reserving twice with the same key returns the same
 * reservation instead of holding twice. Without it, a retried step would be charged
 * for the attempt that failed *and* the attempt that succeeded.
 */
export interface BudgetReservation {
  readonly id: ReservationId;
  readonly budgetId: BudgetId;
  readonly executionId: ExecutionId;
  readonly key: string;
  readonly holds: readonly BudgetHold[];
  readonly state: ReservationState;
  /** What was actually charged on commit; equals `holds` while held or released. */
  readonly committed: readonly BudgetHold[];
  readonly createdAt: string;
  readonly committedAt: string | null;
  readonly releasedAt: string | null;
}

/** Per-dimension ledger totals for one budget. */
export interface BudgetUsage {
  readonly budgetId: BudgetId;
  /** Amounts already charged. */
  readonly committed: readonly BudgetHold[];
  /** Amounts held by active reservations and not yet charged. */
  readonly reserved: readonly BudgetHold[];
  readonly window: BudgetWindow;
  readonly windowStartedAt: string;
  readonly observedAt: string;
}

/** Remaining allowance on one dimension, or `null` when the budget does not limit it. */
export function availableFor(
  usage: BudgetUsage,
  limit: BudgetLimit | null,
  dimension: BudgetDimension,
): number | null {
  if (limit === null) {
    return null;
  }
  const consumed = holdAmount(usage.committed, dimension) + holdAmount(usage.reserved, dimension);
  return Math.max(0, limit.limit - consumed);
}

/** The limit a budget declares for a dimension and window, most restrictive first. */
export function findLimit(
  budget: Budget,
  dimension: BudgetDimension,
  window: BudgetWindow,
): BudgetLimit | null {
  let found: BudgetLimit | null = null;
  for (const limit of budget.limits) {
    if (limit.dimension !== dimension || limit.window !== window) {
      continue;
    }
    if (found === null || limit.limit < found.limit) {
      found = limit;
    }
  }
  return found;
}
