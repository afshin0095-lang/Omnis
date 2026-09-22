import { describe, expect, it } from "vitest";
import { createBudgetId, createExecutionId } from "@omnis/types";
import { BUDGET_CHECK_ALLOWED, holdAmount } from "@omnis/ai-core-types";
import { ConflictError, ExecutionError, NotFoundError, ValidationError } from "@omnis/errors";
import { createExecutionContext } from "@omnis/execution-context";
import { InMemoryBudgetEngine } from "./InMemoryBudgetEngine.js";
import {
  BUDGET_STATUS_TRANSITIONS,
  isLegalBudgetStatusTransition,
  isLegalReservationTransition,
  RESERVATION_STATE_TRANSITIONS,
  windowBucket,
  windowStart,
} from "./BudgetEngine.js";
import { modelCallHolds, modelPricing } from "./CostCalculator.js";
import {
  AT,
  budgetInput,
  FIXTURE_IDS,
  hold,
  limit,
  NEXT_DAY,
  reserveRequest,
  scope,
} from "./testSupport.js";

const PRICING = modelPricing({ inputPerThousandTokens: 3_000, outputPerThousandTokens: 15_000 });

/** An engine with a fixed clock. */
function engine(
  options: { maxBudgets?: number; maxReservationsPerBudget?: number; clock?: () => string } = {},
): InMemoryBudgetEngine {
  return new InMemoryBudgetEngine({
    clock: options.clock ?? (() => AT),
    maxBudgets: options.maxBudgets,
    maxReservationsPerBudget: options.maxReservationsPerBudget,
  });
}

/** An engine holding one budget with a 1 000 000 micro total spend cap. */
function withBudget(
  eng: InMemoryBudgetEngine = engine(),
  overrides: Partial<ReturnType<typeof budgetInput>> = {},
) {
  const budget = eng.registerBudget(budgetInput(overrides));
  return { eng, budget };
}

describe("window buckets", () => {
  it("keys each window deterministically", () => {
    const scopeValue = scope(FIXTURE_IDS.executionId, "session-7");
    expect(windowBucket("execution", scopeValue, AT)).toBe(`execution:${FIXTURE_IDS.executionId}`);
    expect(windowBucket("session", scopeValue, AT)).toBe("session:session-7");
    expect(windowBucket("day", scopeValue, AT)).toBe("day:2026-03-01");
    expect(windowBucket("total", scopeValue, AT)).toBe("total");
  });

  it("makes an execution its own session when no session is named", () => {
    const execution = scope(FIXTURE_IDS.executionId, null);
    expect(windowBucket("session", execution, AT)).toBe(`session:${FIXTURE_IDS.executionId}`);
  });

  it("starts a window at midnight UTC for a day and at budget creation otherwise", () => {
    expect(windowStart("day", AT, "2026-01-01T00:00:00.000Z")).toBe("2026-03-01T00:00:00.000Z");
    expect(windowStart("total", AT, "2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("lifecycle tables", () => {
  it("agrees with itself about every budget status pair", () => {
    for (const from of Object.keys(
      BUDGET_STATUS_TRANSITIONS,
    ) as (keyof typeof BUDGET_STATUS_TRANSITIONS)[]) {
      expect(isLegalBudgetStatusTransition(from, from)).toBe(true);
      for (const to of BUDGET_STATUS_TRANSITIONS[from] ?? []) {
        expect(isLegalBudgetStatusTransition(from, to), `${from}->${to}`).toBe(true);
      }
    }
    expect(isLegalBudgetStatusTransition("closed", "active")).toBe(false);
    expect(isLegalBudgetStatusTransition("active", "active")).toBe(true);
    expect(isLegalBudgetStatusTransition("exhausted", "active")).toBe(true);
  });

  it("makes every reservation state but held terminal", () => {
    expect(RESERVATION_STATE_TRANSITIONS["held"]).toEqual(["committed", "released", "expired"]);
    for (const state of ["committed", "released", "expired"] as const) {
      expect(RESERVATION_STATE_TRANSITIONS[state]).toEqual([]);
      expect(isLegalReservationTransition(state, "held")).toBe(false);
      expect(isLegalReservationTransition(state, state)).toBe(true);
    }
    expect(isLegalReservationTransition("held", "committed")).toBe(true);
  });
});

describe("budget registration", () => {
  it("stores a frozen budget with the contract defaults", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({
        limits: [limit("cost_micro_usd", "total", 1_000_000), limit("tokens", "day", 5_000)],
      }),
    );
    expect(budget.id.startsWith("bud_")).toBe(true);
    expect(budget.version).toBe(1);
    expect(budget.status).toBe("active");
    expect(budget.description).toBe("A budget built by the fixture.");
    expect(budget.tenantId).toBeNull();
    expect(budget.policyId).toBeNull();
    expect(budget.createdAt).toBe(AT);
    expect(budget.limits).toHaveLength(2);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(Object.isFrozen(budget.limits)).toBe(true);
    expect(Object.isFrozen(budget.limits[0])).toBe(true);
    expect(Object.isFrozen(budget.metadata)).toBe(true);
    expect(eng.size).toBe(1);
  });

  it("defaults enforcement to hard, because the unsafe direction is spending", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({ limits: [{ dimension: "tokens", window: "total", limit: 10 }] }),
    );
    expect(budget.limits[0]?.enforcement).toBe("hard");
  });

  it("keeps a caller-supplied identifier", () => {
    const eng = engine();
    const budgetId = createBudgetId();
    expect(eng.registerBudget(budgetInput({ id: budgetId })).id).toBe(budgetId);
  });

  it("rejects a duplicate identifier and enforces capacity", () => {
    const eng = engine();
    const budgetId = createBudgetId();
    eng.registerBudget(budgetInput({ id: budgetId, name: "first" }));
    expect(() => eng.registerBudget(budgetInput({ id: budgetId, name: "second" }))).toThrow(
      ConflictError,
    );

    const small = engine({ maxBudgets: 1 });
    small.registerBudget(budgetInput({ name: "only" }));
    expect(() => small.registerBudget(budgetInput({ name: "second" }))).toThrow(ConflictError);
  });

  it("rejects an amount the ledger could not enforce", () => {
    const eng = engine();
    // A fractional or negative limit is rejected by the schema before the ledger sees it: the
    // engine never has to decide what "1.5 tokens" would have meant.
    expect(() =>
      eng.registerBudget(
        budgetInput({
          limits: [{ dimension: "tokens", window: "total", limit: -1, enforcement: "hard" }],
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      eng.registerBudget(
        budgetInput({
          limits: [{ dimension: "tokens", window: "total", limit: 1.5, enforcement: "hard" }],
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      eng.registerBudget(
        budgetInput({
          limits: [
            { dimension: "tokens", window: "total", limit: Number.NaN, enforcement: "hard" },
          ],
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      eng.registerBudget(
        budgetInput({
          limits: [{ dimension: "spend", window: "total", limit: 1, enforcement: "hard" }] as never,
        }),
      ),
    ).toThrow(ValidationError);
    expect(() => eng.registerBudget(budgetInput({ name: "" }))).toThrow(ValidationError);
    expect(() => eng.registerBudget(budgetInput({ createdAt: "yesterday" }))).toThrow(
      ValidationError,
    );
    expect(eng.size).toBe(0);
  });

  it("rejects an invalid capacity", () => {
    expect(() => new InMemoryBudgetEngine({ maxBudgets: 0 })).toThrow(RangeError);
    expect(() => new InMemoryBudgetEngine({ maxReservationsPerBudget: -1 })).toThrow(RangeError);
  });

  it("redacts secret-looking metadata", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({ metadata: { apiKey: "AIza" + "A".repeat(35), team: "growth" } }),
    );
    expect(String(budget.metadata["apiKey"])).not.toContain("AIza");
    expect(budget.metadata["team"]).toBe("growth");
  });
});

describe("lookup and listing", () => {
  it("finds, requires and reports absence", () => {
    const { eng, budget } = withBudget();
    expect(eng.getBudget(budget.id)).toBe(budget);
    expect(eng.requireBudget(budget.id)).toBe(budget);
    expect(eng.has(budget.id)).toBe(true);

    const missing = createBudgetId();
    expect(eng.getBudget(missing)).toBeNull();
    expect(eng.has(missing)).toBe(false);
    expect(() => eng.requireBudget(missing)).toThrow(NotFoundError);
    expect(() => eng.check(reserveRequest(missing, "k", [hold("tokens", 1)]))).toThrow(
      NotFoundError,
    );
    expect(() => eng.usage(missing, scope())).toThrow(NotFoundError);
    expect(() => eng.remaining(missing, "tokens", scope())).toThrow(NotFoundError);
  });

  it("lists by name then identifier", () => {
    const eng = engine();
    eng.registerBudget(budgetInput({ name: "zulu" }));
    eng.registerBudget(budgetInput({ name: "alpha" }));
    expect(eng.listBudgets().map((candidate) => candidate.name)).toEqual(["alpha", "zulu"]);
    expect(Object.isFrozen(eng.listBudgets())).toBe(true);
  });
});

describe("revision", () => {
  it("replaces limits and increments the version", () => {
    const { eng, budget } = withBudget();
    const revised = eng.setLimits(budget.id, [limit("tokens", "total", 100)]);
    expect(revised.version).toBe(2);
    expect(budget.version).toBe(1);
    expect(revised.limits).toHaveLength(1);
    expect(eng.requireBudget(budget.id)).toBe(revised);
  });

  it("enforces a raised limit immediately", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 10)] }));
    const request = reserveRequest(budget.id, "big", [hold("tokens", 50)]);
    expect(() => eng.reserve(request)).toThrow(ExecutionError);
    eng.setLimits(budget.id, [limit("tokens", "total", 100)]);
    expect(eng.reserve(request).state).toBe("held");
  });

  it("clamps remaining to zero when a limit is lowered below what is held", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 100)] }));
    eng.reserve(reserveRequest(budget.id, "a", [hold("tokens", 80)]));
    eng.setLimits(budget.id, [limit("tokens", "total", 50)]);
    expect(eng.remaining(budget.id, "tokens", scope())).toBe(0);
  });

  it("moves a budget through its lifecycle", () => {
    const { eng, budget } = withBudget();
    expect(eng.setStatus(budget.id, "suspended").status).toBe("suspended");
    expect(eng.setStatus(budget.id, "suspended")).toBe(eng.getBudget(budget.id));
    expect(eng.setStatus(budget.id, "active").status).toBe("active");
    expect(eng.setStatus(budget.id, "closed").status).toBe("closed");
    expect(() => eng.setStatus(budget.id, "active")).toThrow(ValidationError);
    expect(eng.requireBudget(budget.id).version).toBe(4);
  });

  it("refuses a budget that is not there", () => {
    expect(() => engine().setStatus(createBudgetId(), "closed")).toThrow(NotFoundError);
    expect(() => engine().setLimits(createBudgetId(), [])).toThrow(NotFoundError);
  });
});

describe("check", () => {
  it("allows work that fits and returns the shared allowed result", () => {
    const { eng, budget } = withBudget();
    expect(eng.check(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 100)]))).toBe(
      BUDGET_CHECK_ALLOWED,
    );
  });

  it("reports the blocking dimension, the request and the allowance", () => {
    const { eng, budget } = withBudget();
    const result = eng.check(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 1_500_000)]));
    expect(result.allowed).toBe(false);
    expect(result.blockingDimension).toBe("cost_micro_usd");
    expect(result.requested).toBe(1_500_000);
    expect(result.available).toBe(1_000_000);
    expect(result.reason).toContain("cost_micro_usd");
    expect(result.softLimitExceeded).toBe(false);
  });

  it("counts what is already held against the allowance", () => {
    const { eng, budget } = withBudget();
    eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 900_000)]));
    const result = eng.check(reserveRequest(budget.id, "b", [hold("cost_micro_usd", 200_000)]));
    expect(result.allowed).toBe(false);
    expect(result.available).toBe(100_000);
  });

  it("never refuses on a soft limit, but says it was exceeded", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({ limits: [limit("cost_micro_usd", "total", 100, "soft")] }),
    );
    const result = eng.check(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 500)]));
    expect(result.allowed).toBe(true);
    expect(result.softLimitExceeded).toBe(true);
    expect(result.blockingDimension).toBeNull();
    expect(result.reason).toContain("soft limit exceeded");
    expect(eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 500)])).state).toBe(
      "held",
    );
  });

  it("lets a hard limit win over a soft one on the same dimension", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({
        limits: [limit("tokens", "total", 1_000, "soft"), limit("tokens", "day", 10, "hard")],
      }),
    );
    const result = eng.check(reserveRequest(budget.id, "a", [hold("tokens", 500)]));
    expect(result.allowed).toBe(false);
    expect(result.blockingDimension).toBe("tokens");
    expect(result.available).toBe(10);
  });

  it("ignores dimensions the budget does not limit", () => {
    const { eng, budget } = withBudget();
    expect(eng.check(reserveRequest(budget.id, "a", [hold("tokens", 10_000_000)])).allowed).toBe(
      true,
    );
    expect(eng.remaining(budget.id, "tokens", scope())).toBeNull();
  });

  it("rejects a malformed request", () => {
    const { eng, budget } = withBudget();
    expect(() =>
      eng.check({ ...reserveRequest(budget.id, "a", [hold("tokens", 1)]), key: "" }),
    ).toThrow(ValidationError);
    expect(() => eng.check(reserveRequest(budget.id, "a", []))).toThrow(ValidationError);
    expect(() =>
      eng.check({
        ...reserveRequest(budget.id, "a", [hold("tokens", 1)]),
        holds: [{ dimension: "tokens", amount: -5 }],
      }),
    ).toThrow(ValidationError);
  });
});

describe("reserve", () => {
  it("holds the amounts and reduces the allowance", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(
      reserveRequest(
        budget.id,
        "call-1",
        modelCallHolds(PRICING, { inputTokens: 1_000, outputTokens: 500 }),
      ),
    );
    expect(reservation.id.startsWith("rsv_")).toBe(true);
    expect(reservation.state).toBe("held");
    expect(reservation.budgetId).toBe(budget.id);
    expect(reservation.executionId).toBe(FIXTURE_IDS.executionId);
    expect(reservation.key).toBe("call-1");
    expect(reservation.committed).toEqual([]);
    expect(reservation.createdAt).toBe(AT);
    expect(reservation.committedAt).toBeNull();
    expect(holdAmount(reservation.holds, "cost_micro_usd")).toBe(10_500);
    expect(Object.isFrozen(reservation)).toBe(true);
    expect(Object.isFrozen(reservation.holds)).toBe(true);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(989_500);
  });

  it("is idempotent on the key: a retry holds nothing twice", () => {
    const { eng, budget } = withBudget();
    const first = eng.reserve(
      reserveRequest(budget.id, "step-1", [hold("cost_micro_usd", 600_000)]),
    );
    const second = eng.reserve(
      reserveRequest(budget.id, "step-1", [hold("cost_micro_usd", 600_000)]),
    );
    expect(second).toBe(first);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(400_000);
    expect(eng.reservationsForBudget(budget.id)).toHaveLength(1);
  });

  it("returns the settled reservation when the key is reused after a commit", () => {
    const { eng, budget } = withBudget();
    const first = eng.reserve(reserveRequest(budget.id, "step-1", [hold("cost_micro_usd", 100)]));
    const committed = eng.commit(first.id);
    expect(eng.reserve(reserveRequest(budget.id, "step-1", [hold("cost_micro_usd", 100)]))).toBe(
      committed,
    );
  });

  it("charges a second attempt under a different key", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 100)] }));
    eng.reserve(reserveRequest(budget.id, "attempt-1", [hold("tokens", 60)]));
    // The failure that made attempt-1 necessary already spent its allowance; the retry has to
    // fit in what is left, which is the point of keying holds to attempts rather than to steps.
    expect(() => eng.reserve(reserveRequest(budget.id, "attempt-2", [hold("tokens", 60)]))).toThrow(
      ExecutionError,
    );
    expect(eng.reserve(reserveRequest(budget.id, "attempt-2", [hold("tokens", 40)])).state).toBe(
      "held",
    );
  });

  it("refuses when a hard limit would be exceeded, and holds nothing", () => {
    const { eng, budget } = withBudget();
    try {
      eng.reserve(reserveRequest(budget.id, "too-big", [hold("cost_micro_usd", 10_000_000)]));
      expect.unreachable("an oversized reservation must be refused");
    } catch (error) {
      const failure = error as ExecutionError;
      expect(failure).toBeInstanceOf(ExecutionError);
      expect(failure.code).toBe("execution_failed");
      expect(failure.retryable).toBe(false);
      expect(failure.metadata["dimension"]).toBe("cost_micro_usd");
      expect(failure.metadata["requested"]).toBe(10_000_000);
      expect(failure.metadata["available"]).toBe(1_000_000);
      expect(failure.metadata["omnis.budget.blocked"]).toBe(true);
    }
    expect(eng.reservationsForBudget(budget.id)).toEqual([]);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(1_000_000);
  });

  it("refuses a budget that cannot accept reservations", () => {
    const { eng, budget } = withBudget();
    for (const status of ["suspended", "exhausted", "closed"] as const) {
      eng.setStatus(budget.id, status);
      expect(
        () => eng.reserve(reserveRequest(budget.id, `k-${status}`, [hold("cost_micro_usd", 1)])),
        status,
      ).toThrow(ConflictError);
      eng.setStatus(budget.id, status === "closed" ? "closed" : "active");
    }
  });

  it("refuses unpriced work against a cost limit", () => {
    const { eng, budget } = withBudget();
    expect(() =>
      eng.reserve(
        reserveRequest(
          budget.id,
          "unpriced",
          modelCallHolds(null, { inputTokens: 1_000, outputTokens: 10 }),
        ),
      ),
    ).toThrow(ValidationError);
  });

  it("accepts unpriced work when the budget does not limit cost", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 100_000)] }));
    const reservation = eng.reserve(
      reserveRequest(
        budget.id,
        "local-model",
        modelCallHolds(null, { inputTokens: 1_000, outputTokens: 10 }),
      ),
    );
    expect(holdAmount(reservation.holds, "tokens")).toBe(1_010);
    expect(reservation.holds.some((entry) => entry.dimension === "cost_micro_usd")).toBe(false);
  });

  it("enforces the per-budget reservation capacity", () => {
    const eng = engine({ maxReservationsPerBudget: 2 });
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 1_000)] }));
    eng.reserve(reserveRequest(budget.id, "a", [hold("tokens", 1)]));
    eng.reserve(reserveRequest(budget.id, "b", [hold("tokens", 1)]));
    expect(() => eng.reserve(reserveRequest(budget.id, "c", [hold("tokens", 1)]))).toThrow(
      ConflictError,
    );
  });

  it("does not let two concurrent-looking reservations overspend the limit", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({ limits: [limit("cost_micro_usd", "total", 100)] }),
    );
    const results = Array.from({ length: 5 }, (_, index) => {
      try {
        eng.reserve(
          reserveRequest(budget.id, `race-${String(index)}`, [hold("cost_micro_usd", 60)]),
        );
        return "held";
      } catch {
        return "refused";
      }
    });
    // Exactly one fits. The ledger is only ever read and written between awaits, so there is
    // no interleaving in which both see 100 available.
    expect(results.filter((result) => result === "held")).toHaveLength(1);
    expect(eng.usage(budget.id, scope()).reserved).toEqual([hold("cost_micro_usd", 60)]);
  });

  it("takes identity from an execution context", () => {
    const { eng, budget } = withBudget();
    const context = createExecutionContext({ metadata: { sessionId: "session-9" } });
    const reservation = eng.reserveFromContext(context, {
      budgetId: budget.id,
      key: "from-context",
      holds: [hold("cost_micro_usd", 10)],
    });
    expect(reservation.executionId).toBe(context.executionId);
    expect(
      eng.remaining(budget.id, "cost_micro_usd", {
        executionId: context.executionId,
        sessionId: "session-9",
      }),
    ).toBe(999_990);
  });
});

describe("commit", () => {
  it("moves the hold into the committed column", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(
      reserveRequest(budget.id, "a", [hold("cost_micro_usd", 100_000)]),
    );
    const committed = eng.commit(reservation.id);
    expect(committed.state).toBe("committed");
    expect(committed.committed).toEqual([hold("cost_micro_usd", 100_000)]);
    expect(committed.committedAt).toBe(AT);
    expect(committed.releasedAt).toBeNull();
    expect(Object.isFrozen(committed)).toBe(true);

    const usage = eng.usage(budget.id, scope());
    expect(usage.committed).toEqual([hold("cost_micro_usd", 100_000)]);
    expect(usage.reserved).toEqual([]);
    // Committing exactly what was held changes nothing about the allowance.
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(900_000);
  });

  it("charges what was actually consumed", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 1_000)] }));
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("tokens", 800)]));
    const committed = eng.commit(reservation.id, [hold("tokens", 300)]);
    expect(committed.committed).toEqual([hold("tokens", 300)]);
    expect(eng.remaining(budget.id, "tokens", scope())).toBe(700);
  });

  it("exhausts the budget when a commit passes a hard limit", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "total", 100)] }));
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("tokens", 100)]));
    // The provider used more than the estimate. The work already happened, so the ledger
    // records the truth and the budget stops accepting new work.
    eng.commit(reservation.id, [hold("tokens", 250)]);
    expect(eng.requireBudget(budget.id).status).toBe("exhausted");
    expect(eng.remaining(budget.id, "tokens", scope())).toBe(0);
    expect(() => eng.reserve(reserveRequest(budget.id, "b", [hold("tokens", 1)]))).toThrow(
      ConflictError,
    );
  });

  it("does not exhaust the budget on a soft limit", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({ limits: [limit("tokens", "total", 100, "soft")] }),
    );
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("tokens", 100)]));
    eng.commit(reservation.id, [hold("tokens", 500)]);
    expect(eng.requireBudget(budget.id).status).toBe("active");
  });

  it("refuses to settle a reservation twice", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 10)]));
    const committed = eng.commit(reservation.id);
    // Committing twice would charge twice, so it is refused outright.
    expect(() => eng.commit(reservation.id)).toThrow(ValidationError);
    expect(() => eng.commit(reservation.id, [hold("cost_micro_usd", 1)])).toThrow(ValidationError);
    // Releasing a committed reservation is a no-op: the hold is already gone, and there is
    // nothing to give back.
    expect(eng.release(reservation.id)).toBe(committed);
    expect(eng.expire(reservation.id)).toBe(committed);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(999_990);
  });

  it("refuses an unknown reservation and an invalid charge", () => {
    const { eng } = withBudget();
    expect(() => eng.commit("rsv_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never)).toThrow(NotFoundError);
    const { budget } = withBudget(eng);
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 10)]));
    expect(() => eng.commit(reservation.id, [{ dimension: "cost_micro_usd", amount: -1 }])).toThrow(
      RangeError,
    );
    expect(() =>
      eng.commit(reservation.id, [{ dimension: "cost_micro_usd", amount: 1.5 }]),
    ).toThrow(RangeError);
    expect(() =>
      eng.commit(reservation.id, [{ dimension: "cost_micro_usd", amount: Number.NaN }]),
    ).toThrow(RangeError);
  });
});

describe("release and expiry", () => {
  it("gives the hold back", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(
      reserveRequest(budget.id, "a", [hold("cost_micro_usd", 400_000)]),
    );
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(600_000);
    const released = eng.release(reservation.id);
    expect(released.state).toBe("released");
    expect(released.releasedAt).toBe(AT);
    expect(released.committed).toEqual([]);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(1_000_000);
    expect(eng.usage(budget.id, scope()).reserved).toEqual([]);
  });

  it("is idempotent, because cancellation paths release twice by design", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 100)]));
    const first = eng.release(reservation.id);
    expect(eng.release(reservation.id)).toBe(first);
    expect(eng.expire(reservation.id)).toBe(first);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(1_000_000);
  });

  it("expires a hold whose work will never happen", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 100)]));
    const expired = eng.expire(reservation.id);
    expect(expired.state).toBe("expired");
    expect(expired.releasedAt).toBe(AT);
    expect(eng.remaining(budget.id, "cost_micro_usd", scope())).toBe(1_000_000);
  });

  it("releases everything an execution held, across budgets", () => {
    const eng = engine();
    const first = eng.registerBudget(
      budgetInput({ name: "first", limits: [limit("tokens", "total", 1_000)] }),
    );
    const second = eng.registerBudget(
      budgetInput({ name: "second", limits: [limit("tokens", "total", 1_000)] }),
    );
    const executionId = createExecutionId();
    eng.reserve(reserveRequest(first.id, "a", [hold("tokens", 100)], { executionId }));
    eng.reserve(reserveRequest(second.id, "b", [hold("tokens", 200)], { executionId }));
    const settled = eng.reserve(
      reserveRequest(first.id, "c", [hold("tokens", 50)], { executionId }),
    );
    eng.commit(settled.id);

    expect(eng.releaseAllForExecution(executionId)).toBe(2);
    expect(eng.remaining(first.id, "tokens", scope(executionId))).toBe(950);
    expect(eng.remaining(second.id, "tokens", scope(executionId))).toBe(1_000);
    expect(eng.releaseAllForExecution(executionId)).toBe(0);
  });
});

describe("ledger windows", () => {
  it("charges execution, session, day and total limits from one reservation", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({
        limits: [
          limit("tokens", "execution", 500),
          limit("tokens", "session", 1_000),
          limit("tokens", "day", 2_000),
          limit("tokens", "total", 10_000),
        ],
      }),
    );
    const executionId = createExecutionId();
    eng.reserve(
      reserveRequest(budget.id, "a", [hold("tokens", 400)], {
        executionId,
        sessionId: "session-1",
      }),
    );
    const reservationScope = scope(executionId, "session-1");
    expect(eng.remaining(budget.id, "tokens", reservationScope, "execution")).toBe(100);
    expect(eng.remaining(budget.id, "tokens", reservationScope, "session")).toBe(600);
    expect(eng.remaining(budget.id, "tokens", reservationScope, "day")).toBe(1_600);
    expect(eng.remaining(budget.id, "tokens", reservationScope, "total")).toBe(9_600);
  });

  it("enforces the tightest window", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({
        limits: [limit("tokens", "execution", 100), limit("tokens", "total", 10_000)],
      }),
    );
    const executionId = createExecutionId();
    eng.reserve(reserveRequest(budget.id, "a", [hold("tokens", 100)], { executionId }));
    // A second execution under the same total budget still has room; this one does not.
    expect(() =>
      eng.reserve(reserveRequest(budget.id, "b", [hold("tokens", 1)], { executionId })),
    ).toThrow(ExecutionError);
    expect(
      eng.reserve(
        reserveRequest(budget.id, "c", [hold("tokens", 100)], { executionId: createExecutionId() }),
      ).state,
    ).toBe("held");
  });

  it("separates sessions charged by the same execution", () => {
    const eng = engine();
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "session", 100)] }));
    const executionId = createExecutionId();
    eng.reserve(
      reserveRequest(budget.id, "a", [hold("tokens", 100)], { executionId, sessionId: "s1" }),
    );
    expect(() =>
      eng.reserve(
        reserveRequest(budget.id, "b", [hold("tokens", 1)], { executionId, sessionId: "s1" }),
      ),
    ).toThrow(ExecutionError);
    expect(
      eng.reserve(
        reserveRequest(budget.id, "c", [hold("tokens", 100)], { executionId, sessionId: "s2" }),
      ).state,
    ).toBe("held");
  });

  it("rolls the day window over at midnight UTC", () => {
    let now = AT;
    const eng = new InMemoryBudgetEngine({ clock: () => now });
    const budget = eng.registerBudget(budgetInput({ limits: [limit("tokens", "day", 100)] }));
    eng.reserve(reserveRequest(budget.id, "monday", [hold("tokens", 100)]));
    // The day's allowance is spent, so one more token is refused until the window rolls over.
    expect(() => eng.reserve(reserveRequest(budget.id, "monday-2", [hold("tokens", 1)]))).toThrow(
      ExecutionError,
    );
    now = NEXT_DAY;
    expect(eng.remaining(budget.id, "tokens", scope(), "day")).toBe(100);
    expect(eng.reserve(reserveRequest(budget.id, "tuesday", [hold("tokens", 100)])).state).toBe(
      "held",
    );
    expect(eng.usage(budget.id, scope(), "day").windowStartedAt).toBe("2026-03-02T00:00:00.000Z");
  });

  it("reports a snapshot with both columns and the observation instant", () => {
    const { eng, budget } = withBudget();
    const held = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 100)]));
    eng.reserve(reserveRequest(budget.id, "b", [hold("cost_micro_usd", 50)]));
    eng.commit(held.id);
    const usage = eng.usage(budget.id, scope());
    expect(usage).toEqual({
      budgetId: budget.id,
      committed: [hold("cost_micro_usd", 100)],
      reserved: [hold("cost_micro_usd", 50)],
      window: "total",
      windowStartedAt: AT,
      observedAt: AT,
    });
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it("orders dimensions canonically in a snapshot", () => {
    const eng = engine();
    const budget = eng.registerBudget(
      budgetInput({
        limits: [
          limit("tokens", "total", 1_000),
          limit("cost_micro_usd", "total", 1_000),
          limit("requests", "total", 10),
        ],
      }),
    );
    eng.reserve(
      reserveRequest(budget.id, "a", [
        hold("requests", 1),
        hold("cost_micro_usd", 10),
        hold("tokens", 100),
      ]),
    );
    expect(eng.usage(budget.id, scope()).reserved.map((entry) => entry.dimension)).toEqual([
      "tokens",
      "requests",
      "cost_micro_usd",
    ]);
  });

  it("tracks only the dimensions the budget limits", () => {
    const { eng, budget } = withBudget();
    eng.reserve(
      reserveRequest(budget.id, "a", [hold("cost_micro_usd", 10), hold("tokens", 5_000)]),
    );
    expect(eng.usage(budget.id, scope()).reserved).toEqual([hold("cost_micro_usd", 10)]);
  });
});

describe("reservation queries", () => {
  it("finds a reservation by identifier alone", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 10)]));
    expect(eng.getReservation(reservation.id)).toBe(reservation);
    expect(eng.requireReservation(reservation.id)).toBe(reservation);
    expect(eng.getReservation("rsv_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never)).toBeNull();
    expect(() => eng.requireReservation("rsv_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never)).toThrow(
      NotFoundError,
    );
  });

  it("lists reservations for a budget and for an execution, in a stable order", () => {
    const eng = engine();
    const first = eng.registerBudget(
      budgetInput({ name: "first", limits: [limit("tokens", "total", 1_000)] }),
    );
    const second = eng.registerBudget(
      budgetInput({ name: "second", limits: [limit("tokens", "total", 1_000)] }),
    );
    const executionId = createExecutionId();
    eng.reserve(reserveRequest(first.id, "a", [hold("tokens", 1)], { executionId }));
    eng.reserve(reserveRequest(second.id, "b", [hold("tokens", 1)], { executionId }));
    eng.reserve(
      reserveRequest(first.id, "c", [hold("tokens", 1)], { executionId: createExecutionId() }),
    );

    expect(eng.reservationsForBudget(first.id).map((reservation) => reservation.key)).toEqual([
      "a",
      "c",
    ]);
    expect(eng.reservationsForExecution(executionId).map((reservation) => reservation.key)).toEqual(
      ["a", "b"],
    );
    expect(Object.isFrozen(eng.reservationsForBudget(first.id))).toBe(true);
  });
});

describe("removal", () => {
  it("refuses while work is still held", () => {
    const { eng, budget } = withBudget();
    eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 10)]));
    expect(() => eng.removeBudget(budget.id)).toThrow(ConflictError);
    expect(eng.has(budget.id)).toBe(true);
  });

  it("removes a settled budget and forgets its reservations", () => {
    const { eng, budget } = withBudget();
    const reservation = eng.reserve(reserveRequest(budget.id, "a", [hold("cost_micro_usd", 10)]));
    eng.commit(reservation.id);
    expect(eng.removeBudget(budget.id)).toBe(true);
    expect(eng.removeBudget(budget.id)).toBe(false);
    expect(eng.has(budget.id)).toBe(false);
    expect(eng.getReservation(reservation.id)).toBeNull();
  });
});

describe("determinism", () => {
  it("produces the same ledger for the same sequence of operations", () => {
    const run = () => {
      const eng = engine();
      const budget = eng.registerBudget(
        budgetInput({
          id: FIXTURE_IDS.budgetId,
          limits: [limit("tokens", "total", 1_000), limit("cost_micro_usd", "total", 100_000)],
        }),
      );
      eng.reserve(
        reserveRequest(budget.id, "a", [hold("tokens", 100), hold("cost_micro_usd", 1_000)]),
      );
      const second = eng.reserve(
        reserveRequest(budget.id, "b", [hold("tokens", 200), hold("cost_micro_usd", 2_000)]),
      );
      eng.commit(second.id, [hold("tokens", 150), hold("cost_micro_usd", 1_500)]);
      return JSON.stringify(eng.usage(budget.id, scope()));
    };
    expect(run()).toBe(run());
  });
});
