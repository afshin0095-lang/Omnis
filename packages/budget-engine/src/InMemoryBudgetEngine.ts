/**
 * The in-memory budget engine.
 *
 * The ledger is a set of integer counters, one per (budget, window bucket, dimension), split
 * into `reserved` and `committed`. Splitting them is what makes a hold meaningful: a
 * reservation reduces the allowance available to everyone else immediately, and a commit moves
 * the amount from one column to the other instead of adding it twice.
 *
 * Every mutation replaces an immutable record rather than editing it, so a reservation handed
 * to a caller cannot change underneath them, and a snapshot quoted in an event stays true.
 */

import { createBudgetId, createReservationId, nowIso } from "@omnis/types";
import { validate } from "@omnis/validation";
import { sanitizeMetadata } from "@omnis/execution-context";
import type { ExecutionContext } from "@omnis/execution-context";
import {
  assertBudgetShape,
  budgetHold,
  BUDGET_CHECK_ALLOWED,
  BUDGET_DIMENSIONS,
  holdAmount,
  isReservableBudgetStatus,
  sumHolds,
} from "@omnis/ai-core-types";
import type {
  Budget,
  BudgetCheckResult,
  BudgetDimension,
  BudgetHold,
  BudgetId,
  BudgetReservation,
  BudgetStatus,
  BudgetUsage,
  BudgetWindow,
  ExecutionId,
  ReservationId,
} from "@omnis/ai-core-types";
import { assertPricedForBudget } from "./CostCalculator.js";
import {
  isLegalBudgetStatusTransition,
  windowBucket,
  windowStart,
  type BudgetEngine,
  type BudgetEngineOptions,
  type ReservationScope,
} from "./BudgetEngine.js";
import type { BudgetInput, BudgetLimitInput, ReserveRequest } from "./budgetValidation.js";
import { budgetInputSchema, budgetSchema, reserveRequestSchema } from "./budgetValidation.js";
import {
  budgetCapacityExceeded,
  budgetExhaustedError,
  budgetHasActiveReservations,
  budgetNotFound,
  budgetNotReservable,
  duplicateBudget,
  invalidBudgetStatusTransition,
  invalidReservationRequest,
  invalidReservationState,
  reservationCapacityExceeded,
  reservationNotFound,
} from "./errors.js";

/** Default capacity. */
const DEFAULT_MAX_BUDGETS = 64;

/** Default number of reservations one budget may hold at once. */
const DEFAULT_MAX_RESERVATIONS = 1_024;

/** Integer counters for one window bucket. */
interface LedgerEntry {
  committed: number;
  reserved: number;
}

/** One budget, its ledger, and its reservations. */
interface BudgetRecord {
  budget: Budget;
  /** bucket key -> dimension -> counters. */
  readonly ledger: Map<string, Map<BudgetDimension, LedgerEntry>>;
  readonly reservations: Map<ReservationId, BudgetReservation>;
  /** Idempotency key -> reservation. */
  readonly byKey: Map<string, ReservationId>;
  /** Which buckets each reservation charges, needed to settle or release it. */
  readonly scopes: Map<ReservationId, ReservationScope>;
}

/** Normalizes limits supplied by a caller: enforcement defaults to hard. */
function normalizeLimits(limits: readonly BudgetLimitInput[]): readonly Budget["limits"][number][] {
  return limits.map((limit) =>
    Object.freeze({ ...limit, enforcement: limit.enforcement ?? "hard" }),
  );
}

/** The in-memory implementation of {@link BudgetEngine}. */
export class InMemoryBudgetEngine implements BudgetEngine {
  private readonly records = new Map<BudgetId, BudgetRecord>();
  /** Which budget holds a reservation, so a commit does not have to name one. */
  private readonly reservationIndex = new Map<ReservationId, BudgetId>();
  private readonly clock: () => string;
  private readonly maxBudgets: number;
  private readonly maxReservationsPerBudget: number;

  constructor(options: BudgetEngineOptions = {}) {
    this.clock = options.clock ?? nowIso;
    this.maxBudgets = options.maxBudgets ?? DEFAULT_MAX_BUDGETS;
    this.maxReservationsPerBudget = options.maxReservationsPerBudget ?? DEFAULT_MAX_RESERVATIONS;
    for (const [label, value] of [
      ["budget capacity", this.maxBudgets],
      ["reservation capacity", this.maxReservationsPerBudget],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive integer, received ${String(value)}`);
      }
    }
  }

  get size(): number {
    return this.records.size;
  }

  registerBudget(input: BudgetInput): Budget {
    const parsed = validate(budgetInputSchema, input, "Budget");
    const budgetId = parsed.id ?? createBudgetId();
    if (this.records.size >= this.maxBudgets) {
      throw budgetCapacityExceeded(this.maxBudgets);
    }
    if (this.records.has(budgetId)) {
      throw duplicateBudget(budgetId, parsed.name);
    }
    const budget = this.freezeBudget({
      id: budgetId,
      name: parsed.name,
      description: parsed.description ?? "",
      status: parsed.status ?? "active",
      limits: normalizeLimits(parsed.limits),
      tenantId: parsed.tenantId ?? null,
      policyId: parsed.policyId ?? null,
      metadata: sanitizeMetadata(parsed.metadata ?? {}),
      createdAt: parsed.createdAt ?? this.clock(),
      version: 1,
    });
    this.records.set(budgetId, {
      budget,
      ledger: new Map(),
      reservations: new Map(),
      byKey: new Map(),
      scopes: new Map(),
    });
    return budget;
  }

  setLimits(budgetId: BudgetId, limits: readonly BudgetLimitInput[]): Budget {
    return this.revise(budgetId, (current) => ({ ...current, limits: normalizeLimits(limits) }));
  }

  setStatus(budgetId: BudgetId, status: BudgetStatus): Budget {
    const current = this.requireBudget(budgetId);
    if (!isLegalBudgetStatusTransition(current.status, status)) {
      throw invalidBudgetStatusTransition(budgetId, current.status, status);
    }
    if (current.status === status) {
      return current;
    }
    return this.revise(budgetId, (budget) => ({ ...budget, status }));
  }

  getBudget(budgetId: BudgetId): Budget | null {
    return this.records.get(budgetId)?.budget ?? null;
  }

  requireBudget(budgetId: BudgetId): Budget {
    const record = this.records.get(budgetId);
    if (record === undefined) {
      throw budgetNotFound(budgetId);
    }
    return record.budget;
  }

  has(budgetId: BudgetId): boolean {
    return this.records.has(budgetId);
  }

  removeBudget(budgetId: BudgetId): boolean {
    const record = this.records.get(budgetId);
    if (record === undefined) {
      return false;
    }
    const active = [...record.reservations.values()].filter(
      (reservation) => reservation.state === "held",
    );
    if (active.length > 0) {
      // Removing a budget that is holding work would erase the record of what was authorized
      // and leave the work running against nothing.
      throw budgetHasActiveReservations(budgetId, active.length);
    }
    for (const reservationId of record.reservations.keys()) {
      this.reservationIndex.delete(reservationId);
    }
    this.records.delete(budgetId);
    return true;
  }

  listBudgets(): readonly Budget[] {
    return Object.freeze(
      [...this.records.values()]
        .map((record) => record.budget)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        ),
    );
  }

  check(request: ReserveRequest): BudgetCheckResult {
    const parsed = validate(reserveRequestSchema, request, "ReserveRequest");
    const record = this.requireRecord(parsed.budgetId);
    const holds = sumHolds(parsed.holds.map((hold) => budgetHold(hold.dimension, hold.amount)));
    const scope: ReservationScope = {
      executionId: parsed.executionId,
      sessionId: parsed.sessionId ?? null,
    };
    const observedAt = this.clock();
    return this.checkHolds(record, holds, scope, observedAt);
  }

  reserve(request: ReserveRequest): BudgetReservation {
    const parsed = validate(reserveRequestSchema, request, "ReserveRequest");
    const record = this.requireRecord(parsed.budgetId);
    const budget = record.budget;
    if (!isReservableBudgetStatus(budget.status)) {
      throw budgetNotReservable(budget);
    }

    // Idempotency first: a retry of a step that already reserved must not hold twice, and it
    // must not be refused because the first hold consumed the allowance it is asking for again.
    const existingId = record.byKey.get(parsed.key);
    if (existingId !== undefined) {
      const existing = record.reservations.get(existingId);
      if (existing !== undefined) {
        return existing;
      }
    }

    const holds = sumHolds(parsed.holds.map((hold) => budgetHold(hold.dimension, hold.amount)));
    assertPricedForBudget(budget, holds);

    const observedAt = this.clock();
    const scope: ReservationScope = {
      executionId: parsed.executionId,
      sessionId: parsed.sessionId ?? null,
    };
    const check = this.checkHolds(record, holds, scope, observedAt);
    if (!check.allowed) {
      throw budgetExhaustedError(
        budget.id,
        check.blockingDimension ?? "cost_micro_usd",
        check.requested,
        check.available,
      );
    }

    const activeCount = [...record.reservations.values()].filter(
      (reservation) => reservation.state === "held",
    ).length;
    if (activeCount >= this.maxReservationsPerBudget) {
      throw reservationCapacityExceeded(budget.id, this.maxReservationsPerBudget);
    }

    const reservationId = createReservationId();
    const reservation = this.freezeReservation({
      id: reservationId,
      budgetId: budget.id,
      executionId: parsed.executionId,
      key: parsed.key,
      holds,
      state: "held",
      committed: [],
      createdAt: observedAt,
      committedAt: null,
      releasedAt: null,
    });

    record.reservations.set(reservationId, reservation);
    record.byKey.set(parsed.key, reservationId);
    record.scopes.set(reservationId, scope);
    this.reservationIndex.set(reservationId, budget.id);
    this.applyHolds(record, scope, holds, "reserved", observedAt, +1);
    return reservation;
  }

  reserveFromContext(
    context: ExecutionContext,
    request: Omit<ReserveRequest, "executionId" | "sessionId"> & {
      readonly sessionId?: string | null;
    },
  ): BudgetReservation {
    // Identity comes from the context and cannot be overridden: a step must not be able to
    // charge its spend to a different execution's allowance.
    const sessionId = request.sessionId ?? readSessionId(context);
    return this.reserve({ ...request, executionId: context.executionId, sessionId });
  }

  commit(reservationId: ReservationId, actual?: readonly BudgetHold[]): BudgetReservation {
    const { record, reservation } = this.requireReservationRecord(reservationId);
    if (reservation.state !== "held") {
      throw invalidReservationState(reservationId, reservation.state, "committed");
    }
    const scope = this.scopeOf(record, reservationId);
    const observedAt = this.clock();
    const charged = sumHolds(actual ?? reservation.holds);

    // The hold comes off first, then the charge goes on: an execution that commits exactly
    // what it held must see no change in its allowance.
    this.applyHolds(record, scope, reservation.holds, "reserved", observedAt, -1);
    this.applyHolds(record, scope, charged, "committed", observedAt, +1);

    const committed = this.freezeReservation({
      ...reservation,
      state: "committed",
      committed: charged,
      committedAt: observedAt,
    });
    record.reservations.set(reservationId, committed);
    this.markExhaustedIfOverLimit(record, scope, observedAt);
    return committed;
  }

  release(reservationId: ReservationId): BudgetReservation {
    return this.settle(reservationId, "released");
  }

  expire(reservationId: ReservationId): BudgetReservation {
    return this.settle(reservationId, "expired");
  }

  releaseAllForExecution(executionId: ExecutionId): number {
    let released = 0;
    for (const record of this.records.values()) {
      for (const reservation of [...record.reservations.values()]) {
        if (reservation.executionId === executionId && reservation.state === "held") {
          this.settle(reservation.id, "released");
          released += 1;
        }
      }
    }
    return released;
  }

  getReservation(reservationId: ReservationId): BudgetReservation | null {
    const budgetId = this.reservationIndex.get(reservationId);
    if (budgetId === undefined) {
      return null;
    }
    return this.records.get(budgetId)?.reservations.get(reservationId) ?? null;
  }

  requireReservation(reservationId: ReservationId): BudgetReservation {
    return this.requireReservationRecord(reservationId).reservation;
  }

  reservationsForBudget(budgetId: BudgetId): readonly BudgetReservation[] {
    const record = this.requireRecord(budgetId);
    return this.sortedReservations([...record.reservations.values()]);
  }

  reservationsForExecution(executionId: ExecutionId): readonly BudgetReservation[] {
    const matching: BudgetReservation[] = [];
    for (const record of this.records.values()) {
      for (const reservation of record.reservations.values()) {
        if (reservation.executionId === executionId) {
          matching.push(reservation);
        }
      }
    }
    return this.sortedReservations(matching);
  }

  usage(budgetId: BudgetId, scope: ReservationScope, window: BudgetWindow = "total"): BudgetUsage {
    const record = this.requireRecord(budgetId);
    const observedAt = this.clock();
    const bucket = windowBucket(window, scope, observedAt);
    const entries = record.ledger.get(bucket);
    const committed: BudgetHold[] = [];
    const reserved: BudgetHold[] = [];
    for (const dimension of BUDGET_DIMENSIONS) {
      const entry = entries?.get(dimension);
      if (entry === undefined) {
        continue;
      }
      if (entry.committed > 0) {
        committed.push(budgetHold(dimension, entry.committed));
      }
      if (entry.reserved > 0) {
        reserved.push(budgetHold(dimension, entry.reserved));
      }
    }
    return Object.freeze({
      budgetId,
      committed: Object.freeze(sumHolds(committed)),
      reserved: Object.freeze(sumHolds(reserved)),
      window,
      windowStartedAt: windowStart(window, observedAt, record.budget.createdAt),
      observedAt,
    });
  }

  remaining(
    budgetId: BudgetId,
    dimension: BudgetDimension,
    scope: ReservationScope,
    window: BudgetWindow = "total",
  ): number | null {
    const record = this.requireRecord(budgetId);
    const limit = this.limitFor(record.budget, dimension, window);
    if (limit === null) {
      return null;
    }
    const observedAt = this.clock();
    const entry = record.ledger.get(windowBucket(window, scope, observedAt))?.get(dimension);
    const consumed = (entry?.committed ?? 0) + (entry?.reserved ?? 0);
    return Math.max(0, limit.limit - consumed);
  }

  /**
   * Runs every limit that applies to these holds and reports the first hard refusal.
   *
   * Dimensions are visited in {@link BUDGET_DIMENSIONS} order and limits in declaration order,
   * so two identical requests always fail for the same stated reason. A soft limit never
   * refuses; it is reported so telemetry can flag the overrun.
   */
  private checkHolds(
    record: BudgetRecord,
    holds: readonly BudgetHold[],
    scope: ReservationScope,
    observedAt: string,
  ): BudgetCheckResult {
    let soft: BudgetCheckResult | null = null;
    for (const dimension of BUDGET_DIMENSIONS) {
      const requested = holdAmount(holds, dimension);
      for (const limit of record.budget.limits) {
        if (limit.dimension !== dimension) {
          continue;
        }
        const entry = record.ledger
          .get(windowBucket(limit.window, scope, observedAt))
          ?.get(dimension);
        const consumed = (entry?.committed ?? 0) + (entry?.reserved ?? 0);
        const available = Math.max(0, limit.limit - consumed);
        if (requested <= available) {
          continue;
        }
        const reason = `${dimension} would reach ${String(consumed + requested)} of ${String(limit.limit)} in the ${limit.window} window`;
        if (limit.enforcement === "hard") {
          return Object.freeze({
            allowed: false,
            blockingDimension: dimension,
            requested,
            available,
            reason,
            softLimitExceeded: false,
          });
        }
        soft ??= Object.freeze({
          allowed: true,
          blockingDimension: null,
          requested,
          available,
          reason: `soft limit exceeded: ${reason}`,
          softLimitExceeded: true,
        });
      }
    }
    return soft ?? BUDGET_CHECK_ALLOWED;
  }

  /** The most restrictive limit a budget declares for a dimension and window. */
  private limitFor(budget: Budget, dimension: BudgetDimension, window: BudgetWindow) {
    let found: Budget["limits"][number] | null = null;
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

  /** Adds to or subtracts from the ledger counters a set of holds charges. */
  private applyHolds(
    record: BudgetRecord,
    scope: ReservationScope,
    holds: readonly BudgetHold[],
    column: "committed" | "reserved",
    observedAt: string,
    sign: 1 | -1,
  ): void {
    for (const limit of record.budget.limits) {
      // Only dimensions the budget actually limits are counted. Tracking the rest would grow
      // the ledger without ever being read.
      const amount = holdAmount(holds, limit.dimension);
      if (amount === 0) {
        continue;
      }
      const bucket = windowBucket(limit.window, scope, observedAt);
      let entries = record.ledger.get(bucket);
      if (entries === undefined) {
        entries = new Map();
        record.ledger.set(bucket, entries);
      }
      const entry = entries.get(limit.dimension) ?? { committed: 0, reserved: 0 };
      const next = entry[column] + sign * amount;
      // A negative counter would mean the ledger lost track of a hold; clamping hides that, so
      // it is surfaced instead.
      if (next < 0) {
        throw invalidReservationRequest(
          `ledger underflow on ${limit.dimension} in ${bucket}: ${String(entry[column])} ${column} minus ${String(amount)}`,
          scope.executionId,
        );
      }
      entry[column] = next;
      entries.set(limit.dimension, entry);
    }
  }

  /** Moves a budget to `exhausted` when a committed charge has passed a hard limit. */
  private markExhaustedIfOverLimit(
    record: BudgetRecord,
    scope: ReservationScope,
    observedAt: string,
  ): void {
    if (record.budget.status !== "active") {
      return;
    }
    for (const limit of record.budget.limits) {
      if (limit.enforcement !== "hard") {
        continue;
      }
      const entry = record.ledger
        .get(windowBucket(limit.window, scope, observedAt))
        ?.get(limit.dimension);
      const consumed = (entry?.committed ?? 0) + (entry?.reserved ?? 0);
      if (consumed > limit.limit) {
        record.budget = this.freezeBudget({
          ...record.budget,
          status: "exhausted",
          version: record.budget.version + 1,
        });
        return;
      }
    }
  }

  /** Gives a hold back, moving the reservation to a terminal state. */
  private settle(reservationId: ReservationId, to: "released" | "expired"): BudgetReservation {
    const { record, reservation } = this.requireReservationRecord(reservationId);
    if (reservation.state !== "held") {
      // Already settled. Release and expiry have the same economic effect — the hold is gone —
      // so asking for either after the fact is a no-op rather than an error. Cancellation paths
      // call both by design, and a second call must not free the same hold twice. Committing is
      // different: it charges, so it refuses anything that is not held.
      return reservation;
    }
    const scope = this.scopeOf(record, reservationId);
    const observedAt = this.clock();
    this.applyHolds(record, scope, reservation.holds, "reserved", observedAt, -1);
    const settled = this.freezeReservation({ ...reservation, state: to, releasedAt: observedAt });
    record.reservations.set(reservationId, settled);
    return settled;
  }

  /** Applies a revision, validates the result and stores it as the next version. */
  private revise(budgetId: BudgetId, patch: (current: Budget) => Budget): Budget {
    const record = this.requireRecord(budgetId);
    const revised = this.freezeBudget({
      ...patch(record.budget),
      id: budgetId,
      version: record.budget.version + 1,
    });
    validate(budgetSchema, revised, "Budget");
    record.budget = revised;
    return revised;
  }

  private requireRecord(budgetId: BudgetId): BudgetRecord {
    const record = this.records.get(budgetId);
    if (record === undefined) {
      throw budgetNotFound(budgetId);
    }
    return record;
  }

  private requireReservationRecord(reservationId: ReservationId): {
    record: BudgetRecord;
    reservation: BudgetReservation;
  } {
    const budgetId = this.reservationIndex.get(reservationId);
    const record = budgetId === undefined ? undefined : this.records.get(budgetId);
    const reservation = record?.reservations.get(reservationId);
    if (record === undefined || reservation === undefined) {
      throw reservationNotFound(reservationId);
    }
    return { record, reservation };
  }

  private scopeOf(record: BudgetRecord, reservationId: ReservationId): ReservationScope {
    const scope = record.scopes.get(reservationId);
    if (scope === undefined) {
      throw invalidReservationRequest("reservation has no recorded scope", null);
    }
    return scope;
  }

  /** Deterministic order for any list of reservations. */
  private sortedReservations(
    reservations: readonly BudgetReservation[],
  ): readonly BudgetReservation[] {
    return Object.freeze(
      [...reservations].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    );
  }

  private freezeBudget(budget: Budget): Budget {
    assertBudgetShape(budget);
    Object.freeze(budget.limits);
    for (const limit of budget.limits) {
      Object.freeze(limit);
    }
    Object.freeze(budget.metadata);
    return Object.freeze(budget);
  }

  private freezeReservation(reservation: BudgetReservation): BudgetReservation {
    Object.freeze(reservation.holds);
    for (const hold of reservation.holds) {
      Object.freeze(hold);
    }
    Object.freeze(reservation.committed);
    for (const hold of reservation.committed) {
      Object.freeze(hold);
    }
    return Object.freeze(reservation);
  }
}

/** Reads a session identifier from a context's metadata, when one was recorded. */
function readSessionId(context: ExecutionContext): string | null {
  const sessionId = context.metadata["sessionId"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

/** Creates an in-memory budget engine. */
export function createBudgetEngine(options: BudgetEngineOptions = {}): BudgetEngine {
  return new InMemoryBudgetEngine(options);
}
