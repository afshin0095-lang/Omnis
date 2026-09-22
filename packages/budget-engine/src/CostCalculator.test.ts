import { describe, expect, it } from "vitest";
import { EMPTY_USAGE, MICRO_USD_PER_USD, holdAmount } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import {
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
import { budget } from "./testSupport.js";

/** A price list: 3000 micro per 1k input, 15000 micro per 1k output. */
const PRICING = modelPricing({ inputPerThousandTokens: 3_000, outputPerThousandTokens: 15_000 });

describe("priceTokens", () => {
  it("prices an exact multiple of a thousand", () => {
    expect(priceTokens(1_000, 3_000)).toBe(3_000);
    expect(priceTokens(2_500, 3_000)).toBe(7_500);
    expect(priceTokens(0, 3_000)).toBe(0);
  });

  it("rounds up so a hold never under-covers the charge", () => {
    expect(priceTokens(1, 3_000)).toBe(3);
    expect(priceTokens(1, 1)).toBe(1);
    expect(priceTokens(999, 3_000)).toBe(2_997);
    expect(priceTokens(1_001, 3_000)).toBe(3_003);
    // 1 token at 1 micro per thousand is a thousandth of a micro: still charged one.
    expect(priceTokens(1, 1)).toBe(1);
  });

  it("treats an unknown price as no cost, and says so with null one level up", () => {
    expect(priceTokens(1_000, null)).toBe(0);
    expect(estimateCallCost(null, { inputTokens: 1_000, outputTokens: 100 })).toBeNull();
    expect(estimateTotalMicro(null)).toBeNull();
  });

  it("rejects amounts the ledger could not store", () => {
    expect(() => priceTokens(-1, 3_000)).toThrow(RangeError);
    expect(() => priceTokens(1.5, 3_000)).toThrow(RangeError);
    expect(() => priceTokens(Number.NaN, 3_000)).toThrow(RangeError);
    expect(() => priceTokens(1_000, -1)).toThrow(RangeError);
    expect(() => priceTokens(1_000, 2.5)).toThrow(RangeError);
    expect(() => priceTokens(Number.MAX_SAFE_INTEGER, MICRO_USD_PER_USD)).toThrow(RangeError);
  });
});

describe("modelPricing", () => {
  it("builds a frozen record with the currency spelled out", () => {
    expect(PRICING).toEqual({
      currency: "micro_usd",
      inputPerThousandTokens: 3_000,
      outputPerThousandTokens: 15_000,
      cachedInputPerThousandTokens: null,
      perRequestMicro: null,
    });
    expect(Object.isFrozen(PRICING)).toBe(true);
  });

  it("keeps optional discounts explicit", () => {
    const discounted = modelPricing({
      inputPerThousandTokens: 3_000,
      outputPerThousandTokens: 15_000,
      cachedInputPerThousandTokens: 300,
      perRequestMicro: 250,
    });
    expect(discounted.cachedInputPerThousandTokens).toBe(300);
    expect(discounted.perRequestMicro).toBe(250);
  });

  it("rejects a price that is not integer micro-USD", () => {
    expect(() => modelPricing({ inputPerThousandTokens: 0.5, outputPerThousandTokens: 1 })).toThrow(
      RangeError,
    );
    expect(() => modelPricing({ inputPerThousandTokens: -1, outputPerThousandTokens: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      modelPricing({ inputPerThousandTokens: 1, outputPerThousandTokens: 1, perRequestMicro: -5 }),
    ).toThrow(RangeError);
  });
});

describe("estimateCallCost", () => {
  it("prices input and output separately", () => {
    const estimate = estimateCallCost(PRICING, { inputTokens: 1_000, outputTokens: 500 });
    expect(estimate).toEqual({
      inputMicro: 3_000,
      outputMicro: 7_500,
      cachedInputMicro: 0,
      perRequestMicro: 0,
      totalMicro: 10_500,
    });
    expect(Object.isFrozen(estimate)).toBe(true);
  });

  it("prices cached tokens at the cached rate and removes them from the full-price count", () => {
    const discounted = modelPricing({
      inputPerThousandTokens: 3_000,
      outputPerThousandTokens: 15_000,
      cachedInputPerThousandTokens: 300,
    });
    const estimate = estimateCallCost(discounted, {
      inputTokens: 1_000,
      outputTokens: 0,
      cachedInputTokens: 400,
    });
    expect(estimate?.inputMicro).toBe(1_800);
    expect(estimate?.cachedInputMicro).toBe(120);
    expect(estimate?.totalMicro).toBe(1_920);
  });

  it("gives no discount when the pricing declares none", () => {
    const estimate = estimateCallCost(PRICING, {
      inputTokens: 1_000,
      outputTokens: 0,
      cachedInputTokens: 400,
    });
    expect(estimate?.inputMicro).toBe(1_800);
    expect(estimate?.cachedInputMicro).toBe(0);
    expect(estimate?.totalMicro).toBe(1_800);
  });

  it("charges a per-request fee once per request", () => {
    const perRequest = modelPricing({
      inputPerThousandTokens: 0,
      outputPerThousandTokens: 0,
      perRequestMicro: 250,
    });
    expect(estimateCallCost(perRequest, { inputTokens: 0, outputTokens: 0 })?.totalMicro).toBe(250);
    expect(
      estimateCallCost(perRequest, { inputTokens: 0, outputTokens: 0, requests: 4 })?.totalMicro,
    ).toBe(1_000);
  });

  it("refuses an incoherent or unusable estimate", () => {
    expect(() =>
      estimateCallCost(PRICING, { inputTokens: 100, outputTokens: 0, cachedInputTokens: 200 }),
    ).toThrow(RangeError);
    expect(() => estimateCallCost(PRICING, { inputTokens: -1, outputTokens: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      estimateCallCost(PRICING, { inputTokens: 0, outputTokens: 0, requests: -1 }),
    ).toThrow(RangeError);
    expect(() => estimateCallCost(PRICING, { inputTokens: 1.5, outputTokens: 0 })).toThrow(
      RangeError,
    );
  });

  it("is deterministic", () => {
    const request = { inputTokens: 1_234, outputTokens: 567, cachedInputTokens: 89, requests: 2 };
    expect(estimateCallCost(PRICING, request)).toEqual(estimateCallCost(PRICING, request));
  });
});

describe("holds", () => {
  it("holds tokens, requests, model calls and cost together", () => {
    const holds = modelCallHolds(PRICING, { inputTokens: 1_000, outputTokens: 500 });
    expect(holdAmount(holds, "tokens")).toBe(1_500);
    expect(holdAmount(holds, "requests")).toBe(1);
    expect(holdAmount(holds, "model_calls")).toBe(1);
    expect(holdAmount(holds, "cost_micro_usd")).toBe(10_500);
  });

  it("omits the cost hold when the price is unknown", () => {
    const holds = modelCallHolds(null, { inputTokens: 1_000, outputTokens: 500 });
    expect(holdAmount(holds, "tokens")).toBe(1_500);
    expect(holds.some((hold) => hold.dimension === "cost_micro_usd")).toBe(false);
  });

  it("omits dimensions that are zero", () => {
    expect(modelCallHolds(PRICING, { inputTokens: 0, outputTokens: 0, requests: 0 })).toEqual([]);
    expect(costHold(0).amount).toBe(0);
  });

  it("holds one tool execution by default", () => {
    expect(holdAmount(toolCallHolds(), "tool_executions")).toBe(1);
    expect(holdAmount(toolCallHolds(3), "tool_executions")).toBe(3);
  });

  it("sums repeated dimensions into one hold", () => {
    const holds = modelCallHolds(PRICING, { inputTokens: 10, outputTokens: 10, requests: 2 });
    expect(holds.filter((hold) => hold.dimension === "requests")).toHaveLength(1);
    expect(holdAmount(holds, "requests")).toBe(2);
  });
});

describe("unpriced work", () => {
  it("detects a cost limit", () => {
    expect(budgetLimitsCost(budget())).toBe(true);
    expect(budgetLimitsCost(budget({ limits: [] }))).toBe(false);
  });

  it("refuses unpriced work against a cost-limited budget", () => {
    const holds = modelCallHolds(null, { inputTokens: 1_000, outputTokens: 500 });
    expect(() => assertPricedForBudget(budget(), holds)).toThrow(ValidationError);
    try {
      assertPricedForBudget(budget(), holds);
      expect.unreachable("unpriced work must be refused");
    } catch (error) {
      expect((error as ValidationError).metadata["omnis.budget.unpriced"]).toBe(true);
    }
  });

  it("accepts priced work and accepts unpriced work where cost is not limited", () => {
    expect(() =>
      assertPricedForBudget(
        budget(),
        modelCallHolds(PRICING, { inputTokens: 10, outputTokens: 10 }),
      ),
    ).not.toThrow();
    expect(() =>
      assertPricedForBudget(
        budget({ limits: [] }),
        modelCallHolds(null, { inputTokens: 10, outputTokens: 10 }),
      ),
    ).not.toThrow();
    // Tokens and calls are still bounded by their own limits; only the cost limit demands a price.
    expect(() =>
      assertPricedForBudget(
        budget({
          limits: [{ dimension: "tokens", window: "total", limit: 10, enforcement: "hard" }],
        }),
        [],
      ),
    ).not.toThrow();
  });
});

describe("usageCost", () => {
  it("recomputes from tokens rather than trusting a provider-reported figure", () => {
    const usage = {
      ...EMPTY_USAGE,
      inputTokens: 1_000,
      outputTokens: 500,
      requests: 1,
      costMicro: 999_999,
    };
    expect(usageCost(PRICING, usage)).toBe(10_500);
  });

  it("returns null when the pricing is unknown", () => {
    expect(
      usageCost(null, { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 10, costMicro: 5 }),
    ).toBeNull();
  });

  it("matches the hold formula, so a hold and its commit differ only in token counts", () => {
    const usage = {
      ...EMPTY_USAGE,
      inputTokens: 800,
      outputTokens: 200,
      cachedInputTokens: 100,
      requests: 1,
    };
    const held =
      estimateCallCost(PRICING, { inputTokens: 800, outputTokens: 200, cachedInputTokens: 100 })
        ?.totalMicro ?? 0;
    expect(usageCost(PRICING, usage)).toBe(held);
  });
});

describe("describeCost", () => {
  it("renders integer micro-USD as a fixed six-decimal amount", () => {
    expect(describeCost(1_500_000)).toBe("1.500000 USD");
    expect(describeCost(0)).toBe("0.000000 USD");
    expect(describeCost(1)).toBe("0.000001 USD");
    expect(describeCost(null)).toBe("unpriced");
  });
});
