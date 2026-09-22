import { describe, expect, it } from "vitest";
import { createBudgetId } from "@omnis/types";
import {
  availableFor,
  assertBudgetShape,
  BUDGET_DIMENSIONS,
  budgetHold,
  durationHold,
  EMPTY_USAGE,
  findLimit,
  formatMicroUsd,
  holdAmount,
  isBudgetDimension,
  isIntegerAmount,
  isReservableBudgetStatus,
  isReservationActive,
  microUsd,
  sumHolds,
  toolExecutionHold,
  usageToHolds,
  type Budget,
  type BudgetLimit,
  type BudgetUsage,
} from "./index.js";

function limit(
  dimension: BudgetLimit["dimension"],
  limitValue: number,
  window: BudgetLimit["window"] = "execution",
): BudgetLimit {
  return { dimension, window, limit: limitValue, enforcement: "hard" };
}

function budget(limits: readonly BudgetLimit[]): Budget {
  return {
    id: createBudgetId(),
    name: "test-budget",
    description: "budget used by tests",
    status: "active",
    limits,
    tenantId: null,
    policyId: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

function usage(
  committed: ReturnType<typeof budgetHold>[],
  reserved: ReturnType<typeof budgetHold>[] = [],
): BudgetUsage {
  return {
    budgetId: createBudgetId(),
    committed,
    reserved,
    window: "execution",
    windowStartedAt: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("integer money", () => {
  it("converts decimal USD to integer micro-USD exactly", () => {
    expect(microUsd(1)).toBe(1_000_000);
    expect(microUsd(1.5)).toBe(1_500_000);
    expect(microUsd(0.000001)).toBe(1);
    expect(microUsd(0)).toBe(0);
    expect(microUsd(-2.25)).toBe(-2_250_000);
    expect(isIntegerAmount(microUsd(1234.5678))).toBe(true);
  });

  it("rejects a non-finite amount instead of storing NaN in the ledger", () => {
    expect(() => microUsd(Number.NaN)).toThrow(RangeError);
    expect(() => microUsd(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("renders micro-USD with six decimals and no floating point error", () => {
    expect(formatMicroUsd(1_500_000)).toBe("1.500000");
    expect(formatMicroUsd(1)).toBe("0.000001");
    expect(formatMicroUsd(0)).toBe("0.000000");
    expect(formatMicroUsd(-1_500_000)).toBe("-1.500000");
    // 0.1 + 0.2 is the classic floating point trap; in micro units it is exact.
    expect(formatMicroUsd(microUsd(0.1) + microUsd(0.2))).toBe("0.300000");
  });

  it("refuses to render a fractional micro amount", () => {
    expect(() => formatMicroUsd(1.5)).toThrow(RangeError);
  });
});

describe("holds", () => {
  it("rejects negative and fractional amounts", () => {
    expect(() => budgetHold("tokens", -1)).toThrow(RangeError);
    expect(() => budgetHold("tokens", 1.5)).toThrow(RangeError);
    expect(() => budgetHold("cost_micro_usd", Number.NaN)).toThrow(RangeError);
  });

  it("sums per dimension in a stable dimension order", () => {
    const holds = [
      budgetHold("cost_micro_usd", 100),
      budgetHold("tokens", 10),
      budgetHold("tokens", 5),
      budgetHold("requests", 1),
    ];
    // Order follows BUDGET_DIMENSIONS, not insertion order, so two ledgers built from
    // the same holds in a different order compare equal.
    expect(sumHolds(holds)).toEqual([
      { dimension: "tokens", amount: 15 },
      { dimension: "requests", amount: 1 },
      { dimension: "cost_micro_usd", amount: 100 },
    ]);
    expect(sumHolds([...holds].reverse())).toEqual(sumHolds(holds));
  });

  it("omits dimensions that net to zero", () => {
    expect(sumHolds([])).toEqual([]);
  });

  it("reads one dimension's amount", () => {
    const holds = [budgetHold("tokens", 10), budgetHold("tokens", 5)];
    expect(holdAmount(holds, "tokens")).toBe(15);
    expect(holdAmount(holds, "requests")).toBe(0);
  });

  it("provides single-call helpers for tools and duration", () => {
    expect(toolExecutionHold()).toEqual({ dimension: "tool_executions", amount: 1 });
    expect(toolExecutionHold(3)).toEqual({ dimension: "tool_executions", amount: 3 });
    expect(durationHold(1234.9)).toEqual({ dimension: "duration_ms", amount: 1234 });
    expect(durationHold(-50)).toEqual({ dimension: "duration_ms", amount: 0 });
  });
});

describe("usageToHolds", () => {
  it("charges tokens and one request per model call", () => {
    const holds = usageToHolds({
      ...EMPTY_USAGE,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      requests: 1,
    });
    expect(holds).toEqual([
      { dimension: "tokens", amount: 150 },
      { dimension: "requests", amount: 1 },
      { dimension: "model_calls", amount: 1 },
    ]);
  });

  it("omits cost entirely when the usage is unpriced", () => {
    // `costMicro: null` means "we do not know the price", which is not the same as
    // "this was free". Charging zero would let an unpriced model spend without limit.
    const holds = usageToHolds({ ...EMPTY_USAGE, totalTokens: 10, requests: 1, costMicro: null });
    expect(holds.some((hold) => hold.dimension === "cost_micro_usd")).toBe(false);

    const priced = usageToHolds({ ...EMPTY_USAGE, totalTokens: 10, requests: 1, costMicro: 2_500 });
    expect(holdAmount(priced, "cost_micro_usd")).toBe(2_500);
  });

  it("charges nothing for empty usage", () => {
    expect(usageToHolds(EMPTY_USAGE)).toEqual([]);
  });
});

describe("budget shape", () => {
  it("accepts a well-formed budget", () => {
    expect(() =>
      assertBudgetShape(budget([limit("tokens", 100_000), limit("cost_micro_usd", 1_000_000)])),
    ).not.toThrow();
  });

  it("rejects a fractional or negative limit", () => {
    expect(() => assertBudgetShape(budget([limit("tokens", 1.5)]))).toThrow(RangeError);
    expect(() => assertBudgetShape(budget([limit("tokens", -1)]))).toThrow(RangeError);
  });

  it("only allows new reservations against an active budget", () => {
    expect(isReservableBudgetStatus("active")).toBe(true);
    // A suspended budget is not exhausted: it is paused by an operator and must not
    // quietly accept new holds.
    expect(isReservableBudgetStatus("suspended")).toBe(false);
    expect(isReservableBudgetStatus("exhausted")).toBe(false);
    expect(isReservableBudgetStatus("closed")).toBe(false);
  });

  it("treats only a held reservation as still occupying budget", () => {
    expect(isReservationActive("held")).toBe(true);
    for (const state of ["committed", "released", "expired"] as const) {
      expect(isReservationActive(state), state).toBe(false);
    }
  });

  it("recognizes its own dimensions", () => {
    for (const dimension of BUDGET_DIMENSIONS) {
      expect(isBudgetDimension(dimension)).toBe(true);
    }
    expect(isBudgetDimension("goodwill")).toBe(false);
  });
});

describe("limits and availability", () => {
  it("picks the most restrictive limit for a dimension and window", () => {
    const subject = budget([
      limit("tokens", 100_000),
      limit("tokens", 20_000),
      limit("tokens", 50_000, "day"),
    ]);
    expect(findLimit(subject, "tokens", "execution")?.limit).toBe(20_000);
    expect(findLimit(subject, "tokens", "day")?.limit).toBe(50_000);
    expect(findLimit(subject, "requests", "execution")).toBeNull();
  });

  it("subtracts committed and reserved amounts from the allowance", () => {
    const subject = usage([budgetHold("tokens", 30)], [budgetHold("tokens", 20)]);
    expect(availableFor(subject, limit("tokens", 100), "tokens")).toBe(50);
  });

  it("never reports a negative allowance", () => {
    const subject = usage([budgetHold("tokens", 500)]);
    expect(availableFor(subject, limit("tokens", 100), "tokens")).toBe(0);
  });

  it("reports unlimited when the budget declares no limit for the dimension", () => {
    expect(availableFor(usage([]), null, "tokens")).toBeNull();
  });
});
