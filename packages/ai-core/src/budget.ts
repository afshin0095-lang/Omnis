import type { BudgetLimit } from "./types.js";

interface Reservation { id: string; limit: BudgetLimit; amount: number; state: "reserved"|"settled"|"released"; }

export class BudgetEngine {
  private readonly reservations = new Map<string, Reservation>();

  reserve(id: string, limit: BudgetLimit): void {
    if (this.reservations.has(id)) throw new Error("BUDGET_RESERVATION_EXISTS");
    if (limit.maxAmount < 0) throw new Error("INVALID_BUDGET");
    this.reservations.set(id, { id, limit, amount: 0, state: "reserved" });
  }

  settle(id: string, actualAmount: number): void {
    const r = this.require(id);
    if (r.state !== "reserved") throw new Error("BUDGET_NOT_SETTLEABLE");
    if (actualAmount > r.limit.maxAmount) throw new Error("BUDGET_EXCEEDED");
    r.amount = actualAmount; r.state = "settled";
  }

  release(id: string): void {
    const r = this.require(id);
    if (r.state !== "reserved") throw new Error("BUDGET_NOT_RELEASEABLE");
    r.state = "released";
  }

  get(id: string): Reservation { return { ...this.require(id) }; }

  private require(id: string): Reservation {
    const r = this.reservations.get(id);
    if (!r) throw new Error("BUDGET_RESERVATION_NOT_FOUND");
    return r;
  }
}
