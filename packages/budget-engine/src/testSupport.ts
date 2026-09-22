/**
 * Fixtures for this package's suites.
 *
 * Budgets are tested against a fixed clock and integer amounts, so every assertion in these
 * suites is an exact equality rather than an approximation. Nothing here reads a real clock or
 * generates a random amount.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import { createBudgetId, createExecutionId } from "@omnis/types";
import type { Budget, BudgetHold, BudgetId, BudgetLimit, ExecutionId } from "@omnis/ai-core-types";
import { budgetHold } from "@omnis/ai-core-types";
import type { BudgetInput, BudgetLimitInput, ReserveRequest } from "./budgetValidation.js";
import type { ReservationScope } from "./BudgetEngine.js";

/** The instant every fixture happens at. */
export const AT = "2026-03-01T12:00:00.000Z";

/** The next day, for day-window tests. */
export const NEXT_DAY = "2026-03-02T09:00:00.000Z";

/** Identifiers reused across suites. */
export const FIXTURE_IDS = {
  budgetId: createBudgetId(),
  executionId: createExecutionId(),
} as const;

/** A limit on one dimension and window. Hard by default. */
export function limit(
  dimension: BudgetLimitInput["dimension"],
  window: BudgetLimitInput["window"],
  amount: number,
  enforcement: "hard" | "soft" = "hard",
): BudgetLimitInput {
  return { dimension, window, limit: amount, enforcement };
}

/** A budget input with a single total spend cap. */
export function budgetInput(overrides: Partial<BudgetInput> = {}): BudgetInput {
  return {
    name: "fixture-budget",
    description: "A budget built by the fixture.",
    limits: [limit("cost_micro_usd", "total", 1_000_000)],
    createdAt: AT,
    ...overrides,
  };
}

/** A complete budget limit. */
export function budgetLimit(
  dimension: BudgetLimit["dimension"],
  window: BudgetLimit["window"],
  amount: number,
  enforcement: BudgetLimit["enforcement"] = "hard",
): BudgetLimit {
  return { dimension, window, limit: amount, enforcement };
}

/** A complete budget, for suites that need the stored shape rather than a registration input. */
export function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: FIXTURE_IDS.budgetId,
    name: "fixture-budget",
    description: "A budget built by the fixture.",
    status: "active",
    limits: [budgetLimit("cost_micro_usd", "total", 1_000_000)],
    tenantId: null,
    policyId: null,
    metadata: {},
    createdAt: AT,
    version: 1,
    ...overrides,
  };
}

/** A hold on one dimension. */
export function hold(dimension: BudgetHold["dimension"], amount: number): BudgetHold {
  return budgetHold(dimension, amount);
}

/** A reservation request against a budget. */
export function reserveRequest(
  budgetId: BudgetId,
  key: string,
  holds: readonly BudgetHold[],
  overrides: Partial<ReserveRequest> = {},
): ReserveRequest {
  return {
    budgetId,
    executionId: FIXTURE_IDS.executionId,
    key,
    holds,
    ...overrides,
  };
}

/** A ledger scope for one execution. */
export function scope(
  executionId: ExecutionId = FIXTURE_IDS.executionId,
  sessionId: string | null = null,
): ReservationScope {
  return { executionId, sessionId };
}
