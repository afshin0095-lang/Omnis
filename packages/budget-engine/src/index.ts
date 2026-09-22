/**
 * `@omnis/budget-engine` — integer limits, holds before spend, and a ledger that cannot lie.
 *
 * Public surface:
 * - {@link BudgetEngine} and {@link InMemoryBudgetEngine}: budgets, reservations, and the
 *   per-window ledger behind them.
 * - {@link windowBucket} and the lifecycle transition tables: the rules that decide which
 *   bucket a reservation charges and what a budget or reservation may become next.
 * - The cost calculator: pricing to integer micro-USD, with "unknown price" kept distinct from
 *   "free".
 * - Validation schemas, published contracts and error factories.
 *
 * Money is integer micro-USD everywhere. A fractional amount is a rejected input, not a rounded
 * one.
 */

export { createBudgetEngine, InMemoryBudgetEngine } from "./InMemoryBudgetEngine.js";

export {
  BUDGET_STATUS_TRANSITIONS,
  isLegalBudgetStatusTransition,
  isLegalReservationTransition,
  RESERVATION_STATE_TRANSITIONS,
  windowBucket,
  windowStart,
} from "./BudgetEngine.js";
export type { BudgetEngine, BudgetEngineOptions, ReservationScope } from "./BudgetEngine.js";

export {
  assertPricedForBudget,
  budgetLimitsCost,
  costHold,
  describeCost,
  estimateCallCost,
  estimateTotalMicro,
  modelCallHolds,
  modelPricing,
  priceTokens,
  toolCallHolds,
  usageCost,
} from "./CostCalculator.js";
export type { CostEstimate, CostEstimateInput } from "./CostCalculator.js";

export {
  budgetCapacityExceeded,
  budgetExhaustedError,
  budgetHasActiveReservations,
  budgetNotFound,
  budgetNotReservable,
  duplicateBudget,
  invalidBudget,
  invalidBudgetStatusTransition,
  invalidReservationRequest,
  invalidReservationState,
  reservationCapacityExceeded,
  reservationNotFound,
  unpricedWorkAgainstCostLimit,
} from "./errors.js";

export {
  BUDGET_CHECK_CONTRACT,
  budgetCheckResultSchema,
  BUDGET_CONTRACT,
  budgetDimensionSchema,
  budgetHoldSchema,
  budgetInputSchema,
  budgetLimitInputSchema,
  budgetLimitSchema,
  BUDGET_RESERVATION_CONTRACT,
  budgetReservationSchema,
  budgetSchema,
  budgetStatusSchema,
  BUDGET_USAGE_CONTRACT,
  budgetUsageSchema,
  budgetWindowSchema,
  integerAmountSchema,
  isBudgetDimensionValue,
  isReservationStateValue,
  MAX_RESERVATION_KEY_LENGTH,
  reservationKeySchema,
  reservationStateSchema,
  reserveRequestSchema,
} from "./budgetValidation.js";
export type { BudgetInput, BudgetLimitInput, ReserveRequest } from "./budgetValidation.js";
