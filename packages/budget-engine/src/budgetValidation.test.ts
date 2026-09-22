import { describe, expect, it } from "vitest";
import { AI_CORE_CONTRACT_VERSION, MAX_BUDGET_LIMITS } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import { tryValidate, validate } from "@omnis/validation";
import { InMemoryBudgetEngine } from "./InMemoryBudgetEngine.js";
import {
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
  reserveRequestSchema,
} from "./budgetValidation.js";
import {
  AT,
  budget,
  budgetInput,
  FIXTURE_IDS,
  hold,
  limit,
  reserveRequest,
  scope,
} from "./testSupport.js";

describe("integer amounts", () => {
  it("accepts non-negative finite integers", () => {
    for (const amount of [0, 1, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(integerAmountSchema.safeParse(amount).success, String(amount)).toBe(true);
    }
  });

  it("rejects everything a ledger could not add up exactly", () => {
    for (const amount of [
      -1,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1e6,
      "100",
      null,
    ]) {
      expect(integerAmountSchema.safeParse(amount).success, String(amount)).toBe(false);
    }
  });

  it("accepts a hold and rejects an unusable one", () => {
    expect(budgetHoldSchema.safeParse(hold("tokens", 10)).success).toBe(true);
    expect(budgetHoldSchema.safeParse({ dimension: "tokens", amount: -1 }).success).toBe(false);
    expect(budgetHoldSchema.safeParse({ dimension: "favours", amount: 1 }).success).toBe(false);
    expect(budgetHoldSchema.safeParse({ dimension: "tokens" }).success).toBe(false);
  });
});

describe("vocabulary schemas", () => {
  it("accepts exactly the published dimensions, windows and statuses", () => {
    for (const dimension of [
      "tokens",
      "requests",
      "model_calls",
      "tool_executions",
      "duration_ms",
      "cost_micro_usd",
    ]) {
      expect(budgetDimensionSchema.safeParse(dimension).success, dimension).toBe(true);
      expect(isBudgetDimensionValue(dimension), dimension).toBe(true);
    }
    expect(budgetDimensionSchema.safeParse("dollars").success).toBe(false);
    expect(isBudgetDimensionValue("dollars")).toBe(false);

    for (const window of ["execution", "session", "day", "total"]) {
      expect(budgetWindowSchema.safeParse(window).success, window).toBe(true);
    }
    expect(budgetWindowSchema.safeParse("hour").success).toBe(false);

    for (const status of ["active", "suspended", "exhausted", "closed"]) {
      expect(budgetStatusSchema.safeParse(status).success, status).toBe(true);
    }
    expect(budgetStatusSchema.safeParse("paused").success).toBe(false);

    for (const state of ["held", "committed", "released", "expired"]) {
      expect(isReservationStateValue(state), state).toBe(true);
    }
    expect(isReservationStateValue("pending")).toBe(false);
  });
});

describe("limit schemas", () => {
  it("requires enforcement on a stored limit", () => {
    expect(budgetLimitSchema.safeParse(limit("tokens", "total", 10)).success).toBe(true);
    expect(
      budgetLimitSchema.safeParse({ dimension: "tokens", window: "total", limit: 10 }).success,
    ).toBe(false);
  });

  it("lets a registration input omit enforcement", () => {
    const parsed = validate(
      budgetLimitInputSchema,
      { dimension: "tokens", window: "total", limit: 10 },
      "BudgetLimit",
    );
    expect(parsed.enforcement).toBeUndefined();
    expect(
      budgetLimitInputSchema.safeParse({
        dimension: "tokens",
        window: "total",
        limit: 10,
        enforcement: "soft",
      }).success,
    ).toBe(true);
    expect(
      budgetLimitInputSchema.safeParse({
        dimension: "tokens",
        window: "total",
        limit: 10,
        enforcement: "medium",
      }).success,
    ).toBe(false);
  });
});

describe("budget schemas", () => {
  it("accepts a complete budget", () => {
    expect(budgetSchema.safeParse(budget()).success).toBe(true);
    expect(budgetInputSchema.safeParse(budgetInput()).success).toBe(true);
  });

  it("accepts a registration input without the fields the engine fills in", () => {
    const parsed = validate(budgetInputSchema, { name: "minimal", limits: [] }, "Budget");
    expect(parsed.id).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.createdAt).toBeUndefined();
  });

  it("rejects a budget that could not be enforced", () => {
    expect(budgetSchema.safeParse({ ...budget(), version: 0 }).success).toBe(false);
    expect(budgetSchema.safeParse({ ...budget(), createdAt: "yesterday" }).success).toBe(false);
    expect(budgetSchema.safeParse({ ...budget(), status: "paused" }).success).toBe(false);
    expect(budgetSchema.safeParse({ ...budget(), name: "" }).success).toBe(false);
    expect(budgetSchema.safeParse({ ...budget(), tenantId: "not-a-tenant" }).success).toBe(false);
    expect(
      budgetSchema.safeParse({
        ...budget(),
        limits: Array.from({ length: MAX_BUDGET_LIMITS + 1 }, () => limit("tokens", "total", 1)),
      }).success,
    ).toBe(false);
  });

  it("reports a failure as a ValidationError naming the label", () => {
    expect(() => validate(budgetInputSchema, { name: "", limits: [] }, "Budget")).toThrow(
      ValidationError,
    );
    expect(tryValidate(budgetInputSchema, { name: "", limits: [] }).ok).toBe(false);
  });
});

describe("reservation schemas", () => {
  it("bounds an idempotency key", () => {
    expect(reservationKeySchema.safeParse("step-1").success).toBe(true);
    expect(reservationKeySchema.safeParse("x".repeat(MAX_RESERVATION_KEY_LENGTH)).success).toBe(
      true,
    );
    expect(reservationKeySchema.safeParse("").success).toBe(false);
    expect(reservationKeySchema.safeParse("x".repeat(MAX_RESERVATION_KEY_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it("requires at least one hold, so a reservation is never a no-op", () => {
    expect(
      reserveRequestSchema.safeParse(reserveRequest(FIXTURE_IDS.budgetId, "k", [hold("tokens", 1)]))
        .success,
    ).toBe(true);
    expect(
      reserveRequestSchema.safeParse(reserveRequest(FIXTURE_IDS.budgetId, "k", [])).success,
    ).toBe(false);
    expect(
      reserveRequestSchema.safeParse({
        ...reserveRequest(FIXTURE_IDS.budgetId, "k", [hold("tokens", 1)]),
        executionId: "exec_1",
      }).success,
    ).toBe(false);
    expect(
      reserveRequestSchema.safeParse({
        ...reserveRequest(FIXTURE_IDS.budgetId, "k", [hold("tokens", 1)]),
        sessionId: "",
      }).success,
    ).toBe(false);
  });

  it("accepts a reservation and a ledger snapshot the engine produces", () => {
    const eng = new InMemoryBudgetEngine({ clock: () => AT });
    const registered = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 100)] }));
    const reservation = eng.reserve(reserveRequest(registered.id, "k", [hold("tokens", 10)]));
    expect(budgetReservationSchema.safeParse(reservation).success).toBe(true);
    expect(budgetReservationSchema.safeParse(eng.commit(reservation.id)).success).toBe(true);
    expect(
      budgetUsageSchema.safeParse(eng.usage(registered.id, scope(FIXTURE_IDS.executionId))).success,
    ).toBe(true);
    expect(
      budgetCheckResultSchema.safeParse(
        eng.check(reserveRequest(registered.id, "other", [hold("tokens", 10)])),
      ).success,
    ).toBe(true);
    expect(budgetSchema.safeParse(eng.requireBudget(registered.id)).success).toBe(true);
  });

  it("rejects a reservation missing what an audit row needs", () => {
    const eng = new InMemoryBudgetEngine({ clock: () => AT });
    const registered = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 100)] }));
    const reservation = eng.reserve(reserveRequest(registered.id, "k", [hold("tokens", 10)]));
    expect(budgetReservationSchema.safeParse({ ...reservation, state: "pending" }).success).toBe(
      false,
    );
    expect(budgetReservationSchema.safeParse({ ...reservation, committedAt: "soon" }).success).toBe(
      false,
    );
    expect(budgetReservationSchema.safeParse({ ...reservation, key: "" }).success).toBe(false);
    expect(
      budgetUsageSchema.safeParse({ ...eng.usage(registered.id, scope()), window: "week" }).success,
    ).toBe(false);
    expect(budgetCheckResultSchema.safeParse({ allowed: true }).success).toBe(false);
  });
});

describe("contracts", () => {
  it("publishes each contract at the AI Core version", () => {
    expect(BUDGET_CONTRACT.contractId).toBe("Budget");
    expect(BUDGET_CONTRACT.version).toBe(AI_CORE_CONTRACT_VERSION);
    expect(BUDGET_RESERVATION_CONTRACT.contractId).toBe("BudgetReservation");
    expect(BUDGET_USAGE_CONTRACT.contractId).toBe("BudgetUsage");
    expect(BUDGET_CHECK_CONTRACT.contractId).toBe("BudgetCheckResult");
    for (const contract of [
      BUDGET_CONTRACT,
      BUDGET_RESERVATION_CONTRACT,
      BUDGET_USAGE_CONTRACT,
      BUDGET_CHECK_CONTRACT,
    ]) {
      expect(contract.version).toBe(AI_CORE_CONTRACT_VERSION);
    }
  });

  it("validates through the contract's schema", () => {
    expect(BUDGET_CONTRACT.schema.safeParse(budget()).success).toBe(true);
    expect(BUDGET_RESERVATION_CONTRACT.schema.safeParse({}).success).toBe(false);
  });
});
