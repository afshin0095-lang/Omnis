/**
 * Cost calculation: integer micro-USD, and nothing invented.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. **Integer arithmetic only.** Prices are micro-USD per thousand tokens, so a cost is a
 *    product divided by a thousand. The division rounds *up*: an estimate that rounds down
 *    under-holds, and an under-hold is the difference between "the budget stopped the work"
 *    and "the budget noticed afterwards".
 * 2. **Unknown price means `null`, never zero.** A model whose descriptor has no pricing is
 *    not a free model; it is an unpriced one, and {@link assertPricedForBudget} turns that
 *    into a refusal when the budget limits cost.
 * 3. **Estimates are computed from the same numbers the provider will be charged on** —
 *    input, output, cached input tokens and per-request fees — so a hold and the commit that
 *    settles it differ only in the token counts, never in the formula.
 */

import { isIntegerAmount, MICRO_USD_PER_USD, budgetHold, sumHolds } from "@omnis/ai-core-types";
import type { Budget, BudgetHold, ModelPricing, UsageSummary } from "@omnis/ai-core-types";
import { unpricedWorkAgainstCostLimit } from "./errors.js";

/** What a cost estimate is computed from. */
export interface CostEstimateInput {
  /** Prompt tokens, including cached ones. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from a provider cache, priced separately when the vendor discounts them. */
  readonly cachedInputTokens?: number;
  /** Number of provider requests. Defaults to one. */
  readonly requests?: number;
}

/** The parts of a computed cost, all integer micro-USD. */
export interface CostEstimate {
  readonly inputMicro: number;
  readonly outputMicro: number;
  readonly cachedInputMicro: number;
  readonly perRequestMicro: number;
  /** The sum of the parts. */
  readonly totalMicro: number;
}

/** Tokens per pricing unit. Prices are declared per thousand tokens. */
const TOKENS_PER_PRICING_UNIT = 1_000;

/** Asserts a token count is a non-negative finite integer. */
function assertTokenCount(label: string, value: number): void {
  if (!isIntegerAmount(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, received ${String(value)}`);
  }
}

/** Asserts a price is a non-negative finite integer, or null. */
function assertPrice(label: string, value: number | null): void {
  if (value === null) {
    return;
  }
  if (!isIntegerAmount(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative integer of micro-USD, received ${String(value)}`,
    );
  }
}

/**
 * Prices a token count, rounding up to the next micro-USD.
 *
 * `Math.ceil` on an integer division rather than floating point: `tokens * price` stays an
 * integer for any realistic input, and the ceiling guarantees the hold is never smaller than
 * the charge it is meant to cover.
 */
export function priceTokens(tokens: number, microPerThousandTokens: number | null): number {
  assertTokenCount("token count", tokens);
  assertPrice("price per thousand tokens", microPerThousandTokens);
  if (microPerThousandTokens === null || tokens === 0) {
    return 0;
  }
  const product = tokens * microPerThousandTokens;
  // Beyond MAX_SAFE_INTEGER the product is no longer an exact integer, and a cost that has
  // silently lost precision is a ledger entry nobody can reconcile. Refuse instead.
  if (!Number.isFinite(product) || product > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `cost calculation exceeds the safe integer range: ${String(tokens)} tokens at ${String(microPerThousandTokens)} micro per thousand`,
    );
  }
  return Math.ceil(product / TOKENS_PER_PRICING_UNIT);
}

/** Builds a pricing record, validating every field. */
export function modelPricing(input: {
  readonly inputPerThousandTokens: number;
  readonly outputPerThousandTokens: number;
  readonly cachedInputPerThousandTokens?: number | null;
  readonly perRequestMicro?: number | null;
}): ModelPricing {
  assertPrice("input price", input.inputPerThousandTokens);
  assertPrice("output price", input.outputPerThousandTokens);
  assertPrice("cached input price", input.cachedInputPerThousandTokens ?? null);
  assertPrice("per-request price", input.perRequestMicro ?? null);
  return Object.freeze({
    currency: "micro_usd",
    inputPerThousandTokens: input.inputPerThousandTokens,
    outputPerThousandTokens: input.outputPerThousandTokens,
    cachedInputPerThousandTokens: input.cachedInputPerThousandTokens ?? null,
    perRequestMicro: input.perRequestMicro ?? null,
  });
}

/**
 * Computes the cost of one model call.
 *
 * Cached input tokens are subtracted from the full-price input count before pricing, then
 * priced at the cached rate — but only when the pricing declares one. A vendor that does not
 * discount cached tokens gets no discount here either.
 *
 * Returns `null` when the pricing is unknown.
 */
export function estimateCallCost(
  pricing: ModelPricing | null,
  estimate: CostEstimateInput,
): CostEstimate | null {
  assertTokenCount("input tokens", estimate.inputTokens);
  assertTokenCount("output tokens", estimate.outputTokens);
  const cachedInputTokens = estimate.cachedInputTokens ?? 0;
  assertTokenCount("cached input tokens", cachedInputTokens);
  if (cachedInputTokens > estimate.inputTokens) {
    throw new RangeError(
      `cached input tokens (${String(cachedInputTokens)}) cannot exceed input tokens (${String(estimate.inputTokens)})`,
    );
  }
  const requests = estimate.requests ?? 1;
  assertTokenCount("request count", requests);
  if (pricing === null) {
    return null;
  }

  const fullPriceInputTokens = estimate.inputTokens - cachedInputTokens;
  const cachedInputMicro = priceTokens(cachedInputTokens, pricing.cachedInputPerThousandTokens);
  const inputMicro = priceTokens(fullPriceInputTokens, pricing.inputPerThousandTokens);
  const outputMicro = priceTokens(estimate.outputTokens, pricing.outputPerThousandTokens);
  const perRequestMicro = pricing.perRequestMicro === null ? 0 : pricing.perRequestMicro * requests;
  if (perRequestMicro > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `per-request cost exceeds the safe integer range at ${String(perRequestMicro)} micro-USD`,
    );
  }
  const totalMicro = inputMicro + outputMicro + cachedInputMicro + perRequestMicro;
  if (!isIntegerAmount(totalMicro) || totalMicro > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `cost calculation exceeds the safe integer range at ${String(totalMicro)} micro-USD`,
    );
  }

  return Object.freeze({ inputMicro, outputMicro, cachedInputMicro, perRequestMicro, totalMicro });
}

/** The total of an estimate, or `0` when the pricing is unknown and the caller accepted that. */
export function estimateTotalMicro(estimate: CostEstimate | null): number | null {
  return estimate === null ? null : estimate.totalMicro;
}

/** A cost hold for the ledger. */
export function costHold(micro: number): BudgetHold {
  return budgetHold("cost_micro_usd", micro);
}

/**
 * Builds the holds for one model call: tokens, requests, model calls, and cost when priced.
 *
 * This is what the orchestrator reserves before it spends. The cost hold is omitted when the
 * pricing is unknown, which is exactly the signal {@link assertPricedForBudget} checks for.
 */
export function modelCallHolds(
  pricing: ModelPricing | null,
  estimate: CostEstimateInput,
): readonly BudgetHold[] {
  const holds: BudgetHold[] = [];
  const totalTokens = estimate.inputTokens + estimate.outputTokens;
  if (totalTokens > 0) {
    holds.push(budgetHold("tokens", totalTokens));
  }
  const requests = estimate.requests ?? 1;
  if (requests > 0) {
    holds.push(budgetHold("requests", requests));
    holds.push(budgetHold("model_calls", requests));
  }
  const cost = estimateCallCost(pricing, estimate);
  if (cost !== null && cost.totalMicro > 0) {
    holds.push(costHold(cost.totalMicro));
  }
  return sumHolds(holds);
}

/** Holds for one tool execution. */
export function toolCallHolds(count: number = 1): readonly BudgetHold[] {
  return sumHolds([budgetHold("tool_executions", count)]);
}

/** True when the budget declares any limit on cost. */
export function budgetLimitsCost(budget: Budget): boolean {
  return budget.limits.some((limit) => limit.dimension === "cost_micro_usd");
}

/**
 * Refuses unpriced work against a budget that limits cost.
 *
 * Called by the engine before a reservation is created, so the refusal happens at
 * authorization time. A budget with no cost limit accepts unpriced work: tokens, requests and
 * calls are still bounded, and refusing there would block local and enterprise models that
 * genuinely cost nothing per token.
 */
export function assertPricedForBudget(budget: Budget, holds: readonly BudgetHold[]): void {
  if (!budgetLimitsCost(budget)) {
    return;
  }
  const priced = holds.some((hold) => hold.dimension === "cost_micro_usd");
  if (!priced) {
    throw unpricedWorkAgainstCostLimit(budget.id);
  }
}

/**
 * Charges measured usage against a pricing record, ignoring any provider-reported cost.
 *
 * The provider's own cost figure is telemetry, not accounting: it may be an estimate, may use
 * a different rounding, and cannot be reconciled with a budget that was held using
 * {@link estimateCallCost}. Committing with this function keeps the hold and the charge on the
 * same formula, so a difference between them means the token counts changed and nothing else.
 */
export function usageCost(pricing: ModelPricing | null, usage: UsageSummary): number | null {
  const estimate = estimateCallCost(pricing, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    requests: usage.requests,
  });
  return estimateTotalMicro(estimate);
}

/** Renders micro-USD for a log line or an audit row. */
export function describeCost(micro: number | null): string {
  if (micro === null) {
    return "unpriced";
  }
  const whole = Math.trunc(micro / MICRO_USD_PER_USD);
  const fraction = String(Math.abs(micro % MICRO_USD_PER_USD)).padStart(6, "0");
  return `${String(whole)}.${fraction} USD`;
}
